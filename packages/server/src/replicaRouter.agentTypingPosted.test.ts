import assert from "node:assert/strict";

const published: Array<{ channel: string; message: string }> = [];
const owners = new Map<string, string>();

vi.mock("./redis", () => ({
  isRedisAvailable: () => true,
  getRedis: () => ({
    get: async (key: string) => owners.get(key) ?? null,
    publish: async (channel: string, message: string) => { published.push({ channel, message }); return 1; },
  }),
  getRedisReplicaSub: () => { throw new Error("not used"); },
  resetRedisReplicaSub: () => {},
}));

const { REPLICA_ID, handleReplicaMessage, publishAgentTypingPosted, setAgentTypingPostedHandler } = await import("./replicaRouter");

const signal = { agentId: "agent-1", channelId: "channel-1", parentMessageId: null, target: "#general" };

afterEach(() => {
  published.length = 0;
  owners.clear();
  setAgentTypingPostedHandler(null);
});

test("a landed message is sent only to the replica holding the agent's machine", async () => {
  owners.set("slock:machine:machine-1:replica", "replica-b");
  await publishAgentTypingPosted(signal, "machine-1");
  assert.equal(published.length, 1);
  assert.equal(published[0]!.channel, "slock:replica:replica-b");
  assert.deepEqual(JSON.parse(published[0]!.message), { type: "agent:typing:posted", ...signal });
});

test("nothing is sent when this replica owns the machine, no replica does, or the machine is unknown", async () => {
  owners.set("slock:machine:machine-1:replica", REPLICA_ID);
  await publishAgentTypingPosted(signal, "machine-1");
  await publishAgentTypingPosted(signal, "machine-2");
  await publishAgentTypingPosted(signal, null);
  assert.deepEqual(published, []);
});

test("the owner replica ends the line from the direct message, and still accepts the old broadcast", () => {
  const seen: unknown[] = [];
  setAgentTypingPostedHandler((s) => seen.push(s));
  handleReplicaMessage(`slock:replica:${REPLICA_ID}`, JSON.stringify({ type: "agent:typing:posted", ...signal }));
  handleReplicaMessage(`slock:replica:${REPLICA_ID}`, JSON.stringify({ type: "agent:typing:posted", agentId: "agent-1" }));
  // Rolling deploy: a replica from before targeted routing still broadcasts.
  handleReplicaMessage("slock:replica:agent-typing-posted", JSON.stringify({ ...signal, from: "replica-old" }));
  assert.deepEqual(seen, [signal, signal]);
});
