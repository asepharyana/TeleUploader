/**
 * Sanitises a file name for use in a Content-Disposition header, removing
 * characters that could enable header injection.
 *
 * Single canonical implementation — previously only present in
 * `interfaces/http/controllers/file-controller.ts` while other download
 * paths (S3 GET, web-api) did not sanitise at all.
 *
 * @param fileName - The raw file name.
 * @returns The sanitised file name.
 */
export const sanitizeFilenameHeader = (fileName: string): string =>
  fileName.replace(/[\\"]/g, '').replace(/[\n\r]/g, '');
