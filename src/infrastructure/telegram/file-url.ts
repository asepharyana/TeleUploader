/**
 * Builds a Telegram CDN download URL from a file path and bot token.
 *
 * Single canonical implementation — previously constructed inline in
 * `interfaces/http/controllers/file-controller.ts`,
 * `interfaces/http/controllers/web-api-controller.ts`,
 * `interfaces/http/controllers/s3-controller.ts`, and
 * `infrastructure/telegram/chunked-storage.ts`.
 *
 * NOTE: URLs produced here embed the bot token. They must only be used
 * server-side (outbound fetch to the Telegram CDN), never exposed to
 * clients in redirects or response bodies.
 *
 * @param filePath - The Telegram file path returned by getFile.
 * @param botToken - The bot token used to authenticate the download.
 * @returns The full Telegram CDN URL.
 */
export const buildTelegramFileUrl = (filePath: string, botToken: string): string =>
  `https://api.telegram.org/file/bot${botToken}/${filePath}`;
