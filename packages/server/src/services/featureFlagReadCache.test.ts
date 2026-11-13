// The short per-process flag cache for hot reads (featureFlagReadCache.ts):
// one read for what isn't cached, an answer kept for the TTL, forgotten as
// soon as this replica's change notifier sees its flag change, and nothing
// kept from a failed read or from a read a change overtook.
import assert from "node:assert/strict";
import { createFeatureFlagChangeNotifier, type FeaturesChangedTransport } from "./featureFlagChangeNotifier";
import { __setFlagReadCacheTtlForTests, cachedServerFlagAnswers, forgetCachedFlags, FLAG_READ_CACHE_TTL_MS } from "./featureFlagReadCache";

afterEach(() => {
  vi.useRealTimers();
  __setFlagReadCacheTtlForTests(0);
});

/** A flag store whose answers the test sets, counting the servers each read asks for. */
function store(initial: Record<string, boolean>) {
  const on = { ...initial };
  const reads: string[][] = [];
  const read = async (serverIds: string[]) => {
    reads.push(serverIds);
    return serverIds.map((serverId) => on[serverId] === true);
  };
  return { on, reads, read };
}

test("off (TTL 0, as under NODE_ENV=test): every call reads", async () => {
  __setFlagReadCacheTtlForTests(0);
  const flags = store({ a: true });
  assert.deepEqual(await cachedServerFlagAnswers(["a"], "f", flags.read), [true]);
  assert.deepEqual(await cachedServerFlagAnswers(["a"], "f", flags.read), [true]);
  assert.equal(flags.reads.length, 2);
});

test("one read for the servers not cached, answers in input order; cached ones aren't asked again until the TTL ends", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  __setFlagReadCacheTtlForTests(FLAG_READ_CACHE_TTL_MS);
  const flags = store({ a: true, c: true });
  assert.deepEqual(await cachedServerFlagAnswers(["a", "b", "a"], "f", flags.read), [true, false, true]);
  assert.deepEqual(flags.reads, [["a", "b"]]);
  assert.deepEqual(await cachedServerFlagAnswers(["b", "c", "a"], "f", flags.read), [false, true, true]);
  assert.deepEqual(flags.reads, [["a", "b"], ["c"]], "only c was read");
  // A change the notifier didn't see is picked up once the TTL ends.
  flags.on.b = true;
  vi.advanceTimersByTime(FLAG_READ_CACHE_TTL_MS - 1);
  assert.deepEqual(await cachedServerFlagAnswers(["b"], "f", flags.read), [false]);
  vi.advanceTimersByTime(1);
  assert.deepEqual(await cachedServerFlagAnswers(["b"], "f", flags.read), [true]);
  // Per flag: another flag for the same server is its own answer.
  assert.deepEqual(await cachedServerFlagAnswers(["a"], "g", flags.read), [true]);
  assert.deepEqual(flags.reads.at(-1), ["a"]);
});

test("a forgotten flag reads again at once; other flags stay cached", async () => {
  __setFlagReadCacheTtlForTests(FLAG_READ_CACHE_TTL_MS);
  const flags = store({ a: true });
  await cachedServerFlagAnswers(["a"], "f", flags.read);
  await cachedServerFlagAnswers(["a"], "g", flags.read);
  flags.on.a = false;
  forgetCachedFlags(["f"]);
  assert.deepEqual(await cachedServerFlagAnswers(["a"], "f", flags.read), [false]);
  assert.deepEqual(await cachedServerFlagAnswers(["a"], "g", flags.read), [true], "g still cached");
  assert.equal(flags.reads.length, 3);
});

test("a failed read keeps nothing: the next call reads again", async () => {
  __setFlagReadCacheTtlForTests(FLAG_READ_CACHE_TTL_MS);
  const flags = store({ a: true });
  await assert.rejects(cachedServerFlagAnswers(["a"], "f", async () => { throw new Error("db down"); }), /db down/);
  assert.deepEqual(await cachedServerFlagAnswers(["a"], "f", flags.read), [true]);
  assert.equal(flags.reads.length, 1);
});

test("a read that a change overtook answers but isn't kept", async () => {
  __setFlagReadCacheTtlForTests(FLAG_READ_CACHE_TTL_MS);
  const flags = store({ a: true });
  const answered = await cachedServerFlagAnswers(["a"], "f", async (serverIds) => {
    // The change lands while this read is in flight: what it read may be from before it.
    forgetCachedFlags(["f"]);
    flags.on.a = false;
    return serverIds.map(() => true);
  });
  assert.deepEqual(answered, [true]);
  assert.deepEqual(await cachedServerFlagAnswers(["a"], "f", flags.read), [false], "read again, not the overtaken answer");
});

test("this replica's change notifier forgets a changed flag's answers, from a server-side write and from a peer replica", async () => {
  __setFlagReadCacheTtlForTests(FLAG_READ_CACHE_TTL_MS);
  let peer: ((change: { serverId: string; keys: string[] }) => void) | null = null;
  const transport: FeaturesChangedTransport = {
    localSockets: () => [],
    localMachines: () => [],
    publishServerChange: () => {},
    onPeerServerChange: (handler) => {
      peer = handler;
      return () => { peer = null; };
    },
  };
  const notifier = createFeatureFlagChangeNotifier({ transport, pollIntervalMs: 0, quietMs: 10, maxWaitMs: 100 });
  try {
    const flags = store({ a: true });
    await cachedServerFlagAnswers(["a"], "f", flags.read);
    flags.on.a = false;
    notifier.notifyServer("a", ["f"]);
    await notifier.idle();
    assert.deepEqual(await cachedServerFlagAnswers(["a"], "f", flags.read), [false]);

    flags.on.a = true;
    peer!({ serverId: "a", keys: ["f"] });
    assert.deepEqual(await cachedServerFlagAnswers(["a"], "f", flags.read), [true]);
    assert.equal(flags.reads.length, 3);
  } finally {
    notifier.stop();
  }
});
