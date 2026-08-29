# TeleUploader — Audit & Optimisasi Stabilitas + S3 (2026-08-27)

## Scope
Audit dan optimasikan backend TeleUploader agar stabil di segala situasi dan
S3 protocol stabil + secepat mungkin. Fokus pada bottleneck nyata yang
ditemukan saat audit kode + log.

## Temuan Audit (root cause → prioritas)

### A. S3 GET lambat (bottleneck terbesar download)
1. **`concatPartStreams` (object-stream.ts) fetch part SEQUENTIAL** — tiap part
   di-`fetch` satu per satu (for..of + await penuh). Untuk objek chunked/multipart
   dengan N part, byte pertama baru terkirim SETELAH semua fetch part selesai.
   → **PARALELISASI** dengan bounded concurrency, urut tetap dipertahankan.
2. **`buildChunkedObjectSources` & `handleGetMultipartObject` resolve
   `getFileInfo` SEQUENTIAL** (for..of + await). N call Telegram API berurutan
   sebelum streaming mulai.
   → **`Promise.all`** resolve paralel.
3. **`botPool.getFileInfo` TIDAK pakai `fileInfoCache`** yang sudah ada — setiap
   S3 GET objek reguler memanggil API Telegram `getFile` (network round-trip).
   file-controller punya wrapper cache sendiri, tapi path S3 tidak.
   → **pindahkan caching ke dalam `botPool.getFileInfo`** agar semua caller dapat.

### B. Stabilitas / lingkungan produksi
4. **`nodeEnv: "development"` di produksi** (dari log BWS). Winston format json
   sudah benar di production, tapi flag salah.
5. **`trustProxy: false` di produksi padahal di belakang Caddy** → rate limiter
   meng-key semua user ke `127.0.0.1` (satu bucket global). Ini bug kecil untuk
   non-S3 route. Fix: default trustProxy menyesuaikan, tapi utama via env.
6. **MemoryMax=512M di systemd** padahal config mendukung blob 2GB. Streaming
   PUT O(1) memory, tapi GET gzip part membuffer part utuh. Naikkan ke 1G.

### C. Robustness S3
7. **`handleUploadPart` tidak `await writer.end()`** sebelum `createReadStream`
   → potensi race baca file belum flush. Await end().
8. Batas kecepatan unggah: `telegramBotConcurrency:1` × 6 bot = 6 unggah paralel.
   Karena Telegram ~1 rps/bot untuk sendDocument, konkuransi per-bot 1 masuk
   akal. Biarkan default, tapi pastikan pool retry terhadap 429 sudah bagus
   (sudah, ada retry-after handling).

## File yang disentuh (semua di bawah src/)
- `src/interfaces/s3/object-stream.ts` — paralelisasi fetch part (concatPartStreams)
- `src/infrastructure/telegram/bot-pool.ts` — getFileInfo + cache, resolve paralel
- `src/infrastructure/telegram/chunked-storage.ts` — buildChunkedObjectSources paralel
- `src/interfaces/http/controllers/s3-controller.ts` — handleGetMultipartObject paralel,
  await writer.end() di handleUploadPart
- `src/infrastructure/cache/index.ts` — (opsional) tambah helper

## Verifikasi
- `bunx biome check src test` (lint)
- `bun test test/s3-auth.test.ts` & `test/s3-operations.test.ts` (S3 regresi)
- `bun test test/telegram.test.ts` (pool) kalau ada
- Test unit baru untuk parallel part streaming (tanpa network) kalau layak.
- Deploy via push main → CI `deploy.yml` (Nix build → nix copy → systemctl restart).

## Deploy
Push ke `main` → GitHub Actions `deploy.yml` build + deploy Nix ke orangevps.
Setelah deploy, verifikasi `/health` 200 dan S3 GET masih berfungsi.
