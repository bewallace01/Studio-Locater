#!/usr/bin/env node
/**
 * Run `sanity deploy` with cwd = studio/ without a shell (paths with spaces stay intact).
 */
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const studioDir = join(root, 'studio');
const isWin = process.platform === 'win32';
const sanityBin = join(studioDir, 'node_modules', '.bin', isWin ? 'sanity.cmd' : 'sanity');

const r = spawnSync(sanityBin, ['deploy', '-y'], {
  cwd: studioDir,
  stdio: 'inherit',
  env: process.env,
  shell: false,
});

if (r.error) {
  console.error(r.error);
  process.exit(1);
}
process.exit(r.status ?? 1);
