// Trust the OS certificate store for this process's outbound TLS.
//
// Node verifies TLS only against its bundled Mozilla roots (plus
// NODE_EXTRA_CA_CERTS), not the OS trust store. Behind a TLS-re-signing proxy
// whose CA the owner installed system-wide, every Computer/daemon HTTPS call
// (server API, WebSocket, Hands release downloads) then fails with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE, while curl, browsers and the Rust installer
// on the same machine work. Node 24 can read the OS store
// (`tls.getCACertificates("system")`) and replace the default CA list every
// TLS client without an explicit `ca` uses (`tls.setDefaultCACertificates`).
//
// Call once at process start, before any network I/O: TLS contexts already
// created keep the list they were built with. Best-effort: on a Node without
// these APIs, or if reading the store throws, Node's defaults stay as they
// were and the outcome is recorded (never thrown) for a startup trace.
// Node-only (imports node:tls); never import it from a browser bundle.
import { X509Certificate } from "node:crypto";
import { performance } from "node:perf_hooks";
import tls from "node:tls";

export type SystemCaTrustOutcome =
  | {
    status: "installed";
    /** Entries the OS store returned (may repeat a cert). */
    systemCaCount: number;
    /** Certs (by SHA-256 fingerprint) the default list did not have. */
    addedCaCount: number;
    /** Store entries that did not parse; kept, compared by trimmed PEM. */
    unparsableCaCount: number;
    durationMs: number;
  }
  | { status: "unsupported"; durationMs: number }
  | { status: "failed"; errorClass: string; durationMs: number };

export interface SystemCaTrustDeps {
  /** Bundled roots + NODE_EXTRA_CA_CERTS, as PEM strings. */
  getDefaultCerts?: () => readonly string[];
  /** The OS trust store, as PEM strings. Injected in tests. */
  getSystemCerts?: () => readonly string[];
  setDefaultCerts?: (certs: string[]) => void;
  now?: () => number;
}

type TlsWithCaApis = typeof tls & {
  getCACertificates?: (type?: "default" | "system" | "bundled" | "extra") => string[];
  setDefaultCACertificates?: (certs: string[]) => void;
};

let installed: SystemCaTrustOutcome | undefined;

/**
 * Make the default CA list the de-duplicated union of Node's default list
 * and the OS store. Idempotent: the first call's outcome is kept and
 * returned on every later call.
 */
export function installSystemCaTrust(deps: SystemCaTrustDeps = {}): SystemCaTrustOutcome {
  installed ??= computeAndInstall(deps);
  return installed;
}

/** The outcome of the process's install, or undefined if it never ran. */
export function systemCaTrustOutcome(): SystemCaTrustOutcome | undefined {
  return installed;
}

/** Trace attrs for a startup span: counts and status only, never cert contents. */
export function systemCaTrustTraceAttrs(): Record<string, string | number> {
  const outcome = installed;
  if (!outcome) return { system_ca_status: "not_installed" };
  const common = { system_ca_status: outcome.status, duration_ms: outcome.durationMs };
  switch (outcome.status) {
    case "installed":
      return {
        ...common,
        system_ca_count: outcome.systemCaCount,
        system_ca_added_count: outcome.addedCaCount,
        system_ca_unparsable_count: outcome.unparsableCaCount,
      };
    case "failed":
      return { ...common, error_class: outcome.errorClass };
    case "unsupported":
      return common;
  }
}

/** Test seam: forget the process's outcome so a test can install again. */
export function resetSystemCaTrustForTest(): void {
  installed = undefined;
}

function computeAndInstall(deps: SystemCaTrustDeps): SystemCaTrustOutcome {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const elapsed = () => Math.max(0, Math.round(now() - startedAt));
  const api = tls as TlsWithCaApis;
  const getCa = api.getCACertificates;
  const setCa = api.setDefaultCACertificates;
  const getDefaultCerts = deps.getDefaultCerts ?? (getCa && (() => getCa.call(tls, "default")));
  const getSystemCerts = deps.getSystemCerts ?? (getCa && (() => getCa.call(tls, "system")));
  const setDefaultCerts = deps.setDefaultCerts ?? (setCa && ((certs: string[]) => setCa.call(tls, certs)));
  if (!getDefaultCerts || !getSystemCerts || !setDefaultCerts) {
    return { status: "unsupported", durationMs: elapsed() };
  }
  try {
    const merged = [...getDefaultCerts()];
    const seen = new Set(merged.map((pem) => certIdentity(pem).key));
    const systemCerts = getSystemCerts();
    let added = 0;
    let unparsable = 0;
    for (const pem of systemCerts) {
      const { key, parsed } = certIdentity(pem);
      // Node builds the system list from parsed certs, so this should not
      // happen; skip rather than pass it on, or the setter throws and the
      // whole install (and the proxy CA it was for) is lost.
      if (!parsed) {
        unparsable += 1;
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(pem);
      added += 1;
    }
    if (added > 0) setDefaultCerts(merged);
    return {
      status: "installed",
      systemCaCount: systemCerts.length,
      addedCaCount: added,
      unparsableCaCount: unparsable,
      durationMs: elapsed(),
    };
  } catch (error) {
    return { status: "failed", errorClass: errorClassOf(error), durationMs: elapsed() };
  }
}

/**
 * The same cert can come back as differently formatted PEM (Node's bundled
 * roots have no trailing newline, the OS store's do), so certs are compared
 * by DER fingerprint. A system entry that does not parse is skipped and counted.
 */
function certIdentity(pem: string): { key: string; parsed: boolean } {
  try {
    return { key: `sha256:${new X509Certificate(pem).fingerprint256}`, parsed: true };
  } catch {
    return { key: `pem:${pem.trim()}`, parsed: false };
  }
}

function errorClassOf(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${error.name}:${code}` : error.name;
  }
  return typeof error;
}
