
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.
- Rate limiter lokal dinonaktifkan (`checkRateLimit` di `src/utils/rateLimit.ts` selalu mengembalikan `true`).
- Telegram API memiliki auto-retry otomatis jika mengembalikan error 429 (Too Many Requests) menggunakan pool Telegraf multi-bot di `src/utils/telegram.ts`.
|- Multi-bot dikonfigurasi melalui `BOT_TOKENS` (koma terpisah) di `.env` — semua token bot digabung dalam satu variabel.
- Menggunakan mekanisme rotasi instan jika ada bot yang terkena rate limit 429 sebelum memutuskan untuk sleep.
- Pengiriman berkas ke Telegram dieksekusi secara responsif dan paralel penuh tanpa batas konkurensi/antrian.
- Berkas API upload ditulis secara sementara ke disk `/tmp/teleuploader-*` dan di-stream ke Telegram menggunakan `fs.createReadStream` (RAM-optimized) lalu dihapus otomatis setelah 50ms (timeout aman).

## Chunk size (TELEGRAM_CHUNK_SIZE_BYTES)

- Batas keras: Telegram Bot API `getFile` hanya bisa resolve file ≤ 20 MB — di atas itu error `Bad Request: file is too big` dan part tidak bisa di-download.
- Guard fail-fast di `src/env.ts`: service MENOLAK start (exit non-zero) jika `TELEGRAM_CHUNK_SIZE_BYTES` > 19922944 (19 MB, margin aman dari limit 20 MB). Konstanta: `TELEGRAM_CHUNK_SIZE_MAX_BYTES` di `src/shared/utils/validation.ts`, juga dipakai `asSafeChunkSize()` di runtime.
- Default 19 MB; berlaku untuk chunked storage DAN S3 multipart parts (sama-sama disimpan ke Telegram lalu di-resolve via getFile).

## Testing

Use `bun test` to run tests. Jalankan tes secara spesifik (misal `bun test test/rateLimit.test.ts`) untuk menghindari polusi mock antar berkas tes ketika dijalankan bersamaan.
- Pengujian unit test (`telegram.test.ts` dan `upload.test.ts`) mengunduh gambar asli Wikimedia (PNG transparan) secara dinamis via fetch, dengan fallback biner lokal JPEG 1x1px jika luring.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.
