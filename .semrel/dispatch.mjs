#!/usr/bin/env node
/**
 * successCmd hook for semantic-release: dispatch the deploy workflow so the
 * freshly released version is built and deployed to the VPS.
 *
 * GitHub disables workflow re-triggering for pushes made by GITHUB_TOKEN
 * (which is what @semantic-release/git uses to commit the release), so the
 * plain `push: branches: [main]` trigger in deploy.yml never fires for the
 * release commit. We dispatch deploy.yml explicitly instead.
 */

const version = (process.argv[2] || '').trim();

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('dispatch.mjs: GITHUB_TOKEN not set, skipping deploy dispatch');
    process.exit(0);
  }
  if (!version) {
    console.error('dispatch.mjs: no version argument, skipping');
    process.exit(0);
  }

  const repo = process.env.GITHUB_REPOSITORY || 'asepharyana/TeleUploader';
  const url = `https://api.github.com/repos/${repo}/actions/workflows/deploy.yml/dispatches`;

  // dispatch with branch ref main; deploy builds #teleuploader from the
  // release commit whose package.json/flake.nix already carry `version`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'semantic-release-dispatch',
    },
    body: JSON.stringify({ ref: 'main' }),
  });

  if (res.status === 204) {
    console.log(`dispatch.mjs: dispatched deploy for v${version} to ${repo} main`);
  } else {
    const body = await res.text().catch(() => '');
    console.error(`dispatch.mjs: deploy dispatch failed (HTTP ${res.status}): ${body}`);
    // Non-fatal: a user can still run the deploy workflow manually.
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('dispatch.mjs: unexpected error:', err);
  process.exit(0);
});
