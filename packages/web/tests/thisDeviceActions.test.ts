import assert from "node:assert/strict";
import type { DesktopComputerHostState } from "@botiverse/raft-shared";
import { COMPUTER_CLI_CAPABILITIES } from "@botiverse/raft-shared";
import { deriveThisDeviceState, thisDeviceActions } from "../src/components/machine/localComputer/thisDeviceLogic";
import type { ThisDeviceAction, ThisDeviceActionHost, ThisDeviceInput, ThisDeviceState, ThisDeviceStateKind } from "../src/components/machine/localComputer/thisDeviceLogic";

// No dead end (WAWQAQ, 2026-11-09, Windows, Raft Desktop 1.21.58: "Not set
// up", a grey dot and nothing to press). Every This device state, in both
// shells, with or without the installer, whatever the Computer reports it can
// do, offers at least one step, and none the real ComputerController is known
// to refuse. The "known to fail" rules below are the controller's
// (apps/desktop/src/main/computer/computerController.ts), written out
// independently of thisDeviceActions.

const FULL = [...COMPUTER_CLI_CAPABILITIES];
const CAPABILITIES: Array<{ name: string; value: string[] | null }> = [
  { name: "capabilities null", value: null },
  { name: "capabilities []", value: [] },
  { name: "capabilities full", value: FULL },
];

const BASE: DesktopComputerHostState = {
  installed: true, version: "1.0.60", capabilities: FULL, installSupported: true, startsWith: "login-item",
  stoppedByUser: false, updating: false, migration: { state: "none" }, readError: null, leftoverAttachments: false,
};

interface Scenario {
  name: string;
  input: (host: DesktopComputerHostState) => ThisDeviceInput;
  host: (capabilities: string[] | null, installSupported: boolean) => DesktopComputerHostState | null;
  running: boolean;
  checkingStalled?: boolean;
}

const input = (patch: Partial<ThisDeviceInput>): ThisDeviceInput => ({
  ready: true, host: null, status: null, enabling: false, running: false, attachedHere: true, ...patch,
});
const installed = (capabilities: string[] | null, installSupported: boolean, patch: Partial<DesktopComputerHostState> = {}): DesktopComputerHostState => ({
  ...BASE, capabilities, installSupported, readError: capabilities === null ? "computer_unreadable: status --json timed out" : null, ...patch,
});
const missing = (installSupported: boolean, patch: Partial<DesktopComputerHostState> = {}): DesktopComputerHostState => ({
  ...BASE, installed: false, version: null, capabilities: null, installSupported, ...patch,
});
const STATUS = { servers: [{ serverId: "server-1", serverSlug: "acme", machineId: "m-self" }], service: { running: true } };

