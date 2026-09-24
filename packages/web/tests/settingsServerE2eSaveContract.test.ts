import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const e2eSource = readFileSync(
  new URL("./e2e/tests/settings-server.spec.ts", import.meta.url),
  "utf8",
);
const settingsSource = readFileSync(
  new URL("../src/components/settings/SettingsPanel.tsx", import.meta.url),
  "utf8",
);

function ownerProfileSaveTestSource() {
  const start = e2eSource.indexOf('test("owner: profile name Save button gates on dirty state"');
  const end = e2eSource.indexOf('test("member: profile is read-only', start);
  assert.ok(start >= 0 && end > start, "owner profile-name E2E test must remain discoverable");
  return e2eSource.slice(start, end);
}

test("server profile E2E waits for the exact write instead of treating disabled as completion", () => {
  const source = ownerProfileSaveTestSource();
  const armResponse = source.indexOf("const profileUpdateResponsePromise = page.waitForResponse");
  const clickSave = source.indexOf("await save.click()");
  const awaitResponse = source.indexOf("await profileUpdateResponsePromise");
  const assertSaved = source.indexOf('toHaveAttribute("data-save-state", "saved")');
  const readPersisted = source.indexOf("// Confirm persisted via an independent API read.");

  assert.ok(
    armResponse >= 0
      && armResponse < clickSave
      && clickSave < awaitResponse
      && awaitResponse < assertSaved
      && assertSaved < readPersisted,
    "profile save must arm the PATCH observer before click and await PATCH + saved UI state before readback",
  );
  assert.match(source, /response\.request\(\)\.method\(\) === "PATCH"/);
  assert.match(source, /new URL\(response\.url\(\)\)\.pathname === `\/api\/servers\/\$\{seedState\.server\.id\}`/);
  assert.match(source, /expect\(profileUpdateResponse\.ok\(\)\)\.toBe\(true\)/);
});

test("server profile E2E restores shared seed state from finally and checks the restore response", () => {
  const source = ownerProfileSaveTestSource();
  const finallyBlock = source.indexOf("} finally {");
  const restoreWrite = source.indexOf("const restoreResponse = await request.patch", finallyBlock);
  const restoreCheck = source.indexOf("await assertApiOk(restoreResponse", restoreWrite);

  assert.ok(
    finallyBlock >= 0 && finallyBlock < restoreWrite && restoreWrite < restoreCheck,
    "shared server-name cleanup must be awaited inside finally and fail loud on restore failure",
  );
});

test("server profile exposes distinct dirty, saving, saved, and pristine test states", () => {
  assert.match(
    settingsSource,
    /data-save-state=\{saving \? "saving" : saved \? "saved" : dirty \? "dirty" : "pristine"\}/,
  );
});
