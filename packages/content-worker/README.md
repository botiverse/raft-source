# @botiverse/raft-content-worker

The Cloudflare Worker that serves Raft's workspace Artifacts (HTML, Markdown and PDF versions) on origins of their own, through [Porthole](https://www.npmjs.com/package/@botiverse/porthole). Raft decides who may see a version and signs the frame's one-time ticket for that decision itself. This Worker checks the ticket, opens it once, asks Raft again on every request, and serves the version's bytes from R2.

## What it serves

- **The content domain** (`CONTENT_DOMAIN`). Artifact `pt_<uuid>` is served on `w-<uuid>.<CONTENT_DOMAIN>`, and all its versions share that origin. Only the Raft app (`APP_ORIGIN`) and its other clients (`EXTRA_APP_ORIGINS`, such as Raft Desktop's `app://raft`) may frame a page. Markdown is rendered to a page beside its source (`notes.md` opens as `notes.md.html`). A PDF opens in a pdf.js viewer page beside it (`report.pdf.html`), with pdf.js carried in the bundle. Nothing is loaded from a CDN for the viewer. The viewer lays each page's text over its canvas (pdf.js's text layer), so a PDF's text can be selected, copied, found by Raft's find bar and commented on, as a page's can.
- **A signed ticket's first load**, `GET <origin>/_raft/open?ticket=<ticket>` on the content domain. Raft's server signs the ticket (`rct1.<kid>.<claims>.<mac>`, `@botiverse/raft-shared/src/artifactContentTicket`): the Artifact, the version, the viewer and subject, the origin, an expiry a minute ahead and a nonce, HMAC-SHA-256 with a key derived from Raft's `ARTIFACTS_CONTENT_WORKER_TOKEN`. The Worker verifies it with the key of each `RAFT_TOKENS` entry, found by the ticket's kid, and refuses another format, an unknown kid, a bad MAC, an expired ticket (or one expiring more than five minutes ahead), another origin, an origin that isn't the Artifact's own label, or claims the issue route wouldn't take. It counts the open against the ticket's viewer (a signed-out visitor by client address): 120 a minute per isolate, past it Porthole's "Too many requests" page (429), before `TICKETS` is touched. The Worker's per-viewer open counter is per isolate and cleared past 10,000 keys: it caps cost, it is not a security boundary. Single use is enforced by D1 (the opened-nonce row). It records the nonce in `TICKETS` (a ticket opens once), kept five minutes past the ticket's expiry so a machine whose clock is behind can't open it again, then has Porthole mint a ticket of its own for that grant, kept in the isolate's memory and taken by the same request, and answers as Porthole answers it. A refused ticket gets Porthole's "This link has been used" page (401), its reason logged as `raft-content.ticket-refused`, never the ticket.
- **The frame's door**, `GET <origin>/__porthole/door/_raft?ticket=<door ticket>` on the content domain ([Porthole](https://www.npmjs.com/package/@botiverse/porthole) P125, P126). Raft's web (Porthole 0.14.6 and later) frames it first, hidden and opaque, and takes how loading went from it, never from the content's own frame. Raft's server signs its ticket beside the frame's (the same claims and `door: true`, the one field a ticket may carry beyond them, with a nonce of its own). The Worker checks it as it checks a frame's ticket, and it must be a door's (a frame's ticket opens no door, a door's no content: `/_raft/open` refuses one); counts it against a budget of its own beside its viewer's opens (120 a minute per isolate); records its nonce in `TICKETS`; then answers with Porthole's `doorAnswer` for that grant: Raft's authorize, the version's manifest and its entry being a page, `open` or the reason it is blocked, with no cookie. A refused door ticket gets Porthole's door saying `session` (401). Deploy this Worker (and a server that signs door tickets) before a web on Porthole 0.14.6 or later: that web frames nothing without a door.
- **A publish check's ticket** (Raft's publish check, on a deployment with a check Worker): a signed ticket only, never the issue route. Raft's server signs it from its check task alone (handed to the check Worker by `POST /internal/artifacts-check/lease`), with viewer `system:check` and subject `v1:check:<artifact>:<version>`, and the check's headless browser opens it top-level, in a tab of its own: there is no host page that frames it. Like every ticket it names no ancestor: one that does is refused (`malformed`, the shared verifier), a check's first of all. It never has a door either: the server signs none beside it, and a check ticket saying `door` is refused (`malformed`, the shared verifier). The Worker opens it only with that very Artifact's and version's check subject; a check ticket with a reader's or an anonymous subject or another version's or Artifact's check subject, and a reader's or an anonymous ticket with a check subject, is refused before D1, Raft or R2 are touched. Its grant is Porthole's anonymous one, as a signed-out visitor's: no viewer and no level, so the page's runtime host functions (comments, the user) are refused, for a one-minute session. Raft's authorize is asked as for anyone, with the check subject, and allows it only while that version's check runs (`not-checking` after). Its opens count against a budget of their own, 10 a minute per version per isolate, never a reader's or a client address's. The response the ticket opens is `no-store`; its headers are otherwise Porthole's, `frame-ancestors` included (the reader's: nothing widens it).
  - **No mixing with readers.** Nothing a check is shown can be cached: the response its ticket opens is `no-store`, and the Worker has no edge cache. Everything that holds an access decision is keyed so a check and a reader never share an entry: Porthole reuses Raft's authorize answer per session (its key holds the subject, and `v1:check:` is no reader's or visitor's), and the open budget's key is `open:check:<artifact>:<version>`. The per-isolate caches of a version's manifest and rendered pages stay shared on purpose: they hold immutable, version-addressed data, the same for every viewer, and no access decision.
