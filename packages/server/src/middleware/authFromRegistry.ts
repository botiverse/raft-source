// Auth dispatcher derived from `routeAuthPolicy` — picks the right
// authenticator middleware based on the current request path.
//
// `rfcs/034-slock-credential-rfc.zh.html#section-route-auth-policy`:
//   Single dispatcher → fail-closed contract:
//   1. If the path is under a CLAIMED prefix and matches a registered
//      route → dispatch to the principal's authenticator middleware.
//   2. If the path is under a CLAIMED prefix but NOT in the registry →
//      401 `auth_policy_unregistered_path` (fail closed — adding a sibling
//      route without registering it stays denied).
//   3. If the path is NOT under any CLAIMED prefix → next() (out of
//      scope; per-route auth wiring applies).
//
// Wrong-principal denial (§2.4 wrong-principal semantics): the principal authenticator itself is
// responsible for returning 401 `invalid_principal` when the bearer token
// shape doesn't match. The dispatcher only routes to the right authenticator;
// it does not double-check the bearer.

import type { Request, Response, NextFunction, RequestHandler } from "express";
import {
  CLAIMED_AUTH_POLICY_PREFIXES,
  routeAuthPolicy,
  type PrincipalKind,
  type RouteAuthPolicyEntry,
} from "./routeAuthPolicy.js";
import { requireMachineAuth, requireAgentCredentialAuth, requireComputerAuth } from "./auth.js";

function fullRequestPath(req: Request): string {
  return `${req.baseUrl ?? ""}${req.path ?? ""}` || req.path;
}

function isClaimedPrefix(reqPath: string): boolean {
  for (const prefix of CLAIMED_AUTH_POLICY_PREFIXES) {
    // Match either exact (for `/internal/agent-api`) or prefix-with-slash
    // (for `/internal/computer/...`).
    if (reqPath === prefix) return true;
    if (prefix.endsWith("/") && reqPath.startsWith(prefix)) return true;
    if (!prefix.endsWith("/") && reqPath.startsWith(prefix + "/")) return true;
  }
  return false;
}

/**
 * Match `req.path` against a registry row's Express-style path pattern.
 * Supports `:id` / `:msgId` / `:agentId` placeholders (one path segment
 * each) but not full Express regex syntax — this registry only needs simple
 * segment-bound substitution.
 */
function pathMatches(reqPath: string, pattern: string): boolean {
  const reqSegs = reqPath.split("/").filter(Boolean);
  const patSegs = pattern.split("/").filter(Boolean);
  if (reqSegs.length !== patSegs.length) return false;
  for (let i = 0; i < patSegs.length; i++) {
    const pat = patSegs[i];
    if (pat.startsWith(":")) continue;
    if (pat !== reqSegs[i]) return false;
  }
  return true;
}

function methodMatches(reqMethod: string, entryMethod: RouteAuthPolicyEntry["method"]): boolean {
  if (entryMethod === "*") return true;
  return reqMethod.toUpperCase() === entryMethod;
}

function findMatchingEntry(req: Request): RouteAuthPolicyEntry | null {
  const reqPath = fullRequestPath(req);
  for (const entry of routeAuthPolicy) {
    if (!methodMatches(req.method, entry.method)) continue;
    if (!pathMatches(reqPath, entry.path)) continue;
    return entry;
  }
  return null;
}

const PASS_THROUGH_PRINCIPALS: ReadonlySet<PrincipalKind> = new Set([]);

/**
 * Per-principal authenticator dispatch table. Adding a new PrincipalKind
 * requires adding it here AND in `routeAuthPolicy.ts`.
 */
const PRINCIPAL_AUTHENTICATORS: Partial<Record<PrincipalKind, RequestHandler>> = {
  sk_machine: requireMachineAuth,
  sk_agent: requireAgentCredentialAuth,
  sk_computer: requireComputerAuth,
};

/**
 * Express middleware that authenticates the current request based on the
 * declarative `routeAuthPolicy` registry. Mount it on the prefixes the
 * registry claims; non-claimed paths pass through unchanged so per-route
 * auth wiring elsewhere keeps working.
 */
export function authFromRegistry(): RequestHandler {
  return async function authFromRegistryMw(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const reqPath = fullRequestPath(req);
    if (!isClaimedPrefix(reqPath)) {
      next();
      return;
    }
    const entry = findMatchingEntry(req);
    if (!entry) {
      // Fail closed — path is under a CLAIMED prefix but the registry has
      // no row for it. Adding a sibling route without registering it stays
      // denied here, not in the handler.
      res.status(401).json({
        error: "Unregistered internal route",
        code: "auth_policy_unregistered_path",
      });
      return;
    }

    if (PASS_THROUGH_PRINCIPALS.has(entry.principal)) {
      next();
      return;
    }

    const authenticator = PRINCIPAL_AUTHENTICATORS[entry.principal];
    if (!authenticator) {
      // Registry mentions a principal the dispatcher doesn't know how to
      // authenticate yet. This is an unfinished wiring — fail closed with
      // 501 so we notice during integration rather than silently 200.
      res.status(501).json({
        error: "Auth principal not wired",
        code: "auth_principal_unsupported",
        principal: entry.principal,
      });
      return;
    }

    authenticator(req, res, next);
  };
}
