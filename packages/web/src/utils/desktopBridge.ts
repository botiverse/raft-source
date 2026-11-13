// The one typed way into Raft Desktop's preload bridge (`window.raftDesktop`,
// apps/desktop/src/app/preload.ts). Its shape is the shared contract
// (packages/shared desktopBridge.ts) the preload is checked against, so a
// renamed capability is a type error here instead of a silent no-op. Null in a
// browser, the phone app and tests that install none.
import type { RaftDesktopBridge } from "@botiverse/raft-shared";

export type { RaftDesktopBridge };

type BridgeHost = { raftDesktop?: RaftDesktopBridge };

export function getDesktopBridge(): RaftDesktopBridge | null {
  // The preload exposes it on the page's window (= globalThis in a renderer;
  // some test environments stub `window` separately).
  const fromWindow = typeof window !== "undefined" ? (window as BridgeHost).raftDesktop : undefined;
  return fromWindow ?? (globalThis as BridgeHost).raftDesktop ?? null;
}

/**
 * Whether window.open can give the user a second in-app window or tab: yes in
 * a browser, no in a host that declares otherwise (Raft Desktop's
 * facts.canOpenNewWindow is false: it has no tabs and denies in-app windows).
 */
export function hostCanOpenNewWindow(): boolean {
  return getDesktopBridge()?.facts?.canOpenNewWindow !== false;
}