/** One per state the real controller (and the web) can reach; capabilities and installSupported vary on top. */
const SCENARIOS: Scenario[] = [
  { name: "checking", running: false, host: () => null, input: () => input({ ready: false }) },
  { name: "checking, stalled", running: false, checkingStalled: true, host: () => null, input: () => input({ ready: false }) },
  { name: "not installed", running: false, host: (_c, s) => missing(s), input: (host) => input({ host }) },
  { name: "not installed, attachments left (Windows)", running: false, host: (_c, s) => missing(s, { leftoverAttachments: true }), input: (host) => input({ host }) },
  { name: "not installed, not attached here", running: false, host: (_c, s) => missing(s), input: (host) => input({ host, attachedHere: false }) },
  { name: "setting up", running: false, host: (_c, s) => missing(s), input: (host) => input({ host, enabling: true }) },
  { name: "migrating", running: true, host: (c, s) => installed(c, s, { migration: { state: "running", step: "quiet" } }), input: (host) => input({ host, status: STATUS, running: true }) },
  { name: "migration failed (not installed)", running: false, host: (_c, s) => missing(s, { migration: { state: "failed", step: "install", code: "computer_install_failed", message: "x" } }), input: (host) => input({ host }) },
  { name: "migration failed (installed)", running: false, host: (c, s) => installed(c, s, { migration: { state: "failed", step: "start", code: "START_FAILED", message: "x" } }), input: (host) => input({ host, status: STATUS }) },
  { name: "updating", running: true, host: (c, s) => installed(c, s, { updating: true }), input: (host) => input({ host, status: STATUS, running: true }) },
  { name: "running", running: true, host: (c, s) => installed(c, s), input: (host) => input({ host, status: host.capabilities === null ? null : STATUS, running: host.capabilities !== null }) },
  { name: "stopped", running: false, host: (c, s) => installed(c, s), input: (host) => input({ host, status: host.capabilities === null ? null : { ...STATUS, service: { running: false } } }) },
  { name: "stopped by the person", running: false, host: (c, s) => installed(c, s, { stoppedByUser: true }), input: (host) => input({ host, status: host.capabilities === null ? null : { ...STATUS, service: { running: false } } }) },
  { name: "update available", running: true, host: (c, s) => installed(c, s), input: (host) => input({ host, status: STATUS, running: true, updateAvailable: true }) },
  { name: "unreadable, older Raft Desktop (no readError)", running: false, host: (c, s) => { const h = installed(c, s); delete h.readError; return h; }, input: (host) => input({ host }) },
  { name: "host read failed", running: false, host: () => null, input: () => input({ hostReadFailed: true, status: { ...STATUS, service: { running: false } } }) },
  { name: "duplicate key", running: false, host: (c, s) => installed(c, s), input: (host) => input({ host, status: STATUS, lastErrorCode: "duplicate_key" }) },
];

/** The controller refuses it, or it cannot apply here. Returns why, or null. */
function knownToFail(action: ThisDeviceAction, state: ThisDeviceState, host: DesktopComputerHostState | null, ctx: ThisDeviceActionHost): string | null {
  const installSupported = host?.installSupported ?? true;
  switch (action.id) {
    case "install":
      return !ctx.can.updateComputer ? "no updateComputer" : !installSupported ? "no installer for this OS" : host?.installed ? "already installed" : null;
    case "finish-move":
      return host?.leftoverAttachments !== true ? "nothing left to move" : !installSupported ? "no installer for this OS" : null;
    case "repair":
      return !installSupported ? "no installer for this OS" : null;
    case "add":
      return !ctx.canAdd ? "Add does not apply" : null;
    case "start":
      return host === null || !host.installed ? "nothing installed to start" : ctx.running ? "already running" : null;
    case "stop":
    case "restart":
      return host === null || !host.installed ? "nothing installed" : !ctx.running ? "not running" : null;
    case "update":
    case "update-now":
      return host === null || !host.installed ? "nothing installed to update" : null;
    case "retry-migration":
      return state.kind !== "migration-failed" ? "no failed move" : null;
    case "run-diagnostics": {
      if (!host) return "what it can do is unknown (the shell may refuse)";
      if (!host.installed) return "doctor needs an installed Computer";
      if (host.capabilities === null) return host.readError === undefined ? "an older Raft Desktop refuses without capabilities" : null;
      return host.capabilities.includes("doctor-json") ? null : "computer_capability_missing:doctor-json";
    }
    case "retry-read":
    case "open-logs":
    case "install-elsewhere":
      return null;
  }
}

