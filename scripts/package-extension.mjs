#!/usr/bin/env node
// Stage the Chrome extension runtime files into dist/extension and zip them
// into dist/extension.zip. Only allowlisted files are included, and every file
// referenced by manifest.json / importScripts() must exist in the staged output.
//
// Usage:
//   node scripts/package-extension.mjs              # stage + zip
//   node scripts/package-extension.mjs --stage-only # stage + validate, no zip
//
// When run from a tag (GITHUB_REF_TYPE=tag), the tag must equal "v" + manifest version.

import { readFileSync, mkdirSync, rmSync, copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const stageDir = join(distDir, 'extension');
const zipPath = join(distDir, 'extension.zip');
const stageOnly = process.argv.includes('--stage-only');

// Only files the extension runtime needs. server/, mcp/, test/, tools/, agents/,
// node_modules/, docs and secrets are intentionally NOT listed.
const FILES = [
  'manifest.json',
  'background.js',
  'calendar-sync.js',
  'calendar-content.js',
  'content.js',
  'course-downloader.js',
  'course-downloader.css',
  'course-scan.js',
  'crypto-vault.js',
  'decaptcha.js',
  'decaptcha.model.js',
  'captcha-kit.js',
  'captcha-autofill.js',
  'ccxp-captcha.js',
  'ccxp-captcha-model.js',
  'ccxp-autologin.js',
  'login-state.js',
  'login-probe.html',
  'login-probe.js',
  'eeclass-extension-server.js',
  'eeclass-home-autologin.js',
  'elearn-home-autologin.js',
  'eeclass-live.js',
  'eeclass-transport.js',
  'eeclass-ui.js',
  'library-autologin.js',
  'library-captcha-model.js',
  'library-captcha.js',
  'mcp-bridge-client.js',
  'options.html',
  'options.css',
  'options.js',
  'setup-guide.html',
  'setup-guide.js',
  'consent.html',
  'consent.css',
  'consent.js',
  'swagger.html',
  'swagger.css',
  'swagger.js',
  'swagger-spec.js',
  'swagger-spec.json',
];
const DIRS = ['assets', 'api', 'vendor'];

const fail = (msg) => {
  console.error(`::error::${msg}`);
  process.exit(1);
};

// ---- 1. Read manifest and check version against tag -------------------------
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const expected = `v${manifest.version}`;
  if (process.env.GITHUB_REF_NAME !== expected) {
    fail(`Tag ${process.env.GITHUB_REF_NAME} does not match manifest version ${manifest.version} (expected ${expected})`);
  }
}

// ---- 2. Stage allowlisted files --------------------------------------------
rmSync(distDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

for (const file of FILES) {
  const src = join(root, file);
  if (!existsSync(src)) fail(`Allowlisted file missing from repo: ${file}`);
  const dest = join(stageDir, file);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}

function copyDir(relDir) {
  const src = join(root, relDir);
  if (!existsSync(src)) fail(`Allowlisted directory missing from repo: ${relDir}`);
  for (const entry of readdirSync(src)) {
    const rel = posix.join(relDir, entry);
    if (statSync(join(root, rel)).isDirectory()) {
      copyDir(rel);
    } else {
      const dest = join(stageDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(root, rel), dest);
    }
  }
}
for (const dir of DIRS) copyDir(dir);

// ---- 3. Validate that every reference resolves inside the staged output ---
const refs = new Set();
const addRef = (p) => {
  if (typeof p === 'string' && p) refs.add(p.split('?')[0]);
};

addRef(manifest.background?.service_worker);
addRef(manifest.action?.default_popup);
addRef(manifest.side_panel?.default_path);
addRef(manifest.options_ui?.page);
Object.values(manifest.icons ?? {}).forEach(addRef);
for (const cs of manifest.content_scripts ?? []) {
  (cs.js ?? []).forEach(addRef);
  (cs.css ?? []).forEach(addRef);
}
for (const war of manifest.web_accessible_resources ?? []) {
  for (const r of war.resources ?? []) {
    if (!r.includes('*')) addRef(r); // globs are validated by the directory copy above
  }
}

// importScripts("a.js", "b.js") in the service worker
const bgSource = readFileSync(join(root, manifest.background?.service_worker ?? 'background.js'), 'utf8');
for (const m of bgSource.matchAll(/importScripts\(([^)]*)\)/g)) {
  for (const s of m[1].matchAll(/["']([^"']+)["']/g)) addRef(s[1]);
}

const missing = [...refs].filter((r) => !existsSync(join(stageDir, r)));
if (missing.length) fail(`Referenced by manifest/importScripts but not staged: ${missing.join(', ')}`);

console.log(`Staged ${FILES.length} files + ${DIRS.length} dirs; ${refs.size} references verified.`);

// ---- 4. Zip -----------------------------------------------------------------
if (stageOnly) {
  console.log('--stage-only: skipping zip.');
  process.exit(0);
}

// Zip from inside the stage dir so manifest.json sits at the archive root.
execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: stageDir, stdio: 'inherit' });
const sizeKB = Math.round(statSync(zipPath).size / 1024);
console.log(`Created ${zipPath} (${sizeKB} KB)`);
