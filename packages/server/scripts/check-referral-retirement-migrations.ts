#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const server = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkgPath = join(dirname(require.resolve('drizzle-kit')), 'package.json');
const cli = resolve(dirname(pkgPath), JSON.parse(readFileSync(pkgPath, 'utf8')).bin['drizzle-kit']);
const scratch = mkdtempSync(join(tmpdir(), 'raft-retirement-schema-'));
function files(root, prefix = '') {
  return Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const relative = join(prefix, entry.name), absolute = join(root, entry.name);
    return entry.isDirectory() ? Object.entries(files(absolute, relative)) : [[relative, createHash('sha256').update(readFileSync(absolute)).digest('hex')]];
  }));
}
try {
  // Load the actual project config, then isolate output. The placeholder DSN is never used by generate.
  const { default: actual } = await import(pathToFileURL(join(server, 'drizzle.config.ts')).href);
  const schema = (Array.isArray(actual.schema) ? actual.schema : [actual.schema]).map(file => resolve(server, file));
  const out = join(scratch, 'drizzle');
  cpSync(join(server, 'drizzle'), out, { recursive: true });
  const before = files(out);
  const config = join(scratch, 'config.cjs');
  writeFileSync(config, `module.exports = ${JSON.stringify({ ...actual, schema, out: relative(server, out), dbCredentials: { url: 'postgresql://synthetic@127.0.0.1:1/not_used' } })};\n`);
  const result = spawnSync(process.execPath, [cli, 'generate', '--config', config], { cwd: server, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0) throw new Error(`Migration generation failed: ${(result.stderr || result.stdout).slice(-2000)}`);
  const after = files(out);
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]);
  if (changed.length || !result.stdout.includes('No schema changes, nothing to migrate')) {
    const drops = changed.filter(file => file.endsWith('.sql') && after[file]).reduce((n, file) => n + (readFileSync(join(out, file), 'utf8').match(/DROP TABLE/gi)?.length ?? 0), 0);
    throw new Error(`Migration drift detected or generation did not finish: ${changed.join(', ')}; proposed DROP TABLE statements=${drops}. ${(result.stdout + result.stderr).slice(-1500)}`);
  }
  console.log('Actual Drizzle configuration: zero schema/migration diff; retirement schema matches its final snapshot.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
