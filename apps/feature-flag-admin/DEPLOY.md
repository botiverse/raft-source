# Feature Flag Admin Deploy

Feature Flag Admin is the private Botiverse operator Worker at
`feature-flag-admin.botiverse.dev`. It owns Login with Raft, operator
authorization, feature-flag mutations, announcement lifecycle mutations, and
their audit records. Raft core exposes no admin API for either subsystem; it
retains only product-facing feature evaluation and announcement read/dismiss
behavior.

## Authority and bindings

Non-secret Worker vars:

- `RAFT_ORIGIN` and `RAFT_API_ORIGIN`: Login with Raft web/API origins. The API
  origin is used only for OAuth token exchange and userinfo, never as an admin
  mutation proxy.
- `RAFT_CLIENT_ID`: OAuth client id for this private app.
- `FEATURE_FLAG_ALLOWED_SERVER_IDS`: allowed Raft server ids.

Worker secrets:

- `RAFT_CLIENT_SECRET`
- `FEATURE_FLAG_SESSION_SECRET`

Data bindings:

- `FEATURE_FLAG_PG`: Hyperdrive connection to the production database through
  the reviewed least-privilege admin role. Every feature-flag and announcement
  admin operation is executed server-side through this binding.
- `FEATURE_FLAG_AUDIT_DB`: D1 database for feature-flag audit rows and the
  persistent `feature_flag_admin_role_grants` plus append-only role-audit
  tables.

The production Hyperdrive credential must authenticate as the PostgreSQL role
`feature_flag_admin_operator`. Server migration
`0240_feature_flag_admin_announcement_privileges.sql` owns the announcement
table contract: schema `USAGE`; `SELECT`, `INSERT`, and `UPDATE` on
`announcements`; `SELECT` and `INSERT` on append-only
`announcement_audit_events`; no schema `CREATE`, no delegation/grant options,
and no other table privileges. The migration installs a locked reconciler and
receipt table; production invokes that reconciler after schema migration, then
reads back both its same-principal receipt and PostgreSQL's effective privilege
oracle. Production server migrations set
`FEATURE_FLAG_ADMIN_PRIVILEGE_GUARD_REQUIRED=1`, so the deploy fails after
migration unless the role exists and that complete source-owned reconciliation
succeeds. A hand-built copy of the grants has no receipt and cannot close deploy
readiness. The production deploy then calls the Worker's no-session
`POST /api/readiness/operator-db`, which returns `204` only when the actual
`FEATURE_FLAG_PG` connection has the authenticated backend principal,
`session_user`, and `current_user` all bound to `feature_flag_admin_operator`,
and sees the same exact matrix. The backend principal is read from the
connection's own `pg_stat_activity` row, so a broad login cannot pass by using
`SET ROLE` or `SET SESSION AUTHORIZATION`. Neon/Hyperdrive may expose PostgreSQL
`system_user` as NULL/empty at the proxy layer; SQL NULL/empty is accepted only
with that authenticated-principal proof, while any non-empty `system_user` must
still identify the operator role and an unreadable field fails closed. The
historical staging guard is `0` because no staging Admin Worker or staging
binding existed. Commissioning the new staging Worker ends that premise: its
Hyperdrive must authenticate to the staging database as the same restricted
operator role, the source-owned reconciler and effective-privilege readback
must pass there, and enabling the staging guard remains a separate reviewed
server configuration change.

The general operator gate has one authority: an enabled Worker-owned D1
`admin` role. There is no source or environment bootstrap bypass. Announcement
publishing is intentionally stricter: a caller must be a human AND have an
enabled D1 `admin` role. Agent principals fail closed even when they hold
`admin`, because the human check is structural and cannot be granted around.
NOTE: granting a human `admin` therefore also grants authority to publish
announcements to every user; the `announcement_publisher` role is retired. Run D1 migration
`0002_admin_role_grants.sql` before enabling the operator routes. The migration
creates no individual grant. Do not restore
`FEATURE_FLAG_OPERATOR_PRINCIPAL_IDS`,
`RAFT_ANNOUNCEMENT_OPERATOR_PRINCIPAL_IDS` or either Raft-core feature-flag
operator environment variable as a substitute for the Worker-owned state.

Browser code receives principal metadata only. It never receives the Raft
access token, OAuth client secret, database credential, or generated operator
credential.

## Automated production deploy (task #127, plan B)

A staging merge touching this app auto-deploys the production Worker through
two workflows:

