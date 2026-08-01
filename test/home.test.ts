import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { handleHome, resolveHomeHtml } from '../src/interfaces/http/controllers/home-controller';

describe('resolveHomeHtml', () => {
  let root: string;

  const makeLayout = (tree: Record<string, string>) => {
    root = mkdtempSync(join(tmpdir(), 'home-resolver-'));
    for (const [rel, content] of Object.entries(tree)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return root;
  };

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('resolves home.html beside dist/ — prod Nix layout', () => {
    makeLayout({
      'dist/index.js': 'x',
      'home.html': '<html>prod</html>',
    });
    expect(resolveHomeHtml(join(root, 'dist'))).toBe(join(root, 'home.html'));
  });

  it('resolves src/home.html from controllers dir — dev layout', () => {
    makeLayout({
      'src/home.html': '<html>dev</html>',
      'src/interfaces/http/controllers/home-controller.ts': 'x',
    });
    expect(resolveHomeHtml(join(root, 'src/interfaces/http/controllers'))).toBe(
      join(root, 'src/home.html'),
    );
  });

  it('returns null when home.html is not found within the walk bound', () => {
    makeLayout({ 'dist/index.js': 'x' });
    expect(resolveHomeHtml(join(root, 'dist'))).toBeNull();
  });
});

describe('handleHome', () => {
  it('serves the dashboard HTML with 200 and text/html', async () => {
    // handleHome resolves from the real source tree: src/home.html must exist.
    const srcHome = join(import.meta.dir, '..', 'src', 'home.html');
    expect(existsSync(srcHome)).toBe(true);

    const res = await handleHome();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('FileDrop · S3 File Manager');
  });
});
