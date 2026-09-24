// Injects the desktop "This Computer" self-card into the REUSED web Sidebar's
// Computers list WITHOUT modifying packages/web (shared with web + mobile).
//
// The desktop adapts the rendered DOM at runtime instead of editing web source:
//   - it acts only while the Computers rail is active (useRailMode, a @web hook,
//     so no DOM sniffing to decide *when*);
//   - it inserts a host node at the top of the computers list (under the section
//     header, above the rows) and React-portals <ThisComputerCard/> into it;
//   - a MutationObserver re-places the host if the reused list's React
//     reconciliation drops or reorders our foreign node;
//   - it injects a <style> that hides the self machine's duplicate ComputerRow
//     (data-testid="computer-list-item-<id>"), since the card *is* that row.
//
// Fully inert on web / non-host builds: no bridge → nothing mounts.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRailMode } from "@web/hooks/useSidebarTab";
import ThisComputerCard from "./ThisComputerCard";
import { getComputerBridge, useSelfMachine } from "./useSelfComputer";

const SCROLL_SURFACE = '[data-testid="sidebar-scroll-surface"]';
const COMPUTER_ROW = '[data-testid^="computer-list-item-"]';

export function DesktopSelfComputerMount() {
  const bridge = getComputerBridge();
  const { railMode } = useRailMode();
  const active = !!bridge && railMode === "computers";
  const self = useSelfMachine();
  const selfId = self?.id ?? null;
  const [host, setHost] = useState<HTMLElement | null>(null);

  // Maintain the portal host at the top of the reused computers list.
  useEffect(() => {
    if (!active) {
      setHost(null);
      return;
    }
    // The scroll surface's inner wrapper (min-h-full) is the direct parent of
    // the computers section's header + rows.
    const container = document.querySelector(SCROLL_SURFACE)?.firstElementChild as HTMLElement | null;
    if (!container) {
      setHost(null);
      return;
    }
    const node = document.createElement("div");
    node.setAttribute("data-raft-desktop-self-card", "");

    // Place the host under the section header, above any rows: before the first
    // ComputerRow if present, else as the last child (after the header). Only
    // moves when out of place, so re-runs are cheap and don't churn the observer.
    const place = () => {
      const firstRow = container.querySelector(COMPUTER_ROW);
      if (firstRow) {
        if (firstRow.previousElementSibling !== node) container.insertBefore(node, firstRow);
      } else if (node !== container.lastElementChild) {
        container.appendChild(node);
      }
    };
    place();
    setHost(node);

    const observer = new MutationObserver(() => {
      // Disconnect while we mutate so our own insert doesn't re-trigger us.
      observer.disconnect();
      place();
      observer.observe(container, { childList: true });
    });
    observer.observe(container, { childList: true });

    return () => {
      observer.disconnect();
      node.remove();
      setHost(null);
    };
  }, [active]);

  // Hide the self machine's duplicate row while the card represents it.
  useEffect(() => {
    if (!active || !selfId) return;
    const style = document.createElement("style");
    style.setAttribute("data-raft-desktop-self-dedup", "");
    style.textContent =
      `html[data-raft-desktop-shell="electron"] [data-testid="computer-list-item-${selfId}"]{display:none !important;}`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [active, selfId]);

  return host ? createPortal(<ThisComputerCard />, host) : null;
}
