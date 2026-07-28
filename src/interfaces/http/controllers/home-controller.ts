import type { BunFile } from 'bun';

/**
 * Handles the home/dashboard page request.
 *
 * Reads the `home.html` file from the adjacent directory and serves it as
 * an HTML response with UTF-8 charset.
 *
 * @returns An HTML response containing the home page content.
 */
export const handleHome = async (): Promise<Response> => {
  const html = await (Bun.file(`${import.meta.dir}/home.html`) as BunFile).text();
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
    },
  });
};