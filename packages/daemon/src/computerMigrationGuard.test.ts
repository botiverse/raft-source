import assert from "node:assert/strict";
import { test } from "vitest";
import { LegacyDaemonKeyAdoptedByComputerError } from "./computerMigrationGuard.js";

const match = {
  attachmentPath: "/tmp/runner.state.json",
  serverId: "11111111-1111-4111-8111-111111111111",
  serverSlug: "alpha",
};

test("migration guard error gives precise detected-supervisor cleanup and Computer commands", () => {
  const error = new LegacyDaemonKeyAdoptedByComputerError(match, {
    kind: "pm2",
    detail: 'PM2 app "legacy-daemon" is supervising this legacy daemon.',
    cleanupCommands: ["pm2 delete 'legacy-daemon'", "pm2 save"],
  });

  assert.match(error.message, /^Legacy Raft daemon startup refused:/);
  assert.match(error.message, /already migrated to Raft Computer for \/alpha/);
  assert.match(error.message, /PM2 app "legacy-daemon" is supervising/);
  assert.match(error.message, /pm2 delete 'legacy-daemon'/);
  assert.match(error.message, /pm2 save/);
  assert.match(error.message, /raft-computer start \/alpha/);
  assert.match(error.message, /raft-computer status \/alpha/);
});

test("migration guard error gives PM2, systemd, and launchd fallbacks when detection is unavailable", () => {
  const error = new LegacyDaemonKeyAdoptedByComputerError(match, null);

  assert.match(
    error.message,
    /PM2: pm2 delete <legacy-daemon-app-name> && pm2 save/,
  );
  assert.match(
    error.message,
    /systemd: systemctl --user disable --now <legacy-daemon-unit>\.service/,
  );
  assert.match(error.message, /launchd: launchctl bootout gui\/\$\(id -u\)/);
  assert.match(
    error.message,
    /do not restart raft-daemon with the migrated key/,
  );
});
