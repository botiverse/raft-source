// A publish check's ticket (checkFrame.ts, task #130), checked as the content
// Worker checks a ticket (shared artifactContentTicket.ts): the version,
// viewer `system:check`, the check subject, the Artifact's own origin, and no
// ancestor (the check's headless browser opens it top-level: Tenny's design
// change). None without the content origin configured, none for a kind the
// shell draws; and the frame routes' signer can't make one.
import assert from "node:assert/strict";
import { ARTIFACT_CONTENT_CHECK_VIEWER, ARTIFACT_CONTENT_TICKET_SECONDS, artifactContentTicketKey, verifyArtifactContentTicket } from "@botiverse/raft-shared/src/artifactContentTicket";
import { signCheckFrame } from "./checkFrame";
import { signContentFrame } from "./contentWorker";

const TOKEN = "w".repeat(40);
const DOMAIN = "content.example.test";
const ARTIFACT = "pt_0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a";
const ORIGIN = "https://w-0b6c2c2e-8f5d-4a52-9d2e-0f1e2d3c4b5a.content.example.test";
const item = { id: ARTIFACT };
const version = { id: "v_1a2b3c4d-0000-4000-8000-000000000001", itemId: ARTIFACT, entry: "index.html" };
const READER_SUBJECT = "v1:22222222-2222-4222-8222-222222222222:11111111-1111-4111-8111-111111111111:-";

function configure(env: { token?: string; domain?: string } = {}) {
  vi.stubEnv("ARTIFACTS_CONTENT_WORKER_TOKEN", env.token ?? TOKEN);
  vi.stubEnv("ARTIFACTS_CONTENT_DOMAIN", env.domain ?? DOMAIN);
  vi.stubEnv("ARTIFACTS_CONTENT_RAFT_TOKENS", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

test("signs the version's check ticket: viewer system:check, the check subject, the Artifact's own origin, no ancestor, no door", async () => {
  configure();
  const frame = await signCheckFrame(item, version);
  assert.equal(frame.kind, "signed");
  if (frame.kind !== "signed") return;
  assert.deepEqual(Object.keys(frame).sort(), ["kind", "origin", "url"]);
  assert.equal(frame.origin, ORIGIN);
  const url = new URL(frame.url);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, "/_raft/open");
  const ticket = url.searchParams.get("ticket")!;
  const keys = [await artifactContentTicketKey(TOKEN)];
  // Verified exactly as the Worker verifies any ticket: no ancestor to expect.
  const verified = await verifyArtifactContentTicket(ticket, keys, { origin: ORIGIN });
  assert.ok(verified.ok, JSON.stringify(verified));
  const { expires, nonce, ...claims } = verified.claims;
  assert.deepEqual(claims, {
    artifact: ARTIFACT,
    version: version.id,
    viewer: ARTIFACT_CONTENT_CHECK_VIEWER,
    subject: `v1:check:${ARTIFACT}:${version.id}`,
    origin: ORIGIN,
  });
  assert.ok(expires - Date.now() / 1000 <= ARTIFACT_CONTENT_TICKET_SECONDS && nonce.length > 0);
  const payload = JSON.parse(Buffer.from(ticket.split(".")[2]!, "base64url").toString()) as Record<string, unknown>;
  assert.equal(Object.hasOwn(payload, "ancestor"), false, "no ancestor in what is signed");
  assert.equal(Object.hasOwn(payload, "door"), false, "nor a door (Porthole P125, P126): a check ticket never has one");
});

test("no ticket without the content origin, for a kind the shell draws or a PDF; ARTIFACTS_CHECK_HOST_ORIGIN is read by nothing", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    configure({ token: "", domain: "" });
    assert.deepEqual(await signCheckFrame(item, version), { kind: "not_configured" }, "no content origin");
    configure();
    // The old design's setting changes nothing: unset, or set to anything, the same ticket.
    vi.stubEnv("ARTIFACTS_CHECK_HOST_ORIGIN", "http://not-an-origin");
    assert.equal((await signCheckFrame(item, version)).kind, "signed");
    assert.deepEqual(await signCheckFrame(item, { ...version, entry: "data.csv" }), { kind: "not_framed" });
    assert.deepEqual(await signCheckFrame(item, { ...version, entry: "report.pdf" }), { kind: "not_checked" }, "a PDF is framed, not checked (shared ARTIFACT_CHECKED_KINDS)");
    assert.deepEqual(await signCheckFrame(item, { ...version, entry: "README.md" }), { kind: "not_checked" }, "Markdown is framed, not checked");
    await assert.rejects(signCheckFrame({ id: "pt_99999999-8f5d-4a52-9d2e-0f1e2d3c4b5a" }, version), /not the item's/);
  } finally {
    warn.mockRestore();
  }
});

test("the frame routes' signer never makes a check ticket: a check viewer or a check subject is refused, a reader's is signed", async () => {
  configure();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    for (const [why, viewer, subject] of [
      ["the check viewer and subject", ARTIFACT_CONTENT_CHECK_VIEWER, `v1:check:${ARTIFACT}:${version.id}`],
      ["the check viewer with a reader's subject", ARTIFACT_CONTENT_CHECK_VIEWER, READER_SUBJECT],
      ["a reader's viewer with a check subject", "user:11111111-1111-4111-8111-111111111111", `v1:check:${ARTIFACT}:${version.id}`],
      ["the anonymous viewer with a check subject", "anonymous", `v1:check:${ARTIFACT}:${version.id}`],
    ] as const) {
      const frame = await signContentFrame({ artifact: ARTIFACT, version: version.id, viewer, subject }, { kind: "html" });
      assert.equal(frame, null, why);
    }
    assert.ok(warn.mock.calls.length >= 4 && warn.mock.calls.every(([message]) => message === "[artifacts] content frame signing failed"));
    // Reverse control: a reader's frame is signed as ever.
    const reader = await signContentFrame({ artifact: ARTIFACT, version: version.id, viewer: "user:11111111-1111-4111-8111-111111111111", subject: READER_SUBJECT }, { kind: "html" });
    assert.ok(reader !== null && reader.url.startsWith(`${ORIGIN}/_raft/open?ticket=`));
  } finally {
    warn.mockRestore();
  }
});
