// OAuth IPC coordination — pure, Electron-free, so it can be unit-tested with an
// injected openExternal (assert zero-call on a rejected URL) and a fake loopback.
//
// It scopes the in-flight attempt to a per-arm token AND the arming renderer's
// sender id, so a second window / any other renderer (or the same renderer's
// stale, superseded flow) cannot consume the handoff code, cancel the live
// attempt, or drive the browser. The authorization URL is validated against the
// host allowlist BEFORE openExternal is ever called.

export interface OAuthCoordinatorDeps {
  arm: (nonce: string) => Promise<{ port: number; code: Promise<string> }>;
  cancel: () => void;
  openExternal: (url: string) => Promise<void>;
  isAllowedUrl: (url: unknown) => boolean;
  randomToken: () => string;
}

interface Pending {
  token: string;
  senderId: number;
  generation: number;
  // null while deps.arm is still in flight; set once the loopback is live.
  code: Promise<string> | null;
}

export interface OAuthCoordinator {
  arm(nonce: unknown, senderId: number): Promise<{ port: number; token: string }>;
  openAwait(payload: unknown, senderId: number): Promise<{ code: string }>;
  cancel(token: unknown, senderId: number): void;
}

export function createOAuthCoordinator(deps: OAuthCoordinatorDeps): OAuthCoordinator {
  let pending: Pending | null = null;
  let generation = 0;

  return {
    async arm(nonce, senderId) {
      if (typeof nonce !== "string" || !nonce) throw new Error("oauth_bad_nonce");
      const myGeneration = ++generation;
      const token = deps.randomToken();
      // Register THIS attempt synchronously — before awaiting deps.arm — so a
      // stale token from a prior attempt cannot match (and cancel/consume) us
      // during the arm window. Swallow the previous attempt's code rejection.
      pending?.code?.catch(() => {});
      pending = { token, senderId, generation: myGeneration, code: null };

      let armed: { port: number; code: Promise<string> };
      try {
        armed = await deps.arm(nonce);
      } catch (err) {
        // Only clear if we're still the current attempt (don't clobber a newer).
        if (pending?.generation === myGeneration) pending = null;
        throw err;
      }
      // A newer arm (or a cancel) took over during the await → we lost the race;
      // the newer attempt owns the loopback, so drop ours.
      if (!pending || pending.generation !== myGeneration) {
        armed.code.catch(() => {});
        throw new Error("oauth_superseded");
      }
      pending.code = armed.code;
      return { port: armed.port, token };
    },

    async openAwait(payload, senderId) {
      const authorizationUrl = (payload as { authorizationUrl?: unknown } | null)?.authorizationUrl;
      const token = (payload as { token?: unknown } | null)?.token;
      // Only the arming renderer, with the matching token, on a fully-armed
      // attempt (code ready), may drive this.
      if (!pending || pending.token !== token || pending.senderId !== senderId || !pending.code) {
        throw new Error("oauth_not_armed");
      }
      const code = pending.code; // narrowed non-null here
      // Validate before touching the OS — a rejected URL must never reach
      // openExternal.
      if (!deps.isAllowedUrl(authorizationUrl)) {
        deps.cancel();
        pending = null;
        throw new Error("oauth_bad_authorization_url");
      }
      await deps.openExternal(authorizationUrl as string);
      try {
        return { code: await code };
      } finally {
        if (pending?.token === token) pending = null;
      }
    },

    cancel(token, senderId) {
      // Only the exact {senderId, token} owner may cancel — so a stale,
      // superseded flow in the same renderer can't cancel the live attempt.
      if (!pending || pending.token !== token || pending.senderId !== senderId) return;
      deps.cancel();
      pending = null;
    },
  };
}
