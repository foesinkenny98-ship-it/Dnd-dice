/*
 * app.js — UI + multiplayer (WebRTC lewat PeerJS).
 *
 * Arsitektur: topologi bintang. GM (host) membuat Peer dengan ID "dnd-dice-roller-KODE".
 * Pemain lain membuka koneksi ke ID itu. Semua lemparan dikirim ke GM, lalu GM
 * menyiarkannya ke semua pemain. Lemparan "rahasia" hanya dikirim balik ke pelempar
 * (dan GM selalu melihat semuanya).
 */
(() => {
  'use strict';

  const PREFIX = 'dnd-dice-roller-';
  const MAX_PLAYERS = 10;
  const MAX_LOG = 150;
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const COLORS = ['#e5484d', '#f5a524', '#e9d758', '#46a758', '#12a594', '#3e8fd9', '#8e4ec6', '#e93d82'];
  const PRESET_LABELS = ['Serangan', 'Damage', 'Inisiatif', 'Save', 'Skill', 'Penyembuhan'];
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' }
    ]
  };

  const $ = s => document.querySelector(s);
  const reducedMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const store = {
    get(k) { try { return localStorage.getItem('dnd.' + k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem('dnd.' + k, v); } catch { /* abaikan */ } }
  };

  // ---------------------------------------------------------------- state
  const S = {
    name: '',
    color: COLORS[0],
    mode: null,            // 'solo' | 'host' | 'client'
    code: '',
    peer: null,
    conns: new Map(),      // host: peerId -> DataConnection
    hostConn: null,        // client
    myId: null,
    players: [],           // [{ id, name, color, gm }]
    log: [],
    adv: '',               // '' | 'adv' | 'dis'
    connected: false,
    animTimer: null,
    toastTimer: null,
    busy: false
  };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const genCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
  const safeColor = c => (/^#[0-9a-f]{6}$/i.test(c) ? c : COLORS[0]);
  const cleanName = s => Dice.cleanStr(s, 20);

  // ---------------------------------------------------------------- UI helpers
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  function setLandingMsg(msg, isErr) {
    const m = $('#landingMsg');
    m.textContent = msg || '';
    m.classList.toggle('err', !!isErr);
  }

  function setBusy(b) {
    S.busy = b;
    ['#soloBtn', '#hostBtn', '#joinBtn'].forEach(s => { $(s).disabled = b; });
  }

  function showScreen(which) {
    $('#landing').hidden = which !== 'landing';
    $('#game').hidden = which !== 'game';
    window.scrollTo(0, 0);
  }

  function copyText(text, okMsg) {
    const done = () => toast(okMsg);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => window.prompt('Salin manual:', text));
    } else {
      window.prompt('Salin manual:', text);
    }
  }

  const shareLink = () => location.origin + location.pathname + '?room=' + S.code;

  // ---------------------------------------------------------------- landing
  function initLanding() {
    S.name = store.get('name') || '';
    S.color = store.get('color') || COLORS[Math.floor(Math.random() * COLORS.length)];
    if (!COLORS.includes(S.color)) S.color = COLORS[0];
    $('#nameInput').value = S.name;

    const box = $('#swatches');
    COLORS.forEach(c => {
      const b = el('button', 'swatch');
      b.type = 'button';
      b.style.background = c;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', 'Warna ' + c);
      b.addEventListener('click', () => { S.color = c; renderSwatches(); });
      box.appendChild(b);
    });
    renderSwatches();

    const room = cleanCode(new URLSearchParams(location.search).get('room'));
    if (room.length === 5) {
      $('#codeInput').value = room;
      setLandingMsg('Kamu diundang ke room ' + room + '. Isi nama lalu tekan Gabung.');
      $('#nameInput').focus();
    }

    $('#soloBtn').addEventListener('click', () => { if (readProfile()) startSolo(); });
    $('#hostBtn').addEventListener('click', () => { if (readProfile()) startHost(); });
    $('#joinBtn').addEventListener('click', () => { if (readProfile()) startJoin(); });
    $('#codeInput').addEventListener('input', e => { e.target.value = cleanCode(e.target.value); });
    $('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
    $('#nameInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') ($('#codeInput').value.length === 5 ? $('#joinBtn') : $('#soloBtn')).click();
    });
  }

  function renderSwatches() {
    document.querySelectorAll('.swatch').forEach((b, i) => {
      b.setAttribute('aria-checked', String(COLORS[i] === S.color));
    });
  }

  function readProfile() {
    const name = cleanName($('#nameInput').value);
    if (!name) {
      setLandingMsg('Isi nama karakter dulu ya.', true);
      $('#nameInput').focus();
      return false;
    }
    S.name = name;
    store.set('name', name);
    store.set('color', S.color);
    setLandingMsg('');
    return true;
  }

  // ---------------------------------------------------------------- modes
  function startSolo() {
    cleanupPeer();
    S.mode = 'solo';
    S.code = '';
    S.myId = 'me';
    S.players = [{ id: 'me', name: S.name, color: S.color }];
    S.log = [];
    S.connected = true;
    enterGame();
  }

  function peerReady() {
    if (typeof window.Peer !== 'function') {
      setLandingMsg('Library multiplayer gagal dimuat (cek koneksi internet). Mode Solo tetap bisa dipakai.', true);
      return false;
    }
    return true;
  }

  function peerErrText(err) {
    switch (err && err.type) {
      case 'peer-unavailable': return 'Room tidak ditemukan. Cek kode room, atau pastikan GM masih membuka halamannya.';
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed': return 'Tidak bisa menghubungi server perantara. Cek koneksi internetmu lalu coba lagi.';
      case 'browser-incompatible': return 'Browser ini tidak mendukung WebRTC.';
      case 'webrtc': return 'Koneksi WebRTC gagal. Jaringan tertentu (kantor/sekolah) bisa memblokirnya.';
      default: return 'Gagal terhubung' + (err && err.message ? ': ' + err.message : '.');
    }
  }

  function cleanupPeer() {
    const p = S.peer;
    S.peer = null;
    S.hostConn = null;
    S.conns.clear();
    if (p) { try { p.destroy(); } catch { /* abaikan */ } }
  }

  // ----- Host (GM)
  function startHost() {
    if (!peerReady()) return;
    setBusy(true);
    setLandingMsg('Menyiapkan room…');
    cleanupPeer();

    const stored = cleanCode(store.get('hostCode'));
    let attempts = 0;

    const tryCode = code => {
      attempts++;
      const peer = new Peer(PREFIX + code, { debug: 0, config: RTC_CONFIG });
      S.peer = peer;

      peer.on('open', () => {
        if (S.peer !== peer) return;
        store.set('hostCode', code);
        S.mode = 'host';
        S.code = code;
        S.myId = 'gm';
        S.players = [{ id: 'gm', name: S.name, color: S.color, gm: true }];
        S.log = [];
        S.connected = true;
        setBusy(false);
        enterGame();
        sysEntry('Room ' + code + ' dibuat. Bagikan kodenya ke party-mu!');
      });

      peer.on('connection', conn => onIncoming(conn));

      peer.on('disconnected', () => {
        // Putus dari server perantara (koneksi pemain yang sudah ada tetap hidup).
        if (S.peer === peer && !peer.destroyed) { try { peer.reconnect(); } catch { /* abaikan */ } }
      });

      peer.on('error', err => {
        if (S.peer !== peer) return;
        if (S.mode === 'host') {
          if (err.type !== 'peer-unavailable') toast(peerErrText(err));
          return;
        }
        try { peer.destroy(); } catch { /* abaikan */ }
        S.peer = null;
        if (err.type === 'unavailable-id' && attempts < 6) { tryCode(genCode()); return; }
        setBusy(false);
        setLandingMsg(peerErrText(err), true);
      });
    };

    tryCode(stored.length === 5 ? stored : genCode());
  }

  function onIncoming(conn) {
    conn.on('data', msg => onHostData(conn, msg));
    conn.on('close', () => dropClient(conn.peer));
    conn.on('error', () => dropClient(conn.peer));
  }

  function broadcast(msg, exceptId) {
    S.conns.forEach((conn, id) => {
      if (id !== exceptId && conn.open) { try { conn.send(msg); } catch { /* abaikan */ } }
    });
  }

  function sendTo(id, msg) {
    const c = S.conns.get(id);
    if (c && c.open) { try { c.send(msg); } catch { /* abaikan */ } }
  }

  function onHostData(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    const id = conn.peer;

    if (msg.t === 'hello') {
      if (S.conns.has(id)) return;
      if (S.players.length >= MAX_PLAYERS) {
        try { conn.send({ t: 'full' }); } catch { /* abaikan */ }
        setTimeout(() => { try { conn.close(); } catch { /* abaikan */ } }, 300);
        return;
      }
      let name = cleanName(msg.name) || 'Petualang';
      const base = name;
      let n = 2;
      while (S.players.some(p => p.name.toLowerCase() === name.toLowerCase())) name = base.slice(0, 16) + ' ' + n++;
      const color = COLORS.includes(msg.color) ? msg.color : COLORS[0];

      S.conns.set(id, conn);
      S.players.push({ id, name, color });
      conn.send({
        t: 'welcome', you: id, code: S.code, players: S.players,
        log: S.log.filter(r => !r.secret || r.pid === id)
      });
      broadcast({ t: 'players', players: S.players });
      sysEntry(name + ' bergabung.');
      renderPlayers();
      renderStatus();
      return;
    }

    const player = S.players.find(p => p.id === id);
    if (!player || !S.conns.has(id)) return;

    if (msg.t === 'roll') {
      const raw = msg.roll;
      finalizeRoll(raw, player, !!(raw && raw.secret));
    }
  }

  function dropClient(id) {
    if (!S.conns.has(id)) return;
    S.conns.delete(id);
    const p = S.players.find(x => x.id === id);
    S.players = S.players.filter(x => x.id !== id);
    broadcast({ t: 'players', players: S.players });
    if (p) sysEntry(p.name + ' keluar.');
    renderPlayers();
    renderStatus();
  }

  // ----- Client (pemain)
  function startJoin() {
    const code = cleanCode($('#codeInput').value);
    if (code.length !== 5) { setLandingMsg('Kode room terdiri dari 5 karakter.', true); return; }
    if (!peerReady()) return;
    setBusy(true);
    setLandingMsg('Menghubungkan ke room ' + code + '…');
    connectToRoom(code, msg => { setBusy(false); setLandingMsg(msg, true); });
  }

  function connectToRoom(code, onFail) {
    cleanupPeer();
    let done = false;
    let timer = null;
    const peer = new Peer(undefined, { debug: 0, config: RTC_CONFIG });
    S.peer = peer;

    const fail = msg => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (S.peer === peer) cleanupPeer(); else { try { peer.destroy(); } catch { /* abaikan */ } }
      onFail(msg);
    };

    timer = setTimeout(() => fail('Room tidak merespons. Cek kode room atau coba lagi.'), 15000);

    peer.on('error', err => { if (S.peer === peer) fail(peerErrText(err)); });

    peer.on('open', () => {
      if (S.peer !== peer) return;
      const conn = peer.connect(PREFIX + code, { reliable: true });

      conn.on('open', () => conn.send({ t: 'hello', name: S.name, color: S.color }));

      conn.on('data', msg => {
        if (!msg || typeof msg !== 'object') return;
        if (!done) {
          if (msg.t === 'full') { fail('Room penuh (maksimal ' + MAX_PLAYERS + ' pemain).'); return; }
          if (msg.t !== 'welcome') return;
          done = true;
          clearTimeout(timer);
          S.hostConn = conn;
          S.mode = 'client';
          S.code = code;
          S.connected = true;
          setBusy(false);
          applyWelcome(msg);
          return;
        }
        onClientData(msg);
      });

      const gone = () => {
        if (S.peer !== peer) return;
        if (!done) fail('Koneksi ke room ditolak atau terputus.');
        else onHostGone();
      };
      conn.on('close', gone);
      conn.on('error', gone);
    });
  }

  // Data dari jaringan tidak dipercaya begitu saja: bersihkan sebelum dirender.
  function normalizePlayers(list) {
    return (Array.isArray(list) ? list : []).slice(0, MAX_PLAYERS).map(p => ({
      id: String((p && p.id) || '').slice(0, 64),
      name: cleanName(p && p.name) || '?',
      color: safeColor(p && p.color),
      gm: !!(p && p.gm)
    }));
  }

  function normalizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const base = {
      id: String(e.id || uid()).slice(0, 40),
      ts: Number.isFinite(e.ts) ? e.ts : Date.now()
    };
    if (e.sys) return Object.assign(base, { sys: true, text: Dice.cleanStr(e.text, 120) });
    const r = Dice.sanitizeRoll(e);
    if (!r) return null;
    return Object.assign(r, base, {
      pid: String(e.pid || '').slice(0, 64),
      name: cleanName(e.name) || '?',
      color: safeColor(e.color),
      secret: !!e.secret
    });
  }

  function applyWelcome(msg) {
    S.myId = String(msg.you);
    S.players = normalizePlayers(msg.players);
    S.log = (Array.isArray(msg.log) ? msg.log : []).map(normalizeEntry).filter(Boolean).slice(-MAX_LOG);
    enterGame();
  }

  function onClientData(msg) {
    switch (msg.t) {
      case 'players':
        S.players = normalizePlayers(msg.players);
        renderPlayers();
        renderStatus();
        break;
      case 'entry': {
        const entry = normalizeEntry(msg.entry);
        if (entry) pushEntry(entry, true);
        break;
      }
      case 'clear':
        S.log = [];
        renderLog();
        break;
      default: break;
    }
  }

  function onHostGone() {
    if (S.mode !== 'client' || !S.connected) return;
    S.connected = false;
    S.hostConn = null;
    sysEntry('Koneksi ke GM terputus.', true);
    renderStatus();
    toast('Terputus dari GM');
  }

  function rejoin() {
    if (S.mode !== 'client' || !S.code) return;
    $('#reconnectBtn').disabled = true;
    toast('Menghubungkan ulang…');
    connectToRoom(S.code, msg => {
      $('#reconnectBtn').disabled = false;
      toast(msg);
    });
  }

  function leave() {
    cleanupPeer();
    S.mode = null;
    S.code = '';
    S.connected = false;
    S.players = [];
    S.log = [];
    clearInterval(S.animTimer);
    history.replaceState(null, '', location.pathname);
    setBusy(false);
    setLandingMsg('');
    $('#codeInput').value = '';
    showScreen('landing');
  }

  // ---------------------------------------------------------------- game screen
  function enterGame() {
    showScreen('game');
    const isGM = S.mode === 'host';
    const isSolo = S.mode === 'solo';
    $('#copyCodeBtn').hidden = isSolo;
    $('#clearBtn').hidden = !(isGM || isSolo);
    $('#secretRow').hidden = isSolo;
    $('#secretText').textContent = isGM
      ? 'Lempar rahasia (pemain tidak melihat)'
      : 'Lempar rahasia (hanya GM yang melihat)';
    $('#secretCheck').checked = false;
    renderStatus();
    renderPlayers();
    renderLog();
    resetStage();
    syncPool();
  }

  function renderStatus() {
    const title = $('#statusTitle');
    const sub = $('#statusSub');
    const dot = $('#statusDot');
    const n = S.players.length;
    dot.className = 'dot';

    if (S.mode === 'solo') {
      title.textContent = 'Mode Solo';
      sub.textContent = 'Hanya kamu yang melihat lemparan ini';
    } else if (S.mode === 'host') {
      title.textContent = 'Room ' + S.code;
      sub.textContent = 'Kamu GM · ' + n + ' pemain';
      dot.classList.add('ok');
    } else if (S.mode === 'client') {
      title.textContent = 'Room ' + S.code;
      sub.textContent = S.connected ? 'Terhubung · ' + n + ' pemain' : 'Terputus dari GM';
      dot.classList.add(S.connected ? 'ok' : 'bad');
    }
    $('#reconnectBtn').disabled = false;
    $('#reconnectBtn').hidden = !(S.mode === 'client' && !S.connected);
    $('#rollBtn').disabled = S.mode === 'client' && !S.connected;
  }

  function renderPlayers() {
    const box = $('#players');
    box.textContent = '';
    S.players.forEach(p => {
      const chip = el('span', 'player' + (p.id === S.myId ? ' me' : ''));
      const dot = el('i');
      dot.style.background = safeColor(p.color);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(String(p.name || '?').slice(0, 20)));
      if (p.gm) chip.appendChild(el('span', 'gm', 'GM'));
      box.appendChild(chip);
    });
  }

  // ---------------------------------------------------------------- log & stage
  function breakdown(r) {
    const f = document.createDocumentFragment();
    (r.terms || []).forEach((t, i) => {
      const part = el('span', 'term');
      part.append((t.sign < 0 ? '− ' : (i > 0 ? '+ ' : '')) + t.rolls.length + 'd' + t.sides + ' [');
      t.rolls.forEach((v, j) => { if (j) part.append(', '); part.append(String(v)); });
      if (t.dropped && t.dropped.length) {
        part.append(' ');
        part.appendChild(el('s', null, t.dropped.join(',')));
      }
      part.append(']');
      f.appendChild(part);
    });
    if (r.mod) f.appendChild(el('span', 'term', (r.mod > 0 ? '+ ' : '− ') + Math.abs(r.mod)));
    return f;
  }

  const fmtTime = ts => new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  function buildEntry(r, isNew) {
    if (r.sys) {
      return el('li', 'entry sys', String(r.text || ''));
    }
    const li = el('li', 'entry'
      + (r.pid === S.myId ? ' mine' : '')
      + (r.secret ? ' secret' : '')
      + (r.crit ? ' ' + r.crit : '')
      + (isNew ? ' new' : ''));

    const av = el('div', 'avatar', String(r.name || '?').charAt(0).toUpperCase());
    av.style.background = safeColor(r.color);

    const body = el('div', 'body');
    const head = el('div', 'head');
    head.appendChild(el('strong', null, String(r.name || '?')));
    if (r.label) head.appendChild(el('span', 'label', '· ' + r.label));
    if (r.mode) head.appendChild(el('span', 'tag', r.mode === 'adv' ? 'Advantage' : 'Disadvantage'));
    if (r.crit === 'nat20') head.appendChild(el('span', 'tag n20', 'NAT 20'));
    if (r.crit === 'nat1') head.appendChild(el('span', 'tag n1', 'NAT 1'));
    if (r.secret) head.appendChild(el('span', 'tag', '🔒 rahasia'));
    head.appendChild(el('span', 'time', fmtTime(r.ts)));

    const calc = el('div', 'calc');
    calc.appendChild(breakdown(r));
    body.append(head, calc);

    li.append(av, body, el('div', 'total', String(r.total)));
    return li;
  }

  function renderLog(newId) {
    const ol = $('#log');
    ol.textContent = '';
    for (let i = S.log.length - 1; i >= 0; i--) {
      const r = S.log[i];
      ol.appendChild(buildEntry(r, !!newId && r.id === newId));
    }
    $('#logEmpty').hidden = S.log.length > 0;
  }

  function pushEntry(r, animate) {
    if (!r.id) r.id = uid();
    if (!r.ts) r.ts = Date.now();
    S.log.push(r);
    if (S.log.length > MAX_LOG) S.log.splice(0, S.log.length - MAX_LOG);
    renderLog(r.id);
    if (!r.sys) showStage(r, animate);
  }

  function sysEntry(text, localOnly) {
    const r = { id: uid(), ts: Date.now(), sys: true, text };
    S.log.push(r);
    if (S.log.length > MAX_LOG) S.log.splice(0, S.log.length - MAX_LOG);
    renderLog();
    if (S.mode === 'host' && !localOnly) broadcast({ t: 'entry', entry: r });
  }

  function resetStage() {
    const stage = $('#stage');
    clearInterval(S.animTimer);
    stage.className = 'stage';
    $('#stageWho').textContent = 'Belum ada lemparan';
    $('#stageNum').textContent = '–';
    $('#stageCrit').hidden = true;
    $('#stageDetail').textContent = 'Pilih dadu lalu tekan Lempar.';
    const last = [...S.log].reverse().find(r => !r.sys);
    if (last) showStage(last, false);
  }

  function showStage(r, animate) {
    const stage = $('#stage');
    const num = $('#stageNum');
    clearInterval(S.animTimer);

    $('#stageWho').textContent = String(r.name || '?') + (r.label ? ' · ' + r.label : '') + (r.secret ? ' · 🔒' : '');
    $('#stageCrit').hidden = true;
    stage.classList.remove('nat20', 'nat1');

    const detail = $('#stageDetail');
    detail.textContent = '';
    detail.appendChild(breakdown(r));

    const settle = () => {
      stage.classList.remove('rolling');
      num.textContent = String(r.total);
      if (r.crit) {
        stage.classList.add(r.crit);
        const c = $('#stageCrit');
        c.textContent = r.crit === 'nat20' ? 'NAT 20!' : 'NAT 1…';
        c.hidden = false;
      }
    };

    if (!animate || reducedMotion) { settle(); return; }

    const faces = (r.terms && r.terms[0] && r.terms[0].sides) || 20;
    let ticks = 0;
    stage.classList.add('rolling');
    S.animTimer = setInterval(() => {
      num.textContent = String(1 + Math.floor(Math.random() * faces));
      if (++ticks >= 9) { clearInterval(S.animTimer); settle(); }
    }, 60);
  }

  // ---------------------------------------------------------------- rolling
  function currentParsed() { return Dice.parse($('#formula').value); }

  function syncPool() {
    const input = $('#formula');
    const p = Dice.parse(input.value);
    const hint = $('#formulaHint');

    document.querySelectorAll('.tile').forEach(tile => {
      const sides = Number(tile.dataset.sides);
      const t = !p.error && p.terms.find(x => x.sign > 0 && x.sides === sides);
      const count = t ? t.count : 0;
      tile.classList.toggle('active', count > 0);
      tile.querySelector('.badge').hidden = count === 0;
      tile.querySelector('.badge').textContent = count;
      tile.querySelector('.minus').hidden = count === 0;
    });

    const invalid = !!p.error && input.value.trim() !== '';
    input.classList.toggle('invalid', invalid);
    hint.classList.toggle('err', invalid);
    hint.textContent = invalid ? p.error : '';

    const advOk = !p.error && p.terms.some(t => t.sign > 0 && t.sides === 20 && t.count === 1);
    $('#advSeg').classList.toggle('disabled', !advOk);
    if (!advOk && S.adv) setAdv('');
  }

  function setAdv(v) {
    S.adv = v;
    document.querySelectorAll('#advSeg button').forEach(b => {
      const on = b.dataset.adv === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
  }

  function setFormula(v) {
    $('#formula').value = v;
    syncPool();
  }

  function initRoller() {
    const pad = $('#dicePad');
    Dice.DICE.forEach(sides => {
      const tile = el('div', 'tile');
      tile.dataset.sides = sides;
      const main = el('button', 'main', 'd' + sides);
      main.type = 'button';
      main.setAttribute('aria-label', 'Tambah d' + sides);
      main.addEventListener('click', () => setFormula(Dice.bump($('#formula').value, sides, 1)));
      const badge = el('span', 'badge', '0');
      badge.hidden = true;
      const minus = el('button', 'minus', '−');
      minus.type = 'button';
      minus.hidden = true;
      minus.setAttribute('aria-label', 'Kurangi d' + sides);
      minus.addEventListener('click', () => setFormula(Dice.bump($('#formula').value, sides, -1)));
      tile.append(main, badge, minus);
      pad.appendChild(tile);
    });

    const presets = $('#presets');
    PRESET_LABELS.forEach(label => {
      const chip = el('button', 'chip', label);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        const input = $('#labelInput');
        input.value = input.value === label ? '' : label;
        document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.textContent === input.value));
      });
      presets.appendChild(chip);
    });
    $('#labelInput').addEventListener('input', e => {
      document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.textContent === e.target.value));
    });

    $('#formula').addEventListener('input', syncPool);
    $('#formula').addEventListener('keydown', e => { if (e.key === 'Enter') doRoll(); });
    $('#modPlus').addEventListener('click', () => setFormula(Dice.bumpMod($('#formula').value, 1)));
    $('#modMinus').addEventListener('click', () => setFormula(Dice.bumpMod($('#formula').value, -1)));
    $('#resetBtn').addEventListener('click', () => setFormula(''));
    $('#advSeg').addEventListener('click', e => {
      const b = e.target.closest('button[data-adv]');
      if (b) setAdv(b.dataset.adv);
    });
    $('#rollBtn').addEventListener('click', doRoll);

    $('#copyCodeBtn').addEventListener('click', () => {
      copyText(shareLink(), 'Link undangan disalin. Kode room: ' + S.code);
    });
    $('#reconnectBtn').addEventListener('click', rejoin);
    $('#leaveBtn').addEventListener('click', () => {
      if (S.mode === 'host' && S.players.length > 1 && !confirm('Kamu GM. Keluar akan menutup room untuk semua pemain. Lanjut?')) return;
      leave();
    });
    $('#clearBtn').addEventListener('click', () => {
      S.log = [];
      renderLog();
      resetStage();
      if (S.mode === 'host') broadcast({ t: 'clear' });
    });
  }

  function doRoll() {
    if (S.mode === 'client' && !S.connected) { toast('Belum terhubung ke GM'); return; }
    const p = currentParsed();
    if (p.error || !p.terms.length) {
      const hint = $('#formulaHint');
      hint.classList.add('err');
      hint.textContent = p.error && $('#formula').value.trim() ? p.error : 'Pilih minimal satu dadu dulu.';
      $('#formula').focus();
      return;
    }
    const r = Dice.roll(p, S.adv);
    r.label = Dice.cleanStr($('#labelInput').value, 40);
    r.secret = S.mode !== 'solo' && $('#secretCheck').checked;

    if (S.mode === 'solo') {
      const me = S.players[0];
      pushEntry(Object.assign(r, { id: uid(), ts: Date.now(), pid: me.id, name: me.name, color: me.color }), true);
    } else if (S.mode === 'host') {
      finalizeRoll(r, S.players[0], r.secret);
    } else if (S.hostConn && S.hostConn.open) {
      S.hostConn.send({ t: 'roll', roll: r });
    }
  }

  // Dijalankan di GM: validasi, cap identitas, simpan, lalu siarkan.
  function finalizeRoll(raw, player, secret) {
    const r = Dice.sanitizeRoll(raw);
    if (!r) return;
    r.id = uid();
    r.ts = Date.now();
    r.pid = player.id;
    r.name = player.name;
    r.color = player.color;
    r.secret = !!secret;

    pushEntry(r, true);  // GM selalu melihat semuanya
    if (r.secret) {
      if (player.id !== 'gm') sendTo(player.id, { t: 'entry', entry: r });
    } else {
      broadcast({ t: 'entry', entry: r });
    }
  }

  // ---------------------------------------------------------------- boot
  initLanding();
  initRoller();
})();
