import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentMachineRow } from "../src/utils/agentMachineRow.js";

// task #259 (artin, 2026-09-04, both web and mobile): the Computer row is not rendered while the
// machine store has no snapshot yet; "No computer assigned" is a conclusion, not a placeholder.

const mbp = { id: "computer-mbp" };
const studio = { id: "computer-studio" };

test("no machineId means no computer, whatever the store is doing", () => {
  assert.deepEqual(resolveAgentMachineRow(null, [], "loading"), { kind: "none" });
  assert.deepEqual(resolveAgentMachineRow(undefined, [mbp], "loaded"), { kind: "none" });
  assert.deepEqual(resolveAgentMachineRow("", [mbp], "loaded"), { kind: "none" });
});

test("a machine the store has is returned, even during a refresh", () => {
  assert.deepEqual(resolveAgentMachineRow("computer-mbp", [studio, mbp], "loaded"), { kind: "machine", machine: mbp });
  // a refresh keeps cached rows visible; a found machine is never pending
  assert.deepEqual(resolveAgentMachineRow("computer-mbp", [mbp], "loading"), { kind: "machine", machine: mbp });
});

test("pending — not 'No computer assigned' — while the first snapshot is still loading", () => {
  // Old code: `agentMachine ? ... : noComputerAssigned` flashed the italic text on every open.
  assert.deepEqual(resolveAgentMachineRow("computer-mbp", [], "loading"), { kind: "pending" });
});

test("still pending when the first load failed with nothing cached", () => {
  assert.deepEqual(resolveAgentMachineRow("computer-mbp", [], "error"), { kind: "pending" });
});

test("'no computer' is concluded only once the store is loaded and the id is absent", () => {
  assert.deepEqual(resolveAgentMachineRow("computer-missing", [mbp, studio], "loaded"), { kind: "none" });
  assert.deepEqual(resolveAgentMachineRow("computer-missing", [], "loaded"), { kind: "none" });
});
