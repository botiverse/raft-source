import assert from "node:assert/strict";
import { EX_CONFIG_EXIT_CODE, residentPrivacyModeOrExit } from "./service";

// A runner's RAFT_PRIVACY_MODE: an invalid value exits EX_CONFIG (degraded, not
// restarted on the crash budget), never a plain crash.
class Exited extends Error {
  constructor(readonly code: number) { super(`exit ${code}`); }
}
const exit = (code: number): never => { throw new Exited(code); };

test("unset is off and on is on, without exiting", () => {
  assert.equal(residentPrivacyModeOrExit({}, exit), false);
  assert.equal(residentPrivacyModeOrExit({ RAFT_PRIVACY_MODE: "on" }, exit), true);
});

test("an invalid value exits with EX_CONFIG", () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  const written: string[] = [];
  process.stderr.write = ((chunk: string) => { written.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    assert.throws(() => residentPrivacyModeOrExit({ RAFT_PRIVACY_MODE: "sometimes" }, exit), (err: unknown) => err instanceof Exited && err.code === EX_CONFIG_EXIT_CODE);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.match(written.join(""), /RAFT_PRIVACY_MODE/);
});
