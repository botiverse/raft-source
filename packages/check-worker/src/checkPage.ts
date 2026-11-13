// What a check needs of a browser, and nothing more (check.ts drives it; browser.ts is the
// one implementation, over Cloudflare's puppeteer; the tests fake it). A browser offers
// fresh contexts only: there is no way here to open a page in its default context, so every
// check's tab starts with no cookies, storage or cache of anyone's (isolation condition 2), in a
// browser session launched for it or one an earlier check left running (pool.ts).
import type { ArtifactCheckViewport } from "@botiverse/raft-shared/src/artifactCheckContract";

import type { GuardedRequest } from "./navigation";
import type { PageMeasure } from "./pageChecks";

/** How the tab's one navigation, to the ticket, ended. */
export type OpenResult =
  /** The document's `load` fired; `status` is its HTTP status (null when the browser gave none). */
  | { kind: "loaded"; status: number | null }
  | { kind: "timeout" }
  /** A code-shaped class (report.ts errorClassOf), never the browser's message. */
  | { kind: "error"; errorClass: string };

export interface CheckPage {
  /** Turns request interception on: each request goes on when `decide` says so, else is aborted. Before `open`. */
  guardRequests(decide: (request: GuardedRequest) => boolean): Promise<void>;
  /** A console message of type error: its text, its source URL and its 1-based line (null when unknown). */
  onConsoleError(handler: (message: string, source: string | null, line: number | null) => void): void;
  /** An uncaught exception or unhandled rejection: its message, and where it was thrown (its URL and 1-based line; null when unknown). */
  onPageError(handler: (message: string, source: string | null, line: number | null) => void): void;
  /** A resource that didn't load: refused by the page's CSP, aborted by the guard, or failed on the network. */
  onBlocked(handler: (url: string) => void): void;
  /**
   * Emulates `viewport` (its CSS size, device pixel ratio, touch and mobile
   * flags) and, when given, a user agent, without reloading the page (the
   * ticket opens once).
   */
  emulate(viewport: ArtifactCheckViewport, userAgent: string | null): Promise<void>;
  /** The tab's one top-level navigation: to `url`, until `load` or `timeoutMs`. Never throws. */
  open(url: string, timeoutMs: number): Promise<OpenResult>;
  /** Resolves once no request ran for `idleMs`, or after `timeoutMs` either way. Never throws. */
  networkIdle(idleMs: number, timeoutMs: number): Promise<void>;
  /**
   * What Porthole's shell says of its handshake (Porthole P139): the document root's
   * `data-porthole-host` (kept when the page's document replaces the shell's body), "none" on a tab as soon as the shell runs; null where the page
   * took it off (a shell before P139, no longer served, said nothing). The page's own word: it only decides when the shots are taken.
   */
  shellHost(): Promise<string | null>;
  measure(): Promise<PageMeasure>;
  /** A PNG of the viewport only (never the full page), at the emulated device scale (the phone's 390×844 @2x: 780×1688). */
  screenshot(): Promise<Uint8Array>;
}

export interface CheckContext {
  newPage(): Promise<CheckPage>;
  /** Closes the context and every page in it, its cookies and storage gone with it. */
  close(): Promise<void>;
}

export interface CheckBrowser {
  /** Whether the session was left running by an earlier check (pool.ts) or launched for this one. */
  readonly origin: "reused" | "launched";
  /** A fresh (incognito) context: no cookies, storage or cache shared with any other. */
  newContext(): Promise<CheckContext>;
  /**
   * After the check, once its contexts are closed: the session left running for a later check,
   * or closed (pool.ts keepAfterCheck). Closed whenever `healthy` is false or a context this
   * browser made is still open, but never under another check: then only disconnected ("left").
   * Never throws.
   */
  release(healthy: boolean): Promise<"kept" | "closed" | "left">;
}
