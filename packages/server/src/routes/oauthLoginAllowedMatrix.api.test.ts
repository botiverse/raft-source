import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { oauthAccessRequests } from "../db/schema";
import { createApiTest } from "../test/integration/apiTest";
import { expectedAppPermissionsJson } from "../test/integration/appPermissions";
import {
  continueLogin,
  DEFAULT_SCOPES,
  exchange,
  LOGINS,
  lookup,
  REFUSALS,
  seed,
  start,
  writeServerId,
} from "./oauthLoginAllowedMatrix.fixtures";

// RFC 079 2a (#11476) merged the refusals of a human login into one 403
// app_not_available and moved the membership check before the app lookup. It
// claims to refuse no login that was allowed before. Each `login` row (LOGINS
// in ./oauthLoginAllowedMatrix.fixtures.ts, shared with the server-mode freeze
// oauthServerModeFrozen.api.test.ts) is
// a login that worked before 2a, run end to end: the setup page's lookup on
// the Server the person picks, its continue, and the app's code exchange. The
// control rows pin today's refusals. Asked for by Tenny in #proj-apps:769a57d4
// (edb201a9): reordering or tightening the checks turns a row red here first.
const test = createApiTest();

const REFUSAL = { status: 403, body: JSON.stringify({ error: "This app isn't available to you.", code: "app_not_available" }) };

async function answer(res: Response) {
  return { status: res.status, body: await res.text() };
}

async function humanCodesIssued() {
  return (await getDb().select({ id: oauthAccessRequests.id }).from(oauthAccessRequests)
    .where(eq(oauthAccessRequests.principalType, "human"))).length;
}

function idTokenClaims(idToken: string) {
  return JSON.parse(Buffer.from(idToken.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

for (const row of [...LOGINS, ...REFUSALS]) {
  test(`${row.expect}: ${row.name} [${row.path}]`, async ({ app }) => {
    const f = await seed(row);
    const scopes = row.expect === "login" && row.scopes ? row.scopes.ask : DEFAULT_SCOPES;
    const serverId = row.expect === "app_not_available" ? writeServerId(f.server.id, row.serverIdWritten) : f.server.id;
    const entry = await start(app, row, f, scopes, serverId);
    const { bearer } = f.person;

    if (row.expect === "app_not_available") {
      assert.deepEqual(await answer(await lookup(app, bearer, f.clientKey, serverId, scopes)), REFUSAL, "lookup");
      assert.deepEqual(await answer(await continueLogin(app, bearer, entry.body)), REFUSAL, "continue");
      assert.equal(await humanCodesIssued(), 0, "no code issued");
      if (row.serverIdWritten) {
        // Only the spelling is refused: the same person and app with S's canonical id are offered the login.
        const canonical = await lookup(app, bearer, f.clientKey, f.server.id, scopes);
        assert.equal((await canonical.json() as { availability?: string }).availability, "ready", "canonical id");
      }
      return;
    }
    if (row.expect === "installation_suspended") {
      const looked = await lookup(app, bearer, f.clientKey, f.server.id, scopes);
      assert.equal(looked.status, 200, "lookup");
      assert.equal((await looked.json() as { availability: string }).availability, "suspended");
      const refused = await continueLogin(app, bearer, entry.body);
      assert.equal(refused.status, 403, "continue");
      const { error, errorCode } = await refused.json() as { error: string; errorCode: string };
      assert.deepEqual({ error, errorCode }, { error: "installation_suspended", errorCode: "OAUTH_INSTALLATION_SUSPENDED" });
      assert.equal(await humanCodesIssued(), 0, "no code issued");
      return;
    }

    const client = f.client!;
    if (row.path === "marketplace") {
      const offered = await lookup(app, bearer, f.clientKey, f.server.id, scopes);
      assert.equal(offered.status, 200, `lookup before install: ${await offered.clone().text()}`);
      const offer = await offered.json() as { id: string; availability: string; installation?: { serverId: string; canInstall: boolean } };
      assert.equal(offer.availability, "install_required");
      assert.deepEqual(offer.installation, { serverId: f.server.id, canInstall: true });
      const installed = await fetch(`${app.baseUrl}/api/integrations/marketplace/${offer.id}/install`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "X-Server-Id": f.server.id, "Content-Type": "application/json" },
        body: await expectedAppPermissionsJson(client.id),
      });
      assert.equal(installed.status, 200, `install from the setup page: ${await installed.clone().text()}`);
    }

    const looked = await lookup(app, bearer, f.clientKey, f.server.id, scopes);
    assert.equal(looked.status, 200, `lookup: ${await looked.clone().text()}`);
    assert.equal((await looked.json() as { availability: string }).availability, "ready", "lookup");

    const continued = await continueLogin(app, bearer, entry.body);
    assert.equal(continued.status, 200, `continue: ${await continued.clone().text()}`);
    const issued = await continued.json() as { code: string; server: { id: string; role: string }; scopes: string[] };
    const granted = row.scopes?.granted ?? DEFAULT_SCOPES;
    assert.deepEqual({ server: issued.server.id, role: issued.server.role, scopes: issued.scopes }, { server: f.server.id, role: row.role, scopes: granted });

    const exchanged = await exchange(app, client, issued.code, entry.mount, entry.verifier);
    assert.equal(exchanged.status, 200, `exchange: ${await exchanged.clone().text()}`);
    const token = await exchanged.json() as { access_token: string; id_token: string; scope: string };
    assert.ok(token.access_token, "access token");
    const claims = idTokenClaims(token.id_token);
    assert.deepEqual(
      { sub: claims.sub, server_id: claims.server_id, server_role: claims.server_role, scope: token.scope },
      { sub: f.person.id, server_id: f.server.id, server_role: row.role, scope: granted.join(" ") },
    );
  });
}
