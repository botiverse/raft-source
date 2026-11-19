// What a sign-in's client says it is, for the person's own sign-in list (GET
// /api/me/sessions): the platform (`X-Raft-Client-Platform`: web, desktop_app,
// ios, ...) and the version (`X-Raft-Client-Version`, or an App's
// `Raft/<version>` User-Agent), read and validated as request tracing reads
// them (requestObservability.requestClientAttrs; an invalid value is dropped).
//
// DISPLAY ONLY. These are the client's own claims, not checked identity: no
// permission decision may read them (session_families.client_platform /
// client_version, written by createSession and refresh, read only by the list).
//
// The request's claims ride an AsyncLocalStorage (runWithSessionClient, one
// middleware in app.ts) so the sign-in flows (password, second step, social,
// SSO, passkey, signup, app login) and refresh need no new parameter on the
// way down to createSession / the rotation: whatever request issues or
// refreshes a family stamps what that request said.

import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { requestClientAttrs } from "../middleware/requestObservability";

export type SessionClient = { platform: string | null; version: string | null };

const store = new AsyncLocalStorage<SessionClient>();

/** The client a request names, from its headers (null where it sent none or an invalid one). */
export function sessionClientOf(req: Pick<Request, "header">): SessionClient {
  const attrs = requestClientAttrs(req);
  return {
    platform: typeof attrs.client_platform === "string" ? attrs.client_platform : null,
    version: typeof attrs.client_version === "string" ? attrs.client_version : null,
  };
}

/** Express middleware: the rest of the request runs with its client claims available to sessionService. */
export function runWithSessionClient(req: Request, _res: Response, next: NextFunction): void {
  store.run(sessionClientOf(req), next);
}

/** The current request's client claims; both null outside a request (scripts, tests calling services directly). */
export function currentSessionClient(): SessionClient {
  return store.getStore() ?? { platform: null, version: null };
}
