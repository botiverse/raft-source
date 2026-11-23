import assert from "node:assert/strict";
import { test } from "vitest";

import {
  agentDescriptionViewer,
  humanDescriptionViewer,
  humanOriginSubjectInServer,
  jointOriginConversation,
  LOCAL_ORIGIN_CONVERSATION,
  senderOriginFor,
  senderOriginWire,
  senderOriginWireField,
  type OriginSubject,
} from "./descriptionVisibility";

const H = "host-server";
const P = "peer-server";
const X = "unrelated-server";
const joint = new Map([[H, "host"], [P, "peer"]]);
const peerAgent: OriginSubject = { kind: "agent", serverId: P };

test("an agent of another server: its slug only inside a joint conversation both servers take part in", () => {
  const reader = agentDescriptionViewer(H);
  assert.deepEqual(senderOriginFor(reader, peerAgent, jointOriginConversation(joint, peerAgent)), { kind: "other_server", serverSlug: "peer" });
  assert.deepEqual(senderOriginFor(reader, peerAgent, LOCAL_ORIGIN_CONVERSATION), { kind: "other_server" }, "local: no slug");
  assert.deepEqual(senderOriginFor(reader, peerAgent, jointOriginConversation(new Map([[H, "host"], [X, "unrelated"]]), peerAgent)), { kind: "other_server" }, "the sender's server is not in this joint");
  assert.deepEqual(senderOriginFor(agentDescriptionViewer(X), peerAgent, jointOriginConversation(joint, peerAgent)), { kind: "other_server" }, "the reader's server is not in this joint");
  assert.deepEqual(
    senderOriginFor(reader, peerAgent, { kind: "joint", serverIds: new Set([H, P]), postingServer: { id: H, slug: "host" } }),
    { kind: "other_server" },
    "an agent posts only from its own server: any other posting server names nothing",
  );
  assert.equal(senderOriginFor(agentDescriptionViewer(P), peerAgent, jointOriginConversation(joint, peerAgent)), null, "same server: no origin");
});

test("a person: guest only on their host server; from the server they post from elsewhere; none for a member", () => {
  const guestOnHost: OriginSubject = { kind: "human", nonGuestServerIds: [], guestServerIds: [H] };
  assert.deepEqual(senderOriginFor(agentDescriptionViewer(H), guestOnHost, jointOriginConversation(joint, guestOnHost)), { kind: "guest" });
  assert.deepEqual(senderOriginFor(agentDescriptionViewer(P), guestOnHost, jointOriginConversation(joint, guestOnHost)), { kind: "other_server", serverSlug: "host" }, "never a guest label on another server");
  assert.equal(senderOriginFor(agentDescriptionViewer(H), humanOriginSubjectInServer(H, "member"), LOCAL_ORIGIN_CONVERSATION), null);
  const inBoth: OriginSubject = { kind: "human", nonGuestServerIds: [P, X], guestServerIds: [] };
  assert.deepEqual(senderOriginFor(agentDescriptionViewer(H), inBoth, jointOriginConversation(joint, inBoth)), { kind: "other_server", serverSlug: "peer" }, "posting server: one of the joint's");
});

test("fail closed: anyone not a non-guest member of the reader's server gets at least other_server", () => {
  const reader = agentDescriptionViewer(H);
  const noMember = humanOriginSubjectInServer(H, null);
  assert.deepEqual(senderOriginFor(reader, noMember, LOCAL_ORIGIN_CONVERSATION), { kind: "other_server" }, "local or unknown conversation");
  assert.deepEqual(senderOriginFor(reader, noMember, jointOriginConversation(joint, noMember)), { kind: "other_server" }, "posting server unknown: no slug");
  assert.deepEqual(senderOriginFor(reader, noMember, jointOriginConversation(joint, noMember, [X])), { kind: "other_server" }, "a posting server outside the joint names nothing");
});

test("human readers never get an origin; the daemon spelling is snake_case", () => {
  assert.equal(senderOriginFor(humanDescriptionViewer(H, "member"), peerAgent, jointOriginConversation(joint, peerAgent)), null);
  assert.equal(senderOriginFor(null, peerAgent, LOCAL_ORIGIN_CONVERSATION), null);
  assert.deepEqual(senderOriginWire({ kind: "other_server", serverSlug: "peer" }), { kind: "other_server", server_slug: "peer" });
  assert.deepEqual(senderOriginWire({ kind: "other_server" }), { kind: "other_server" });
  assert.deepEqual(senderOriginWire({ kind: "guest" }), { kind: "guest" });
  assert.equal(senderOriginWire(null), undefined);
  assert.deepEqual(senderOriginWireField(null), {});
  assert.deepEqual(senderOriginWireField({ kind: "guest" }), { sender_origin: { kind: "guest" } });
});
