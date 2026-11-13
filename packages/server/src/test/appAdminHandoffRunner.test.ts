import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'vitest';

test('manual runner discards inherited secrets and uses synthetic signing configuration', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-env-')));
  const core = path.join(root, 'core');
  const worker = path.join(root, 'worker');
  const bin = path.join(root, 'bin');
  const runner = fileURLToPath(new URL('../../../../scripts/integration/test-app-admin-handoff.sh', import.meta.url));
  try {
    fs.mkdirSync(path.join(core, 'packages/server/node_modules/.bin'), { recursive: true });
    fs.mkdirSync(path.join(worker, 'src'), { recursive: true });
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(worker, 'src/worker.ts'), 'export default {};\n');
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
if [ "$1" = "rev-parse" ]; then printf '%s\\n' "$TEST_CORE"; exit 0; fi
if [ "$1" = "-C" ] && [ "$3" = "rev-parse" ]; then
  if [ "$2" = "$TEST_WORKER" ]; then printf '%s\\n' "$TEST_WORKER_SHA"; else printf '%s\\n' "$TEST_CORE_SHA"; fi
  exit 0
fi
exit 0
`, { mode: 0o755 });
    fs.writeFileSync(path.join(core, 'packages/server/node_modules/.bin/vitest'), `#!/bin/sh
[ "\${REVIEW_FAKE_TOKEN+x}" != x ] || exit 40
[ "\${REVIEW_OTHER_SECRET+x}" != x ] || exit 41
[ "$JWT_SECRET" = 'test-jwt-secret' ] || exit 42
[ "$NODE_ENV" = 'test' ] || exit 43
[ -n "$APP_ADMIN_WORKER_ENTRY" ] || exit 44
echo 'synthetic environment accepted'
`, { mode: 0o755 });
    const coreSha = 'a'.repeat(40);
    const workerSha = 'b'.repeat(40);
    const result = spawnSync('/bin/bash', [runner, worker, coreSha, workerSha], {
      cwd: core,
      env: { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, TEST_CORE: core,
        TEST_WORKER: worker, TEST_CORE_SHA: coreSha, TEST_WORKER_SHA: workerSha,
        REVIEW_FAKE_TOKEN: 'fixture-only', REVIEW_OTHER_SECRET: 'fixture-only', JWT_SECRET: 'fixture-only' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /synthetic environment accepted/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