1. `trigger-feature-flag-admin-deploy.yml` (push to `staging`, path-scoped):
   dedupes by exact SHA, dispatches the executor via the run's own ephemeral
   `GITHUB_TOKEN` (`actions: write`), and waits for the deploy run's terminal
   state. The trigger holds no long-lived deploy credential of any kind
   (credential model simplified per cindyz's 2026-09-03 decision; the earlier
   scoped-key design was dropped when she accepted CI-held deploy authority).
2. `deploy-feature-flag-admin.yml` (workflow_dispatch: `source_sha` +
   `operation_id`): credential-isolated build job (tests, lifetime guard,
   typecheck, client build, `wrangler deploy --dry-run --outdir` bundle,
   artifact digest), then a protected-environment
   (`production-feature-flag-admin`) deploy job that re-verifies the digest,
   deploys the exact bundle with `--no-bundle`, and requires two readbacks:
   Cloudflare active-deployment version id must equal the deployed version id,
   and anonymous `/api/session` must return `200` with `principal: null`.

Hard invariants:

- Both workflows deploy the TOP-LEVEL `wrangler.toml` identity only. The
  `check-wrangler-identity.mjs` guard fails the deploy (build AND deploy jobs)
  if `RAFT_API_ORIGIN`, `FEATURE_FLAG_ALLOWED_SERVER_IDS`, the Hyperdrive id,
  or the D1 database id drifts from the reviewed production expectation.
  Staging environments must live entirely in `[env.*]` tables and never change
  top-level values.
- A code deploy never publishes announcements, mutates feature-flag data, or
  triggers Server/Web/main-app pipelines.
- Rollback = dispatch `deploy-feature-flag-admin.yml` with a previously
  verified exact `source_sha` and a fresh `operation_id`. Never "rebuild
  branch latest" as a rollback.
- Enablement is explicit and separately approved: the trigger no-ops until the
  repo variable `FFA_AUTO_DEPLOY_ENABLED=true`, and the executor fails closed
  until the `production-feature-flag-admin` environment with
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` is configured. Merging
  the workflows does not by itself enable production auto-deploy.

## Staging Worker

Staging is a separate Worker named `slock-feature-flag-admin-staging`. Its
Wrangler environment uses the online Raft identity plane at
`https://app.raft.build` and `https://api.raft.build`: operators log in through
the same Botiverse server id as production Admin. Environment isolation is on
the controlled data and deploy surfaces, not the login tenant. The staging
OAuth client, Worker, Hyperdrive, D1 database, PostgreSQL credential, and deploy
credential remain distinct, and staging mutations reach only the staging
database. The top-level Wrangler configuration remains the production identity;
staging vars and data bindings exist only under `[env.staging]`.

The staging renderer byte-pins the complete top-level production block. A
legitimate top-level change must update `PRODUCTION_CONFIG_SHA256` in the same
reviewed PR, describe each changed production field and why it is unrelated to
staging identity, and update any production workflow's semantic identity
expectations at the same time. Deleting, skipping, or blindly refreshing the
hash is not an update procedure.

The manual `Deploy Feature Flag Admin Staging` workflow has no environment or
ref input. It runs only from the current `staging` head and always invokes
Wrangler with `--env staging` and the explicit staging Worker name. Configure
the protected GitHub environment `feature-flag-admin-staging` before its first
dispatch with these non-secret variables:

- `FEATURE_FLAG_ADMIN_STAGING_CLOUDFLARE_ACCOUNT_ID`
- `FEATURE_FLAG_ADMIN_STAGING_ALLOWED_SERVER_IDS`
- `FEATURE_FLAG_ADMIN_STAGING_HYPERDRIVE_ID`
- `FEATURE_FLAG_ADMIN_STAGING_AUDIT_DATABASE_ID`

Configure its dedicated `FEATURE_FLAG_ADMIN_STAGING_CLOUDFLARE_API_TOKEN`
secret separately. The token must be scoped to the staging Worker resources;
do not reuse the production deploy credential. Create the following Worker
secrets directly on the staging Worker, with staging-only values:

- `RAFT_CLIENT_SECRET`
- `FEATURE_FLAG_SESSION_SECRET`

The workflow requires the exact online Botiverse server id while refusing the
production Hyperdrive or D1 id; validates an exact rendered configuration;
verifies that exactly those two
secret names exist before the write; and then deploys with a source-SHA
annotation. It reads the deployed version back and verifies the source SHA,
Raft origins, client id, allowed server ids, Hyperdrive id, D1 id, and secret
names. Staging also enables persisted, full-sampling invocation logs; the
workflow reads the Worker settings API and rejects a deployment whose
observability/log persistence is absent or partial. Logs must retain provider
and database error classes without emitting payloads, session material, or
credentials. The value-free deployment/version JSON is retained as CI evidence.