const seenKinds = new Set<ThisDeviceStateKind>();
for (const scenario of SCENARIOS) {
  for (const capabilities of CAPABILITIES) {
    for (const installSupported of [true, false]) {
      for (const variant of ["embedded", "standalone"] as const) {
        test(`no dead end: ${scenario.name} · ${capabilities.name} · installSupported ${installSupported} · ${variant}`, () => {
          const host = scenario.host(capabilities.value, installSupported);
          const state = deriveThisDeviceState(scenario.input(host ?? BASE));
          seenKinds.add(state.kind);
          const ctx: ThisDeviceActionHost = {
            hostState: host,
            management: host ? "host" : null,
            running: scenario.running && state.kind !== "unreadable",
            canAdd: variant === "standalone" && host !== null && (host.installSupported || host.installed) && (state.kind === "not-installed" || state.flags.notAttachedHere),
            can: { updateComputer: true, retryMigration: true, runDiagnostics: true, openLogs: true, retryRead: true },
            checkingStalled: scenario.checkingStalled === true,
          };
          const plan = thisDeviceActions(state, ctx, variant, host?.installSupported ?? true, host?.capabilities ?? null);
          assert.ok(plan.actions.length > 0, `"${state.kind}" offers nothing`);
          assert.ok(plan.actions.filter((a) => a.primary).length <= 1, "at most one first step");
          assert.equal(new Set(plan.actions.map((a) => a.id)).size, plan.actions.length, "each step once");
          // A problem opens Troubleshoot, which has Run diagnostics: never repeated in the notice.
          for (const a of plan.actions) if (a.id === "run-diagnostics") assert.equal(a.place, state.problem ? "troubleshoot" : "status");
          for (const action of plan.actions) {
            const why = knownToFail(action, state, host, ctx);
            assert.equal(why, null, `"${state.kind}" offers ${action.id}, which fails: ${why}`);
          }
          if (state.kind === "unreadable" || scenario.checkingStalled) {
            assert.equal(plan.statusMessageId, "computerHost.thisDevice.state.couldNotRead", "unknown, never a guessed \"Stopped\"");
            assert.ok(plan.actions.some((a) => a.id === "retry-read"), "Try again");
          }
        });
      }
    }
  }
}

test("the scenarios reach every state", () => {
  const all: ThisDeviceStateKind[] = ["checking", "not-installed", "setting-up", "migrating", "migration-failed", "update-required", "updating", "stopped", "running", "unreadable", "duplicate-key"];
  assert.deepEqual([...seenKinds].sort(), [...all].sort());
});

test("not installed: Install on the embedded page, Add on the standalone one; attachments left (Windows): Finish moving; no installer: Install on another computer and Open logs", () => {
  const can = { updateComputer: true, retryMigration: true, runDiagnostics: true, openLogs: true, retryRead: true };
  const ids = (host: DesktopComputerHostState, variant: "embedded" | "standalone", canAdd: boolean) =>
    thisDeviceActions(deriveThisDeviceState(input({ host })), { hostState: host, management: "host", running: false, canAdd, can }, variant, host.installSupported, host.capabilities)
      .actions.map((a) => `${a.id}${a.primary ? "*" : ""}`);
  assert.deepEqual(ids(missing(true), "embedded", false), ["install*"]);
  assert.deepEqual(ids(missing(true), "standalone", true), ["add*"]);
  assert.deepEqual(ids(missing(true, { leftoverAttachments: true }), "embedded", false), ["finish-move*", "open-logs"]);
  assert.deepEqual(ids(missing(true, { leftoverAttachments: true }), "standalone", true), ["finish-move*", "open-logs"]);
  assert.deepEqual(ids(missing(false), "embedded", false), ["install-elsewhere", "open-logs"]);
});

test("unreadable: Try again, Repair, Open logs, Run diagnostics (this Raft Desktop runs doctor without capabilities); host read failed: Try again, Repair, Open logs", () => {
  const can = { updateComputer: true, retryMigration: true, runDiagnostics: true, openLogs: true, retryRead: true };
  const host = installed(null, true);
  const ids = (h: DesktopComputerHostState | null, patch: Partial<ThisDeviceInput> = {}) =>
    thisDeviceActions(deriveThisDeviceState(input({ host: h, ...patch })), { hostState: h, management: h ? "host" : null, running: false, canAdd: false, can }, "embedded", h?.installSupported ?? true, h?.capabilities ?? null)
      .actions.map((a) => a.id);
  assert.deepEqual(ids(host), ["retry-read", "repair", "open-logs", "run-diagnostics"]);
  const legacy = { ...host };
  delete legacy.readError;
  assert.deepEqual(ids(legacy), ["retry-read", "repair", "open-logs"], "an older Raft Desktop refuses diagnostics here: not offered");
  assert.deepEqual(ids(null, { hostReadFailed: true, status: { servers: [], service: { running: false } } }), ["retry-read", "repair", "open-logs"], "the host state unread: what it can do is unknown, so no diagnostics until Try again reads it");
});
