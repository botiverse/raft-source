// Raft Desktop's move from its embedded Computer to the official raft-computer
// (RFC-067 `desktop_computer_migration_finished`; design approved by AndyLok,
// 2026-11-08). Desktop records one report per attempt's final result
// (apps/desktop/src/main/computer/migrationTelemetry.ts) and says in its host
// state how many are unsent (`migrationReportsPending`); product events leave
// only from here, so a window inside a server leases them, sends them through
// trackEvent (behind the same "share usage data" and workspace switches as
// every other event), flushes at once, and acks each report whose own batch
// the server accepted. One that is not acked (this window closed or reloaded,
// the network or the server refused) is offered again when its lease runs
// out, and on Desktop's next launch; its `report_id` is the event's uuid, so
// a repeat is dropped at ingest. Each report is checked against the registry
// again: anything else is never sent.

import { useEffect } from "react";
import { validateProductEvent } from "@botiverse/raft-shared";
import type { DesktopComputerBridge, DesktopComputerMigrationReport, ProductEventProperties } from "@botiverse/raft-shared";
import { getDesktopBridge } from "../utils/desktopBridge";
import { useServerStore } from "../store/serverStore";
import { flushProductEvents, trackEvent } from "./track";

const EVENT = "desktop_computer_migration_finished";

/**
 * Lease Desktop's unsent reports now, and whenever its host state says there
 * are more (one whose lease ran out unacked included), send each in a batch of
 * its own to `serverId`, and ack each one whose batch was accepted. Returns
 * the unsubscribe.
 */
export function startComputerMigrationReporting(computer: DesktopComputerBridge | null | undefined, serverId: string): () => void {
  if (!computer || typeof computer.claimMigrationReports !== "function" || typeof computer.ackMigrationReports !== "function") return () => {};
  let alive = true;
  let claiming = false;
  let again = false;
  const send = (leaseId: string, report: DesktopComputerMigrationReport) => {
    if (report?.event !== EVENT || !report.properties || typeof report.properties !== "object") return;
    // Refused by the registry: never sent. Not acked either: Desktop gives it up after a few leases.
    if (!validateProductEvent(EVENT, report.properties, "desktop").ok) return;
    const reportId = String(report.properties.report_id);
    trackEvent(EVENT, report.properties as unknown as ProductEventProperties<typeof EVENT>, {
      serverId,
      // A report sent again (its earlier ack was lost) is the same event: ingest drops the repeat.
      uuid: reportId,
      onDelivery: (delivered) => {
        // Not delivered: no ack; the lease runs out and Desktop offers it again.
        if (delivered) void computer.ackMigrationReports!(leaseId, [reportId]).catch(() => undefined);
      },
    });
  };
  const claim = () => {
    if (!alive) return;
    if (claiming) {
      again = true;
      return;
    }
    claiming = true;
    void computer.claimMigrationReports!()
      .then((lease) => {
        const reports = Array.isArray(lease?.reports) ? lease.reports : [];
        if (typeof lease?.leaseId !== "string" || reports.length === 0) return;
        // Leased to us: ours to send even if this window just switched server.
        for (const report of reports) send(lease.leaseId, report);
        void flushProductEvents();
      })
      .catch(() => undefined)
      .finally(() => {
        claiming = false;
        if (again) {
          again = false;
          claim();
        }
      });
  };
  claim();
  const unsubscribe = typeof computer.onHostState === "function"
    ? computer.onHostState((state) => { if ((state?.migrationReportsPending ?? 0) > 0) claim(); })
    : () => {};
  return () => {
    alive = false;
    unsubscribe();
  };
}

/** Mounted once inside a server (MainLayout): off the desktop, nothing happens. */
export function useComputerMigrationReporting(): void {
  const serverId = useServerStore((s) => s.current?.id);
  useEffect(() => {
    if (!serverId) return;
    let computer: DesktopComputerBridge | null | undefined;
    try {
      computer = getDesktopBridge()?.computer;
    } catch {
      return;
    }
    return startComputerMigrationReporting(computer, serverId);
  }, [serverId]);
}