The workflow does not create Hyperdrive, D1, OAuth clients, secrets, or role
grants. Those are separate staging configuration operations. It also does not
enable or mutate any feature flag; the first staging flag write remains a
separate authorized operation after browser and API readiness checks.

## Validation

```bash
pnpm install --frozen-lockfile
pnpm --filter @botiverse/raft-feature-flag-admin test
pnpm --filter @botiverse/raft-feature-flag-admin typecheck
pnpm --filter @botiverse/raft-feature-flag-admin build
```

Required regression evidence:

1. A logged-in non-operator gets `403` before any database connection.
2. A D1 `admin` can grant/revoke the `admin` role through the Worker, every
   change is audited, and authoritative D1 readback proves the new enabled
   state. Announcement callers without `admin` get `403`; an agent still gets
   `403` even while holding `admin`. The retired `announcement_publisher` role
   is rejected with `invalid_admin_role`.
3. Generic flag create/patch/delete, all three kill-switch entry points,
   arbitrary-stage rule create/patch/delete, feature preview,
   first-server-rule creation, and Apple-web-rule creation use
   `FEATURE_FLAG_PG` directly and never call Raft core. Every mutation is
   serialized by transaction-scoped global config-version and per-flag locks,
   requires `expectedConfigVersion`, writes the D1 audit attempt before PG
   mutation, and verifies authoritative PG state before commit. No session
   advisory lock may survive a Hyperdrive backend returning to the pool.
4. Announcement list/create/edit/publish/cancel/expire/audit use
   `FEATURE_FLAG_PG` directly and preserve transaction/audit behavior.
5. Raft core returns `404` for all seven announcement operator method/path
   pairs, all three feature-flag operator method/path pairs, and all nine
   legacy feature-flag admin method/path pairs. The product feature-evaluation
   and announcement read/dismiss routes remain reachable as positive controls.

## Production rollout — one release decision, Worker then Server

The owner accepted one release rather than a staged production gate. The two
pipelines are still physically ordered **Worker then Server** so the brief
intermediate state has both admin surfaces instead of neither:

1. Freeze the reviewed source exact and prove it contains no #6211 selector
   change. If #6211 enters the target base first, void and recut this candidate.
2. Apply `0002_admin_role_grants.sql` and deploy the Worker. If this fails, do
   not start the Server deployment.
3. Deploy the Server route removal. Read back all 19 admin method/path pairs as
   `404`, the five retired Server env seams as absent, and the product-facing
   feature evaluation plus announcement read/dismiss routes as present.
4. Exercise Worker flag/rule/kill-switch and Announcement lifecycle readbacks.
   Browser announcement truth converges immediately on entry, visibility
   recovery, and network recovery, and at most every 60 seconds while visible
   and online, regardless of the Raft socket state. Background or offline tabs
   do not poll and failures do not self-spin. The owner explicitly accepted the
   up-to-60-second latency and sustained visible-tab read cost for this release.
5. After the architecture release, a non-beneficiary operator uses the normal
   audited role API for any individual `admin` grant and performs a separate
   login-role readback. Individual
   grants are data operations, not source or release gates.

Any product evaluation regression, Worker lifecycle/readback failure, or
failure of the three announcement convergence triggers causes immediate whole
release rollback before diagnosis. Roll back the Server through a prebuilt
exact-bound revert release, then roll the Worker back to its recorded previous
version. Both previous-known-good identities must be written into the release
record at press time; an older revert carrier must not be reused.

## Operational smokes

- `/` redirects anonymous callers to Login with Raft.
- `/api/session` returns `principal: null` anonymously and principal metadata
  after login.
- `/api/operator/*` returns `401` without a session.
- A D1 `admin` can list/grant/revoke roles; the role mutation and
  audit row are both present before success is returned.
- A permitted feature-flag operator can list/detail/preview and perform the
  audited CAS mutations without any outbound admin fetch.
- A permitted announcement publisher can create an en/zh-CN draft, schedule,
  update/cancel before activation, publish/expire, and read the audit timeline.
- Announcement responses expose no per-user dismissal or aggregate dismissal
  data.

An application rollback after Worker announcement writes requires a
data-aware plan because older Raft binaries do not understand all v2 lifecycle
states. Prefer disabling the Worker mutation path and rolling forward.
