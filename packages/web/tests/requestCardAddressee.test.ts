import assert from "node:assert/strict";
import { vi } from "vitest";

// serverStore touches localStorage as it loads; the unit suite has no DOM.
vi.hoisted(() => {
  if (typeof (globalThis as { localStorage?: Storage }).localStorage?.getItem === "function") return;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
      clear: () => values.clear(),
      key: () => null,
      length: 0,
    } as Storage,
  });
});
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import { questionAddresseeId } from "../src/components/actions/questionCardAddressee";

// Who acts on a card addressed to one person (useActionCardAccess blocks
// everyone else, and ActionCardSpecCard drops their Decide/Answer buttons):
// a question card asked of a user, and a request card (request:prepare,
// RFC 085 §4.2) always, since only the person it is for decides. The server
// refuses anyone else on confirm either way.

const PERSON = "8C1D3E5F-0A2B-4C6D-8E9F-0123456789AB";

function metadata(action: Record<string, unknown>): ActionCardMetadata {
  return { action, state: "prepared" } as unknown as ActionCardMetadata;
}

test("a request card is for the person it names, by id", () => {
  assert.equal(
    questionAddresseeId(metadata({ type: "request:prepare", addressee: { kind: "user", userId: PERSON, handle: "Alice" } })),
    PERSON.toLowerCase(),
  );
});

test("a question card asked of one person still names them; one asked of anyone names no one", () => {
  assert.equal(
    questionAddresseeId(metadata({ type: "question:ask", addressee: { kind: "user", userId: PERSON, handle: "alice" } })),
    PERSON.toLowerCase(),
  );
  assert.equal(questionAddresseeId(metadata({ type: "question:ask", addressee: { kind: "anyone" } })), null);
});

test("other card types name no addressee", () => {
  assert.equal(questionAddresseeId(metadata({ type: "agent:create" })), null);
});
