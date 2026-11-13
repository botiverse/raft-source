import assert from "node:assert/strict";
import { webUrlFromRaftDeepLink } from "../src/utils/raftDeepLinkWebUrl";

const ORIGIN = "https://app.raft.build";
const ROUTE = "/s/botiverse/channel/11111111-1111-1111-1111-111111111111?msg=aaaaaaaa";

test("a raft:// link to a server route is the same route on the web origin, in both spellings", () => {
  assert.equal(webUrlFromRaftDeepLink(`raft://${ROUTE}`, ORIGIN), `${ORIGIN}${ROUTE}`);
  assert.equal(webUrlFromRaftDeepLink(`raft:/${ROUTE}`, ORIGIN), `${ORIGIN}${ROUTE}`);
  assert.equal(
    webUrlFromRaftDeepLink("raft:///s/botiverse/dm/2222?thread=2222:bbbbbbbb", ORIGIN),
    `${ORIGIN}/s/botiverse/dm/2222?thread=2222:bbbbbbbb`,
  );
});

test("other raft:// links, other schemes and an unknown origin give nothing", () => {
  for (const uri of ["raft:///", "raft://", "raft:///servers", "raft:///login?code=x", "raft://oauth/callback", "raft:////evil.example/s/x", "https://app.raft.build/s/x/channel/1"]) {
    assert.equal(webUrlFromRaftDeepLink(uri, ORIGIN), null, uri);
  }
  assert.equal(webUrlFromRaftDeepLink(`raft://${ROUTE}`, ""), null);
});
