// packages/desktop-contract/src/capabilities.ts
// Capability IDs — shared between desktop and frontend.

/** Capability IDs. Each maps to a Tauri command set. */
export const CAPABILITY_IDS = [
  "desktop.handshake",
  "window.focus",
  "window.bindServer",
  // Reserved for future phases:
  // "window.navigate",
  // "notification.subscribe",
  // "session.getOpaqueHandle",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** Window label patterns for Tauri capability configuration. */
export const WINDOW_LABEL_PATTERNS = {
  /** Official renderer windows — narrow capability allowlist. */
  server: "server-*",
  /** Preview renderer windows — zero privileged IPC. */
  preview: "preview-*",
  /** Native recovery page — no web content IPC. */
  recovery: "recovery",
} as const;

/** Canonical remote origins for Tauri configuration. */
export const OFFICIAL_ORIGIN = "https://app.raft.build";
export const API_ORIGIN = "https://api.raft.build";

/** Fixed manifest path on canonical origin. */
export const MANIFEST_PATH = "/desktop-manifest.json";
