# 🎲 Dadu Petualang — Roller Dadu D&D Multiplayer

Roller dadu untuk D&D (dan TTRPG lain) yang jalan 100% di browser. Bisa dipakai solo atau bareng party lewat room dengan kode 5 karakter. Tanpa akun, tanpa backend, tanpa build step.

## Fitur

- Dadu **d4, d6, d8, d10, d12, d20, d100**, tap untuk menambah, tombol **−** untuk mengurangi
- Ketik rumus bebas: `2d6+3`, `1d20+1d4-2`, `4d6`
- **Advantage / Disadvantage** untuk d20 (dadu yang dibuang tetap terlihat, dicoret)
- Highlight **NAT 20** dan **NAT 1**
- Label lemparan (Serangan, Damage, Inisiatif, Save, Skill, atau tulis sendiri)
- **Multiplayer** sampai 10 pemain: satu orang jadi GM (host), yang lain gabung pakai kode atau link undangan
- **Lempar rahasia**: pemain bisa melempar yang hanya dilihat GM; GM bisa melempar tersembunyi dari pemain
- Riwayat lemparan bersama, pemain yang baru masuk ikut melihat riwayat
- Angka acak memakai `crypto.getRandomValues` (tanpa modulo bias)
- Responsif untuk HP dan desktop

## Deploy ke GitHub Pages

1. Buat repository baru di GitHub (publik).
2. Upload **semua file** di folder ini (`index.html`, `style.css`, `app.js`, `dice.js`, `.nojekyll`, `README.md`) ke root repository.
3. Buka **Settings → Pages**.
4. Di **Build and deployment**, pilih **Deploy from a branch**, branch `main`, folder `/ (root)`, lalu **Save**.
5. Tunggu sekitar 1 menit. Situsmu ada di `https://USERNAME.github.io/NAMA-REPO/`.

Selesai. Tidak ada yang perlu di-build atau dikonfigurasi lagi.

## Cara main multiplayer

1. **GM**: isi nama, tekan **Buat Room**. Tekan **Salin link** dan kirim ke party.
2. **Pemain**: buka link itu (atau buka situsnya dan ketik kode room), isi nama, tekan **Gabung**.
3. Semua lemparan muncul di layar semua orang.

GM harus tetap membuka halamannya selama sesi. Kalau GM menutup tab, room ikut tertutup. Kalau GM me-refresh, ia akan mencoba memakai kode room yang sama; pemain tinggal menekan **Gabung ulang**.

## Cara kerja (singkat)

Multiplayer memakai **WebRTC peer-to-peer** lewat [PeerJS](https://peerjs.com). GitHub Pages hanya hosting file statis, jadi tidak ada server game. Koneksi antar-browser dibantu broker gratis milik PeerJS (hanya untuk "perkenalan"; data lemparan lewat langsung antar-browser).

- GM bertindak sebagai hub: pemain mengirim lemparan ke GM, GM menyiarkannya ke semua orang.
- Lemparan dihitung di browser pemain lalu divalidasi bentuknya oleh GM. Ini permainan antar-teman, jadi tidak ada proteksi anti-curang.

### Batasan yang perlu diketahui

- Library PeerJS dimuat dari CDN (unpkg, cadangan jsDelivr). Kalau mau mandiri penuh, unduh `peerjs.min.js` dan ubah tag `<script>` di `index.html` ke file lokal.
- Sebagian jaringan ketat (kantor, sekolah, beberapa operator seluler) memblokir WebRTC langsung. Konfigurasi ini hanya memakai server STUN, tanpa TURN. Kalau ada pemain yang tidak bisa terhubung, coba ganti jaringan (mis. pindah ke data seluler atau Wi-Fi lain). Untuk jaminan koneksi, tambahkan server TURN di `RTC_CONFIG` pada `app.js`.
- Tidak ada penyimpanan di server: riwayat hilang saat room ditutup.

## Jalankan lokal

```bash
python3 -m http.server 8000
# buka http://localhost:8000
```

Buka dua tab (atau dua browser) untuk mencoba multiplayer sendiri.

## Struktur

| File | Isi |
| --- | --- |
| `index.html` | Halaman dan markup |
| `style.css` | Tema gelap fantasi, responsif |
| `dice.js` | Logika dadu murni (parse rumus, lempar, validasi) |
| `app.js` | UI dan multiplayer |

## Kustomisasi cepat

- Label cepat: ubah `PRESET_LABELS` di `app.js`
- Batas pemain: `MAX_PLAYERS` di `app.js`
- Warna tema: variabel CSS di bagian atas `style.css`
- Awalan ID room (supaya tidak bentrok dengan app lain): `PREFIX` di `app.js`