- **Embeds of public Artifacts on any site** ([Porthole](https://www.npmjs.com/package/@botiverse/porthole) P143, #proj-workspace:#260), only while `EMBEDS` is `1` or `true` and `EMBED_DOMAIN` is set (the kill switch: off, every path below is the one 404 and Porthole takes no embed grant). Raft's server has a switch of its own, `ARTIFACTS_EMBED_ORIGIN`: unset, the web offers no Copy embed code and Raft says no Artifact embeds, so the embed host blanks every embed within 30 s. Turn both off together: `EMBEDS` off alone leaves the web's item offering code whose embed is the Worker's "isn't available" page.
  - **The embed host** (`EMBED_DOMAIN`, e.g. `embed.raftusercontent.com`: the content domain's site, outside it). `GET /pt_<uuid>` is Raft's outer page: the Artifact's embed session in a frame (`sandbox="allow-scripts allow-same-origin"`) and a bar in Raft's design system (the Raft logo, inline, linked to Raft's website; the title as escaped text; "Open in Raft" to its page in the app; both links a new tab, no referrer, at least 24 px to tap, 44 px on a coarse pointer, the DS focus ring). Its style is Space Grotesk, served from the embed host itself (`/_embed/fonts/`, the Markdown page's own woff2 files), raft-ui's font variables and Raft's light and dark tokens by `prefers-color-scheme`. Its CSP loads only its own script, style and fonts (`/_embed/embed.js`, `/_embed/embed.css`, `/_embed/fonts/*`), frames only that Artifact's own label (`frame-src`) and is framed by any page (`frame-ancestors *`); no cookie, no message listener, `noindex`, `no-referrer`, every permission denied, `no-cache` (the browser revalidates every load). Its script asks `GET /pt_<uuid>/live` (204, or the one 404; `no-cache`) every 30 s while the page shows, nothing while it is hidden, and at once when it shows again, and blanks the frame on a 404. Whether an Artifact embeds is Raft's answer (`GET {RAFT_API_URL}/internal/artifacts-content/embeds/:artifact`: public, current, a framed kind), reused 30 s per isolate (a no 10 s). Every Artifact that doesn't embed (nonexistent, malformed: never asked; private, server-only, deleted, taken down, unframed) gets the one 404, Porthole's embed status page, the same bytes whatever the reason.
  - **The embed session**, `GET <origin>/_raft/embed` on the content domain: the label's own Artifact's current version (no id or query read), refused (the one 404) when `Sec-Fetch-Site` is present and not `same-site` (a foreign page framing it directly). Porthole's anonymous grant with `embed` (no viewer, level or user; subject `v1:embed:<artifact>:<version>`; a ten-minute session; its cookie `__Host-porthole-e-<key>`, host-only), minted in the isolate's memory: no D1 write, no nonce, no door. Every answer of that session says `frame-ancestors *` and its plan names no host; no other session changes. Raft's authorize is asked on every request with the embed subject (decided as a signed-out visitor's), its answers reused across sessions for 30 s. `/_raft/open` and the door never mint an embed grant (a ticket naming an embed subject is refused).
  - **Budgets**, per isolate, before Raft is asked: 120 a minute per client address (outer pages, liveness and sessions opened, each); 600 a minute per Artifact (outer pages and sessions opened, each); 1,200 outer pages a minute per embedding site (the registrable domain of `Referer`, else `Origin`). Past one: Porthole's embed status page, 429, never a 5xx.
  - **Logs**: `raft-content.embed-view` with the Artifact, its kind and the embedder's registrable domain only (`none`, `ip` or `localhost` where it is no domain), at most once a minute per Artifact and embedder per isolate; never an address, a path or a query.
  - **Unpublishing or a takedown** blanks new loads within 30 s and every request of an open embed session within 30 s; a page already on screen loses its frame at its next liveness check (within 30 s of the isolate's answer changing while it shows, or when it shows again). No two caches stack: the outer page and `/live` are `no-cache`, so their bound is the isolate's 30 s alone; an embed subject's authorize answer is reused across sessions for 30 s, and Porthole's per-session copies of it are dropped the moment that memo expires (before every content request), so no copy outlives its memo (`test/raft-content-embed-bound.test.ts`).
- **The issue route**, `POST /_raft/frames`, on any host that is not under the content domain (the Worker's `workers.dev` host). Raft's server called it with a bearer token from `RAFT_TOKENS` to get a frame for a reader, before it signed tickets itself; it stays for a server deployed before that. Every other path on that host is a 404.
- **On every request after the ticket**, the Worker asks Raft (`POST {RAFT_API_URL}/internal/artifacts-content/authorize`). It reads a version's manifest from `GET {RAFT_API_URL}/internal/artifacts-content/versions/:version` and calls both with `RAFT_API_TOKEN`. Porthole reuses Raft's answer for 30 seconds per session, so a revocation (sign-out, an Artifact made private or deleted) reaches an open frame within 30 seconds, but only for requests that reach the Worker. A version's files are served `private, max-age=31536000, immutable`, so a file the frame has already loaded comes from the browser's cache and is not asked about again.

## Configuration

Everything is by name. `wrangler.jsonc` carries only placeholders: set real values where you deploy.

| Kind | Name | What it is |
|---|---|---|
| D1 binding | `TICKETS` | A database of the Worker's own, holding Porthole's one-time tickets and the nonces of the signed tickets opened (`raft-open:<nonce>`, until the ticket expires), nothing else. |
| Var | `CONTENT_DOMAIN` | The content domain, `host[:port]`. Use a registrable domain used for nothing else. Required. |
| Var | `APP_ORIGIN` | The Raft app's origin, the first frame ancestor. Required. |
| Var | `FRAMED_BY_ORIGINS` | Optional. A comma or space list of exact https origins of a page that frames the Raft app itself (Deck). Each is a frame ancestor of every page above the app (Porthole's `framedBy`), never an origin a shell or door takes messages from or tells, and never an app origin. Any other entry makes the content domain a 503. |
| Var | `EXTRA_APP_ORIGINS` | Optional. A comma list of other origins that frame pages, beside `APP_ORIGIN`: exact https origins, or `app://raft` (Raft Desktop, whose `app` scheme is registered standard and secure). Each is a frame ancestor and an origin the frame's shell takes messages from. Any other entry makes the content domain a 503. |
| Var | `EMBEDS` | Optional. `1` or `true` turns embeds of public Artifacts on (with `EMBED_DOMAIN`); anything else is off. The kill switch. |
| Var | `EMBED_DOMAIN` | Optional. The embed host, `host[:port]`: on the content domain's site but outside it, never on the app's site (a bad value turns embeds off and is logged). Needs a route of its own, managed outside this package. |
| Var | `RAFT_API_URL` | Raft's API base URL: https, or http on loopback only. Required. |
| Var | `RAFT_ISSUES_PER_MINUTE` | Optional. Frames each caller may ask for per minute, per isolate. Default 6000. |
| Var | `R2_ENDPOINT` | The R2 S3 endpoint of the account holding the bucket, an origin alone: `https://<account id>.r2.cloudflarestorage.com` (a jurisdiction's, such as `https://<account id>.eu.r2.cloudflarestorage.com`, if the bucket is in one). Required. |
| Var | `R2_BUCKET` | The platform app-content bucket Raft's server writes to (the server's `APP_STORAGE_R2_BUCKET`). Required. |
| Secret | `PORTHOLE_SECRET` | At least 32 random bytes. Signs tickets, cookies and sealed file paths. |
| Secret | `RAFT_API_TOKEN` | The Worker's token to Raft. Raft's `ARTIFACTS_CONTENT_RAFT_TOKENS` must list it. |
| Secret | `RAFT_TOKENS` | A comma list of Raft's tokens to the Worker (Raft's `ARTIFACTS_CONTENT_WORKER_TOKEN`), each at least 32 bytes: each one's derived key verifies the tickets Raft signs, and each is a bearer for `/_raft/frames`. To rotate, add the new token, switch Raft to it, then remove the old one once a ticket's minute has passed: while both are listed, tickets of either open. |
| Secret | `R2_READ_ACCESS_KEY_ID` | The access key id of an R2 API token that can only read `R2_BUCKET` (see [Reading R2](#reading-r2-a-read-only-token-no-binding)). Required. |
| Secret | `R2_READ_SECRET_ACCESS_KEY` | That token's secret access key. Required. |

Settings that can't be served (a missing domain, origin or API URL, a bad `EXTRA_APP_ORIGINS` entry, a short secret or token, or no R2 endpoint, bucket or read token) make every request a 503 with a generic body (`Content is unavailable.` on the content domain). The reason is logged and never answered to the caller.

Secrets are set on the Worker by your deployment, never committed. Raft's own deployment keeps them in a secret store and syncs them to the Worker with a workflow.

To deploy without editing `wrangler.jsonc`, `scripts/deploy-config.ts render <env> <output>` writes it with one `env.<env>` section filled in from `CONTENT_WORKER_NAME`, `CONTENT_WORKER_R2_BUCKET`, `CONTENT_WORKER_R2_ENDPOINT` (its `R2_BUCKET` and `R2_ENDPOINT` vars), `CONTENT_WORKER_D1_DATABASE_NAME`, `CONTENT_WORKER_D1_DATABASE_ID`, `CONTENT_WORKER_CONTENT_DOMAIN`, `CONTENT_WORKER_APP_ORIGIN`, `CONTENT_WORKER_EXTRA_APP_ORIGINS` (optional), `CONTENT_WORKER_FRAMED_BY_ORIGINS` (optional), `CONTENT_WORKER_EMBEDS` and `CONTENT_WORKER_EMBED_DOMAIN` (optional, together) and `CONTENT_WORKER_RAFT_API_URL`. Write it beside `wrangler.jsonc` (`wrangler.*.generated.json` is ignored) and pass it to every wrangler command with `--config <output> --env <env>`. The script's other modes check a deploy afterwards: the secret names (all five, `R2_READ_*` included), and the deployed version's bindings (no R2 binding).

### Reading R2: a read-only token, no binding

The Worker has no R2 binding. A binding can put, delete and list across its whole bucket, and the app-content bucket holds every first-party app's objects, not only Artifacts'. Instead the Worker reads each file with one S3 `GetObject`, signed with AWS Signature Version 4 (`src/services/r2Read.ts`), using an R2 API token that Cloudflare lets read objects of that one bucket and nothing else.

For each environment (staging, production), once:

1. In the Cloudflare dashboard, **R2** > **Manage API tokens** > **Create API token**. Permission: **Object Read only**. Scope: **Apply to specific buckets only**, the environment's app-content bucket alone. Never an Admin or Object Read & Write token, and never all buckets.
2. Copy the **Access Key ID** and **Secret Access Key** (shown once). The S3 endpoint shown with them is `R2_ENDPOINT`, without the bucket path.
3. Put both in your secret store, then set them on the Worker as `R2_READ_ACCESS_KEY_ID` and `R2_READ_SECRET_ACCESS_KEY`. Set `R2_ENDPOINT` and `R2_BUCKET` as vars where you deploy.
4. Check: an Artifact's frame loads. A wrong secret, a token without read on the bucket, or a wrong bucket is logged as `raft-content.r2-read-failed` with R2's status and error code (`SignatureDoesNotMatch`, `AccessDenied`, `NoSuchBucket`), and the visitor gets a generic error page.

To rotate, create a new token, set both secrets to it, then delete the old token. R2's `NoSuchKey` is a 404. Any other answer from R2 is never passed on to the visitor.

### Routes are managed outside this package

`wrangler.jsonc` declares no `routes`. The content domain needs one wildcard route, `*.<CONTENT_DOMAIN>/*`, on proxied wildcard DNS, and you manage it outside wrangler (for example in Terraform). With embeds, the embed host needs its own: a proxied DNS record and the route `<EMBED_DOMAIN>/*` (ideally with a rate rule at the edge above the Worker's budgets). A `wrangler deploy` with `routes` would replace it. The issue route stays on the Worker's `workers.dev` host (`workers_dev: true`, `preview_urls: false`).

### D1 migrations run separately

Deploying the Worker does not create its table. Apply `migrations/` to the `TICKETS` database yourself:

```sh
wrangler d1 migrations apply <your tickets database name> --remote
```

### R2 key layout

Raft's server keeps each first-party app's objects in one bucket, under `apps/<app id>/`. Artifacts' files are at:

```
apps/artifacts/servers/<server uuid>/blobs/<sha256>/<blob id>
```

Raft's manifest gives each file's key **relative** to that prefix (`servers/<server uuid>/blobs/<sha256>/<blob id>`). The Worker adds `apps/artifacts/` itself and never takes a full path from the manifest. A key that is not a valid app object key (`appObjectKeyProblem` in `@botiverse/raft-shared`, the same rule the server writes with), or that does not have this shape with the file's own SHA-256, makes the manifest a bad answer: a 503, and no ticket.

## What Raft's server needs

- `ARTIFACTS_CONTENT_WORKER_TOKEN`: one of the Worker's `RAFT_TOKENS`; it signs every frame's ticket.
- `ARTIFACTS_CONTENT_DOMAIN`: the same content domain as the Worker's `CONTENT_DOMAIN`.
- `ARTIFACTS_CONTENT_RAFT_TOKENS`: lists the Worker's `RAFT_API_TOKEN`.
- `ARTIFACTS_EMBED_ORIGIN` (optional): `https://<EMBED_DOMAIN>`, the server's embed switch, set and unset together with the Worker's `EMBEDS`: the web offers Copy embed code while it is set, and unset, Raft says no Artifact embeds.
- `APP_STORAGE_R2_ENDPOINT`, `APP_STORAGE_R2_REGION`, `APP_STORAGE_R2_ACCESS_KEY_ID`, `APP_STORAGE_R2_SECRET_ACCESS_KEY` and `APP_STORAGE_R2_BUCKET`: the app-content bucket the Worker reads (its `R2_BUCKET`). The server's token writes; the Worker's is a separate, read-only one.

Each direction needs its own token. If `ARTIFACTS_CONTENT_WORKER_TOKEN` is also in `ARTIFACTS_CONTENT_RAFT_TOKENS`, the server treats both as unusable: framed Artifacts answer 503 and the internal content routes 404. The web build's `VITE_ARTIFACTS_CONTENT_DOMAIN` is the same content domain. Deploy this Worker before (or with) a server that signs tickets: an older Worker has no `/_raft/open`.

## Development

```sh
pnpm run build       # wrangler deploy --dry-run --outdir dist (bundles, deploys nothing)
pnpm test            # build, then the tests in Miniflare against stubs of Raft's routes and R2's S3 API
pnpm typecheck
pnpm run test:browser            # Chromium: a page's comments.open reaches the host; a PDF's text is selected, found and commented on (needs Playwright's Chromium)
pnpm run test:check-parity       # Chromium: a check's top-level render matches the framed one (packages/check-worker)
pnpm run generate:pdfjs-assets   # after changing the pdfjs-dist version
```
