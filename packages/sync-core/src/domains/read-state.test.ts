import assert from "node:assert/strict";
import { test } from "node:test";
import { createSyncCore } from "../core.js";
import {
  READ_STATE_DOMAIN,
  createReadStateDomain,
  encodeReadStateScopeId,
  toReadStateFrame,
  type ReadStateFact,
} from "./read-state.js";
import type { SyncDomainConfig } from "../types.js";

function fact(overrides: Partial<ReadStateFact> = {}): ReadStateFact {
  return {
    serverId: "server-a",
    principalId: "viewer-a",
    scopeId: "scope-a",
    maxReadSeq: 12,
    readStateVersion: 3,
    ...overrides,
  };
}

function core() {
  return createSyncCore({
    domains: [createReadStateDomain() as SyncDomainConfig<unknown, unknown>],
  });
}

test("read_state uses a collision-safe receiver-private tuple key", () => {
  const left = encodeReadStateScopeId(fact({ serverId: "a:b", principalId: "c", scopeId: "d" }));
  const right = encodeReadStateScopeId(fact({ serverId: "a", principalId: "b:c", scopeId: "d" }));
  assert.notEqual(left, right);
  assert.deepEqual(JSON.parse(left), ["a:b", "c", "d"]);
});

test("higher read-state version replaces the complete fact even when maxReadSeq rewinds", () => {
  const sync = core();
  const first = fact({ maxReadSeq: 20, readStateVersion: 4 });
  const unread = fact({ maxReadSeq: 19, readStateVersion: 5 });
  const scopeId = encodeReadStateScopeId(first);

  sync.ingestFrame(READ_STATE_DOMAIN, toReadStateFrame(first));
  sync.ingestFrame(READ_STATE_DOMAIN, toReadStateFrame(unread));

  assert.deepEqual(sync.state(READ_STATE_DOMAIN, scopeId), unread);
  assert.equal(sync.scopeSyncState(READ_STATE_DOMAIN, scopeId)?.appliedSeq, 5n);
});

test("same-version read-state conflict is visible and never mutates accepted fact", () => {
  const sync = core();
  const accepted = fact({ maxReadSeq: 20, readStateVersion: 5 });
  const conflict = fact({ maxReadSeq: 19, readStateVersion: 5 });
  const scopeId = encodeReadStateScopeId(accepted);

  sync.ingestFrame(READ_STATE_DOMAIN, toReadStateFrame(accepted));
  const before = sync.state(READ_STATE_DOMAIN, scopeId);
  assert.deepEqual(
    sync.ingestFrame(READ_STATE_DOMAIN, toReadStateFrame(conflict)),
    { kind: "violation", scopeId, violation: "producer_version_conflict" },
  );
  assert.equal(sync.state(READ_STATE_DOMAIN, scopeId), before);
  assert.equal(sync.violations().records.at(-1)?.kind, "producer_version_conflict");
});

test("read-state arrival permutations converge to the highest version", () => {
  const facts = [
    fact({ maxReadSeq: 8, readStateVersion: 2 }),
    fact({ maxReadSeq: 4, readStateVersion: 3 }),
    fact({ maxReadSeq: 10, readStateVersion: 4 }),
  ];
  const orders = [facts, [facts[2]!, facts[0]!, facts[1]!], [facts[1]!, facts[0]!, facts[2]!]];
  for (const order of orders) {
    const sync = core();
    for (const item of order) sync.ingestFrame(READ_STATE_DOMAIN, toReadStateFrame(item));
    assert.deepEqual(sync.state(READ_STATE_DOMAIN, encodeReadStateScopeId(facts[0]!)), facts[2]);
  }
});
