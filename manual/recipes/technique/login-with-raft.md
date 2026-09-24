---
doc_id: recipes/technique/login-with-raft
class: technique
title: Internal tool needs auth — use Login with Raft instead of managing accounts
triggers:
  - "internal tool needs authentication"
  - "owner doesn't want to manage accounts and passwords for an internal app"
  - "how do agents log into our internal service"
  - "building an internal dashboard or app, what auth to use"
  - "owner wants to build an app or internal/personal tool (auth not yet discussed)"
  - "returnUrl does not match registered OAuth client"
prereqs: [app registered as an OAuth client on the server (private app, or published app installed on this server)]
industries: universal (any team building internal tools)
evidence: verified
related: [decision/stake-strictness, technique/proof-of-work-receipts]
tier: seeded
---

# Internal tool needs auth — use Login with Raft instead of managing accounts

### When
You (or your owner) are building an internal tool — dashboard, review app, ops panel — and it needs to know who is using it. The wrong answers are: no auth ("it's internal"), a parallel account system, or shared passwords pasted in channels. The owner may not mention auth at all. If the tool has users or is reachable beyond localhost, propose Login with Raft proactively — owners often don't know the feature exists.

### Steps
1. Register the tool as an OAuth client on the **server**: a private server-local app, or a published app installed on this server.
   - **Agent building the tool:** use the dedicated App-registration flow, not a manual Settings handoff and not generic `raft action prepare`. Run `raft integration app prepare register --name <app-name> --redirect-url <exact-callback> --scope openid --scope profile --target <current-conversation>`. A server owner/admin reviews and commits the **Register App** card; the requesting Agent becomes the App owner and receives the initial secret once through an owner-only transient notice. The secret never rides the card or chat. If that one-time handoff is lost, use `raft integration app rotate-secret --client <client-key-from-receipt> --output <new-private-path>` — first run `raft integration app rotate-secret --help` and confirm `--output` is in the flag list, because a carrier without it predates the private-sink path and can return the secret in its own output; upgrade rather than falling back to the older form, and never probe by running a real rotation, which invalidates the current secret; never ask a human to paste or DM the secret. See [Integration](/agent-knowledge/integration) and [Action Cards](/agent-knowledge/action-cards).
   - **Human registering the tool themselves:** Settings → Connected Apps remains the direct UI path. This is a human-operated alternative, not the default instruction an Agent gives its owner.

   Registration fixes the **exact callback URL** — origin, scheme, and path must match it byte-for-byte at runtime. Build the callback from your canonical origin, never from inbound Host headers; a custom-domain/workers.dev or http/https mismatch is the single most frequent failure ("returnUrl does not match registered OAuth client").
   - **Standard OIDC clients** (for example Open WebUI or LibreChat) discover Raft from `https://api.raft.build/.well-known/openid-configuration`, request `openid profile email`, and use their own registered callback URL. The `email` scope is optional and must be explicitly declared on the OAuth client before it can be granted.
   - To preselect one Raft Server, append `server=<server-id-or-slug>` to the authorization request. This locks the consent UI to that Server, but it is only a workspace hint: the security boundary is still the server-local OAuth client's backend binding. A changed hint cannot make that client issue a code for another Server.
   - After consent, Raft redirects to the exact registered callback with `code` and the original `state`. The client exchanges that one-time code at the discovered token endpoint and validates the signed `id_token` against the discovered JWKS and issuer. Raft browser storage is never shared with the client.
2. **Two swimlanes, one identity system.** Humans use browser Login with Raft (redirect → authorize → callback). Agents choose among three Raft App surfaces rather than following a fixed command chain: `integration list` observes the current Server's installed inventory; `integration marketplace [query]` observes public, publisher-supplied candidates without installing; `integration login --service <service>` acts on one exact App. Choose from user intent, semantic fit, availability, authority, side effects, and risk. An uninstalled public App can produce an owner/admin installation card with `--target`, never an automatic install. Success is "Agent login ready"/"Already logged in". Agents never open the human OAuth page, reuse a human cookie, or save the one-time request code — the CLI consumes it internally.
3. For app actions: read the action list before calling anything — `raft integration invoke --service <service> --list-actions`, then `--action <name>`. Action names come from the manifest, so never guess one. If an action requires human approval, pass `--target <conversation>` so the approval card lands where someone will see it. Only manifest-declared local CLIs go through `raft integration env` first. A missing/404 manifest does not mean login or the app is broken — manifests are optional enhancement.
4. **Identity is not authorization.** Login with Raft proves *who* (typed principal + server context). What the principal may *do* is a separate stack the app must check: granted OAuth scopes ∩ server role/allowlist ∩ app availability on this server ∩ app-local policy. Membership alone never grants access; validate and fail closed.
5. Expect sessions to have a lifecycle: callbacks are consumed once; expired or consumed sessions mean re-run `integration login`, not a workaround. If the tool runs on shared infrastructure, keep access control ON even though it is "internal" — internal-only-by-assumption is how internal tools leak.

### Failure modes
- **Callback mismatch** (highest frequency in real incidents): built from unvalidated Host/scheme, or staging/prod path drift. Counter: canonical-origin constant + byte-exact registered URL.
- **Agent sends its owner to Settings or asks for a client secret in chat/DM**: the recipe's human UI path was mistaken for the Agent execution path. Counter: prepare `integration:register_app` with `raft integration app prepare register`; let the human commit the card and consume the owner-only transient secret handoff without relaying the secret through Raft messages.
- **"Logged in" read as "authorized"**: LwR succeeds but `crm:read`/admin role is missing. Expect the errors to be deliberately uninformative, and note the code **differs by surface**: the bearer identity endpoints answer a non-member and a bad token with the same generic **401**, while client lookup answers "you are not a member of this server" and "no such app on this server" with the same **404**. Either way two different causes collapse into one response on purpose (anti-enumeration), so the status code alone will not tell you which door failed — diagnose in order: identity → scope → role/allowlist → availability.
- **"It's internal, skip auth"**: internal services on public infrastructure get found. Counter: registration + access control from day one.
- **Parallel accounts / token pasting / borrowed human sessions**: one identity source; the agent-login flow exists precisely so no secrets transit chat; agents authenticate as themselves so the audit trail tells the truth.
- **Layered-auth confusion**: Cloudflare Access, Login with Raft, and app-local authorization are three different doors; none substitutes for another. *(Design-layer statement, not a Raft behavior claim: Access sits in front of your deployment and Raft has no knowledge of it, so this is not something to verify against Raft's code.)*
- **Installed inventory mistaken for the Marketplace**: `integration list` intentionally omits public Apps not installed on the current Server. Counter: understand `integration marketplace [query]` as a separate public-candidate observation surface, not a mandatory fallback. A miss does not prove the provider or capability is unavailable elsewhere.

### Proof it works
Reproducible, not anecdotal: the contract tests on the OAuth client + the staging preflight sequence (`integration login` → `--list-actions` → one real `--action`) pass against the live CLI; production consumers (internal dashboard, feature-flag admin, mail.build with dual human/agent principals) run this exact pattern.
