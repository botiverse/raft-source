import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";


import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import { attachments, users } from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { addHuman, createChannel } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import { resetStorageForTests } from "../services/storageService.js";
import { ATTACHMENT_PREVIEW_BRIDGE_SCRIPT } from "../services/attachmentPreviewBridge.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

/**
 * Hostile-preview bridge injection on the HTML preview serve path (attachment
 * comments task #16 slice 2; security contract #wg-comment:ba106cab).
 *
 * Contract under test:
 * - the bridge script is APPENDED after the original bytes — the document
 *   itself is streamed unmodified (no HTML rewriting)
 * - Content-Length is absent (the stored size would truncate the script)
 * - the preview CSP stays locked (connect-src/form-action/object-src 'none')
 * - the script itself is static and inert without the acBridgeNonce query
 *   param, so this applies uniformly to every preview load
 * - the plain download route serves the ORIGINAL bytes, untouched
 */

test("html-preview appends the inert measurement bridge; download stays byte-identical", async () => {
  const uploadsDir = mkdtempSync(path.join(tmpdir(), "ac-bridge-"));
  const prevUploadsDir = process.env.UPLOADS_DIR;
  process.env.UPLOADS_DIR = uploadsDir;
  resetStorageForTests();
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "bridge-owner@slock.test",
      name: "bridge-owner",
      displayName: "Bridge Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
    }).returning();
    const server = await createServer("Bridge Test", "bridge-test", owner.id);
    const channel = await createChannel(server.id, "bridge-room", "channel");
    await addHuman(channel.id, owner.id);
    const message = await createMessage(channel.id, "user", owner.id, "report", "chat");

    const html = "<!doctype html><html><body><h1>Report</h1><p>D0≥35</p></body></html>";
    const storageKey = `${server.id}/report.html`;
    const filePath = path.join(uploadsDir, storageKey);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, html);

    const [attachment] = await db.insert(attachments).values({
      messageId: message.id,
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "report.html",
      mimeType: "text/html",
      sizeBytes: Buffer.byteLength(html),
      storageKey,
    }).returning();

    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bridge-owner@slock.test", password: "password123" }),
    });
    assert.equal(loginRes.status, 200);
    const { accessToken } = (await loginRes.json()) as { accessToken: string };
    const headers = { Authorization: `Bearer ${accessToken}`, "X-Server-Id": server.id };

    const urlRes = await fetch(`${baseUrl}/api/attachments/${attachment.id}/html-preview-url`, { headers });
    assert.equal(urlRes.status, 200, await urlRes.clone().text());
    const { url } = (await urlRes.json()) as { url: string };

    const previewRes = await fetch(url, { redirect: "manual" });
    assert.equal(previewRes.status, 200, await previewRes.clone().text());
    assert.equal(previewRes.headers.get("content-length"), null, "stored size must not truncate the appended script");
    const csp = previewRes.headers.get("content-security-policy") ?? "";
    for (const directive of ["connect-src 'none'", "form-action 'none'", "object-src 'none'"]) {
      assert.ok(csp.includes(directive), `preview CSP must keep ${directive}`);
    }
    const body = await previewRes.text();
    assert.equal(body, html + ATTACHMENT_PREVIEW_BRIDGE_SCRIPT, "original bytes streamed unmodified, script appended");

    // The bridge is preview-only: the download/serve route returns the
    // original object byte-identical.
    const downloadRes = await fetch(`${baseUrl}/api/attachments/${attachment.id}?serverId=${server.id}&token=${accessToken}`);
    assert.equal(downloadRes.status, 200, await downloadRes.clone().text());
    assert.equal(await downloadRes.text(), html, "download must stay byte-identical to the stored object");
  } finally {
    await close();
    if (prevUploadsDir === undefined) delete process.env.UPLOADS_DIR;
    else process.env.UPLOADS_DIR = prevUploadsDir;
    resetStorageForTests();
    rmSync(uploadsDir, { recursive: true, force: true });
  }
});
