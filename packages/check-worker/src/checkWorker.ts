// The check Worker for Raft's workspace Artifacts (task #proj-workspace:#130; README.md;
// docs/development/workspace-artifacts.md, "The check Worker"). A Worker of its own,
// `raft-artifact-check` (`raft-artifact-check-staging`): it shares nothing with Raft but the
// two routes it calls with its own token.
//
// - `scheduled` (every minute, wrangler.jsonc): one run of runner.ts: lease checks and hand each
//   to an invocation of its own through the Worker's loopback (dispatch.ts).
// - `fetch`: `POST /run` (one dispatched check: lease, browser, check, result; the Worker's own
//   token only) and `GET /health`; there is no public API (no host at all).
//
// The handlers are handler.ts's (which catches everything at their outermost level), with the
// real browser: Browser Rendering through @cloudflare/puppeteer (browser.ts), a session per check
// at a time, reused from the account's free ones where it can (pool.ts).
import { acquireCheckBrowser } from "./browser";
import { createHandler } from "./handler";

export default createHandler({ acquireBrowser: (binding, pool) => acquireCheckBrowser(binding, pool) });
