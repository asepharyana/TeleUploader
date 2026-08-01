import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BunFile } from 'bun';

/**
 * Maximum number of parent directories to walk up when locating home.html.
 * Deep enough for the dev layout (controllers/ -> src/ = 4 levels) with margin.
 */
const MAX_PARENT_WALK = 6;

/**
 * Resolves the absolute path to `home.html` by walking up from `startDir`.
 *
 * The file lives at different depths depending on how the app is run:
 * - Dev (`bun --hot src/index.ts`): `import.meta.dir` is
 *   `src/interfaces/http/controllers/`, home.html lives at `src/home.html`
 *   (4 levels up).
 * - Prod (bundled `dist/index.js`): `import.meta.dir` is
 *   `$out/share/teleuploader/dist/`, home.html lives next to dist/
 *   (1 level up, per flake.nix installPhase).
 *
 * Returns the first existing candidate, or `null` if none is found within
 * the walk bound.
 *
 * @param startDir - Directory to start the search from (typically `import.meta.dir`).
 * @param maxDepth - Maximum number of parent directories to walk (default: 6).
 * @returns Absolute path to home.html, or `null` if not found.
 */
export const resolveHomeHtml = (startDir: string, maxDepth = MAX_PARENT_WALK): string | null => {
  let dir = startDir;
  for (let depth = 0; depth <= maxDepth; depth++) {
    const candidate = join(dir, 'home.html');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

/**
 * Handles the home/dashboard page request.
 *
 * Reads the `home.html` file and serves it as an HTML response with UTF-8
 * charset. Fails fast with a clear error when the file cannot be located
 * instead of letting Bun.serve swallow the ENOENT into a bare 500.
 *
 * @returns An HTML response containing the home page content.
 */
export const handleHome = async (): Promise<Response> => {
  const homeHtml = resolveHomeHtml(import.meta.dir);
  if (!homeHtml) {
    throw new Error(
      `home.html not found — looked up from ${import.meta.dir} and ${MAX_PARENT_WALK} parent dirs`,
    );
  }
  const html = await (Bun.file(homeHtml) as BunFile).text();
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
    },
  });
};
