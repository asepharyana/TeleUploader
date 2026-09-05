#!/usr/bin/env node
/**
 * Prepare script for semantic-release: synchronises the package version
 * across package.json and flake.nix before the release commit.
 *
 * getVersion() keeps package.json as the source of truth when semver has
 * not run yet (e.g. first bootstrap) — after that, nextRelease.version
 * is passed as argv[2] and everything is aligned to it.
 *
 * Fixes the TeleUploader Nix deploy trap: a source change without a
 * version bump made Nix reuse the same store path, so CI reported success
 * while the VPS profile stayed on the old build. By bumping flake.nix's
 * `version` on every release, the Nix derivation always changes and the
 * store path is always fresh.
 *
 * IMPORTANT: only bump the TeleUploader package version (the block whose
 * `pname = "teleuploader"` precedes it), never the Bun overlay version that
 * appears earlier in the file. Store path is derived from the
 * teleuploader package's `version`.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const nextVersion = process.argv[2];

// --- package.json ---
const pkgPath = 'package.json';
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (nextVersion) pkg.version = nextVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// --- flake.nix ---
const flakePath = 'flake.nix';
let flake = readFileSync(flakePath, 'utf8');
const target = nextVersion ?? pkg.version;

const anchor = 'pname = "teleuploader";';
const anchorIdx = flake.indexOf(anchor);
if (anchorIdx === -1) {
  throw new Error(`prepare.mjs: TeleUploader pname anchor not found in ${flakePath}`);
}
const rest = flake.slice(anchorIdx);
const verMatch = rest.match(/(\s*)version = "\d+\.\d+\.\d+";/);
if (!verMatch) {
  throw new Error(`prepare.mjs: could not locate TeleUploader version block in ${flakePath}`);
}
const replaced =
  flake.slice(0, anchorIdx) +
  rest.replace(/(\s*)version = "\d+\.\d+\.\d+";/, `$1version = "${target}";`);
if (!replaced.includes(`version = "${target}";`)) {
  throw new Error(`prepare.mjs: replacement did not land in ${flakePath}`);
}
writeFileSync(flakePath, replaced);

console.log(`prepare.mjs: versions synced to ${target}`);