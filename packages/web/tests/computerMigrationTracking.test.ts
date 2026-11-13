import assert from "node:assert/strict";
import { vi } from "vitest";
import type { DesktopComputerBridge, DesktopComputerHostState, DesktopComputerMigrationReport } from "@botiverse/raft-shared";

// Raft Desktop's move to the official Computer (AndyLok, 2026-11-08): Desktop
// records one report per attempt; a window leases them, sends each through
// trackEvent (its own batch, its report_id as the uuid), and acks only the
// ones the server took. Anything the registry refuses is never sent.

type Tracked = { event: string; props: Record<string, unknown>; options: { serverId?: string; uuid?: string; onDelivery?: (delivered: boolean) => void } };
const tracked = vi.hoisted(() => [] as Tracked[]);
const flushes = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/analytics/track", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/analytics/track")>()),
  trackEvent: (event: string, props: Record<string, unknown>, options: Tracked["options"] = {}) => { tracked.push({ event, props, options }); },
  flushProductEvents: async () => { flushes.count += 1; },
}));

const { startComputerMigrationReporting } = await import("../src/analytics/computerMigration");

const properties = {
  operation_id: "3f2b6c1e-8a4d-4f7e-9b1a-2c3d4e5f6a7b",
  report_id: "9d1c2b3a-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
  outcome: "still_finishing",
  step: "install",
  error_code: "computer_install_still_finishing",
  proxy: "system",
  platform: "darwin-arm64",
  desktop_version: "1.21.58",
  attempt: 1,
  duration_ms: 1200,
  ended_at: 1_793_000_100_000,
};
const report = (patch: Record<string, unknown> = {}): DesktopComputerMigrationReport => ({ event: "desktop_computer_migration_finished", properties: { ...properties, ...patch } as Record<string, string | number> });

/** Desktop's side: one outbox, leased to one claimer at a time (no expiry here). */
function fakeDesktop(initial: DesktopComputerMigrationReport[]) {
  let outbox = [...initial];
  const leased = new Set<string>();
  const acks: Array<[string, string[]]> = [];
  let push: ((state: DesktopComputerHostState) => void) | null = null;
  let leases = 0;
  const computer = {
    claimMigrationReports: async () => {
      leases += 1;
      const leaseId = `lease-${leases}`;
      const reports = outbox.filter((r) => !leased.has(String(r.properties.report_id)));
      for (const r of reports) leased.add(String(r.properties.report_id));
      return { leaseId, reports };
    },
    ackMigrationReports: async (leaseId: string, ids: string[]) => {
      acks.push([leaseId, ids]);
      outbox = outbox.filter((r) => !ids.includes(String(r.properties.report_id)));
    },
    onHostState: (handler: (state: DesktopComputerHostState) => void) => {
      push = handler;
      return () => { push = null; };
    },
  } as unknown as DesktopComputerBridge;
  return {
    computer,
    acks,
    get outbox() { return outbox; },
    add(r: DesktopComputerMigrationReport) {
      outbox.push(r);
      push?.({ migrationReportsPending: 1 } as DesktopComputerHostState);
    },
    /** The lease ran out unacked. */
    expire() {
      leased.clear();
      push?.({ migrationReportsPending: outbox.length } as DesktopComputerHostState);
    },
    get subscribed() { return push !== null; },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => { tracked.length = 0; flushes.count = 0; });

test("each leased report is sent to the window's server with its report_id as uuid, flushed at once, and acked only once delivered", async () => {
  const desktop = fakeDesktop([report()]);
  const stop = startComputerMigrationReporting(desktop.computer, "server-1");
  await settle();
  assert.equal(tracked.length, 1);
  assert.deepEqual(tracked[0].props, properties);
  assert.equal(tracked[0].options.serverId, "server-1");
  assert.equal(tracked[0].options.uuid, properties.report_id);
  assert.equal(flushes.count, 1, "flushed now, not in 10 s");
  assert.deepEqual(desktop.acks, [], "not acked before the server answered");
  tracked[0].options.onDelivery!(true);
  await settle();
  assert.deepEqual(desktop.acks, [["lease-1", [properties.report_id]]]);
  assert.deepEqual(desktop.outbox, []);
  stop();
  assert.equal(desktop.subscribed, false);
});

test("a batch that failed (or a window that closed before the answer) is not acked: the report comes back after its lease, same report_id, and is acked then", async () => {
  const desktop = fakeDesktop([report()]);
  startComputerMigrationReporting(desktop.computer, "server-1");
  await settle();
  tracked[0].options.onDelivery!(false);
  await settle();
  assert.deepEqual(desktop.acks, []);
  assert.equal(desktop.outbox.length, 1, "kept by Desktop");
  desktop.expire();
  await settle();
  assert.equal(tracked.length, 2, "offered again");
  assert.equal(tracked[1].options.uuid, properties.report_id, "the same event: ingest drops a repeat");
  tracked[1].options.onDelivery!(true);
  await settle();
  assert.deepEqual(desktop.acks, [["lease-2", [properties.report_id]]]);
});

test("the settled attempt after still_finishing follows with the same operation_id", async () => {
  const desktop = fakeDesktop([report()]);
  startComputerMigrationReporting(desktop.computer, "server-1");
  await settle();
  desktop.add(report({ outcome: "succeeded", step: "verify", error_code: undefined, attempt: 2, report_id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" }));
  await settle();
  assert.equal(tracked.length, 2);
  assert.equal(tracked[1].props.outcome, "succeeded");
  assert.equal(tracked[1].props.operation_id, properties.operation_id);
});

test("a report outside the registry's lists is never sent", async () => {
  const bad: DesktopComputerMigrationReport[] = [
    report({ error_code: "EACCES: open /Users/bob" }),
    report({ proxy: "http://10.0.0.7:7890" }),
    report({ machine_id: "m1" }),
    report({ attempt: 21 }),
    { event: "page_viewed", properties: { route: "channel" } } as unknown as DesktopComputerMigrationReport,
  ];
  startComputerMigrationReporting(fakeDesktop(bad).computer, "server-1")();
  await settle();
  assert.deepEqual(tracked, []);
});

test("off the desktop, or a Desktop without the capability: nothing is claimed or sent", async () => {
  startComputerMigrationReporting(null, "server-1")();
  startComputerMigrationReporting({} as DesktopComputerBridge, "server-1")();
  await settle();
  assert.deepEqual(tracked, []);
});
