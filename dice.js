/*
 * dice.js — logika dadu murni (tanpa DOM, tanpa jaringan).
 * Dipakai di browser (window.Dice) dan bisa dites di Node (module.exports).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Dice = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DICE = [4, 6, 8, 10, 12, 20, 100];
  const MAX_DICE = 100;
  const MAX_SIDES = 1000;
  const MAX_MOD = 9999;

  // Angka acak seragam 1..n memakai crypto (rejection sampling, tanpa modulo bias).
  function randInt(n) {
    const g = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? crypto
      : require('crypto').webcrypto;
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    let x;
    do { g.getRandomValues(buf); x = buf[0]; } while (x >= limit);
    return (x % n) + 1;
  }

  function fail(msg) { return { terms: [], mod: 0, error: msg }; }

  // "2d6+1d4-2" -> { terms:[{sign,count,sides}], mod, error }
  function parse(input) {
    // Spasi hanya boleh di sekitar + dan − ("2d6 + 3"); "2d6 3" bukan "2d63".
    const s = String(input == null ? '' : input).toLowerCase().trim().replace(/\s*([+-])\s*/g, '$1');
    if (!s) return fail('Rumus masih kosong');
    if (/\s/.test(s)) return fail('Rumus tidak valid. Contoh: 2d6+3');
    const re = /([+-]?)(?:(\d*)d(\d+)|(\d+))/y;
    const terms = [];
    let mod = 0, i = 0, totalDice = 0;
    while (i < s.length) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (!m || (i > 0 && !m[1])) return fail('Rumus tidak valid. Contoh: 2d6+3');
      i = re.lastIndex;
      const sign = m[1] === '-' ? -1 : 1;
      if (m[3] !== undefined) {
        const count = m[2] === '' ? 1 : parseInt(m[2], 10);
        const sides = parseInt(m[3], 10);
        if (count < 1 || count > MAX_DICE) return fail('Jumlah dadu harus 1–' + MAX_DICE);
        if (sides < 2 || sides > MAX_SIDES) return fail('Sisi dadu harus 2–' + MAX_SIDES);
        totalDice += count;
        if (totalDice > MAX_DICE) return fail('Maksimal ' + MAX_DICE + ' dadu sekali lempar');
        const ex = terms.find(t => t.sign === sign && t.sides === sides);
        if (ex) ex.count += count; else terms.push({ sign, count, sides });
      } else {
        mod += sign * parseInt(m[4], 10);
      }
    }
    if (Math.abs(mod) > MAX_MOD) return fail('Modifier terlalu besar');
    return { terms, mod, error: null };
  }

  function sortTerms(terms) {
    return terms.slice().sort((a, b) => (b.sign - a.sign) || (a.sides - b.sides));
  }

  // { terms:[{sign,count,sides}], mod } -> "2d6+1d4-2"
  function format(p) {
    let out = '';
    sortTerms(p.terms).forEach((t, i) => {
      out += (t.sign < 0 ? '-' : (i > 0 ? '+' : '')) + t.count + 'd' + t.sides;
    });
    if (p.mod) out += (p.mod < 0 ? '-' : (out ? '+' : '')) + Math.abs(p.mod);
    return out;
  }

  function lenient(str) {
    const p = parse(str);
    return p.error ? { terms: [], mod: 0 } : p;
  }

  const sumCount = p => p.terms.reduce((a, t) => a + t.count, 0);

  // Tambah/kurangi jumlah dadu bersisi `sides` pada string rumus.
  function bump(str, sides, delta) {
    const p = lenient(str);
    const t = p.terms.find(x => x.sign > 0 && x.sides === sides);
    if (!t) {
      if (delta > 0 && sumCount(p) < MAX_DICE) p.terms.push({ sign: 1, count: 1, sides });
    } else {
      const before = t.count;
      t.count += delta;
      if (t.count <= 0) p.terms.splice(p.terms.indexOf(t), 1);
      else if (sumCount(p) > MAX_DICE) t.count = before;
    }
    return format(p);
  }

  function bumpMod(str, delta) {
    const p = lenient(str);
    p.mod = Math.max(-MAX_MOD, Math.min(MAX_MOD, p.mod + delta));
    return format(p);
  }

  // Menyusun hasil akhir dari term yang sudah dilempar.
  // terms: [{ sign, sides, rolls:[], dropped:[] }]
  function finish(terms, mod, mode) {
    let total = mod;
    let nat = null;
    for (const t of terms) {
      total += t.sign * t.rolls.reduce((a, b) => a + b, 0);
      if (nat === null && t.sides === 20 && t.sign > 0 && t.rolls.length === 1) nat = t.rolls[0];
    }
    const formula = format({
      terms: terms.map(t => ({ sign: t.sign, count: t.rolls.length, sides: t.sides })),
      mod
    });
    return {
      formula, terms, mod, total,
      mode: mode || null,
      crit: nat === 20 ? 'nat20' : (nat === 1 ? 'nat1' : null)
    };
  }

  // Lempar dadu dari hasil parse(). adv: 'adv' | 'dis' | null.
  // Advantage/disadvantage berlaku pada d20 tunggal (positif) pertama.
  function roll(parsed, adv) {
    let applied = null;
    const terms = parsed.terms.map(t => {
      const rolls = [];
      for (let i = 0; i < t.count; i++) rolls.push(randInt(t.sides));
      let dropped = [];
      if (adv && !applied && t.sides === 20 && t.count === 1 && t.sign > 0) {
        const a = rolls[0];
        const b = randInt(20);
        const keep = adv === 'adv' ? Math.max(a, b) : Math.min(a, b);
        dropped = [a === keep ? b : a];
        rolls[0] = keep;
        applied = adv;
      }
      return { sign: t.sign, sides: t.sides, rolls, dropped };
    });
    return finish(terms, parsed.mod, applied);
  }

  const cleanStr = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);

  // Validasi hasil lemparan dari jaringan; hitung ulang total/crit/formula.
  function sanitizeRoll(r) {
    if (!r || typeof r !== 'object' || !Array.isArray(r.terms)) return null;
    if (r.terms.length < 1 || r.terms.length > 20) return null;
    let dice = 0;
    const terms = [];
    for (const t of r.terms) {
      if (!t || typeof t !== 'object') return null;
      if (!Number.isInteger(t.sides) || t.sides < 2 || t.sides > MAX_SIDES) return null;
      const sides = t.sides;
      const clean = a => (Array.isArray(a) ? a : []).slice(0, MAX_DICE)
        .map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= sides);
      const rolls = clean(t.rolls);
      const dropped = clean(t.dropped).slice(0, 1);
      if (!rolls.length) return null;
      dice += rolls.length + dropped.length;
      if (dice > MAX_DICE + 1) return null;
      terms.push({ sign: t.sign === -1 ? -1 : 1, sides, rolls, dropped });
    }
    const mod = Number.isInteger(r.mod) ? Math.max(-MAX_MOD, Math.min(MAX_MOD, r.mod)) : 0;
    const mode = (r.mode === 'adv' || r.mode === 'dis') ? r.mode : null;
    const out = finish(terms, mod, mode);
    out.label = cleanStr(r.label, 40);
    return out;
  }

  return {
    DICE, MAX_DICE, MAX_SIDES, MAX_MOD,
    randInt, parse, format, bump, bumpMod, roll, sanitizeRoll, cleanStr
  };
});
