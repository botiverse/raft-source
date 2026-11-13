import assert from "node:assert/strict";
import { test } from "vitest";
import { usersFirstViolation, type Statement } from "./jointUsersFirstGuard";

// Counterexamples for the real-PG guard's check, on recorded statement lists.
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const S = "00000000-0000-4000-8000-0000000000f5";

const helper = (...ids: string[]): Statement => ({
  text: `SELECT u.id FROM users u WHERE u.id IN (${ids.map((_, i) => `$${i + 1}::uuid`).join(", ")})\n    ORDER BY u.id FOR KEY SHARE OF u`,
  values: ids,
});
const server: Statement = { text: "SELECT id FROM servers WHERE id = $1::uuid FOR SHARE", values: [S] };
const referenced = (...ids: string[]): Statement => ({
  text: `SELECT id FROM users WHERE id IN (${ids.map((_, i) => `$${i + 1}::uuid`).join(", ")}) ORDER BY id FOR KEY SHARE`,
  values: ids,
});
const drizzleForUpdate = (id: string): Statement => ({ text: `select "id" from "users" where "users"."id" = $1 for update`, values: [id] });
const insert: Statement = { text: `insert into "joint_channel_members" ("user_id") values ($1)`, values: [A] };
const none = new Set<number>();

test("users A, a server, then the helper locking B: a violation", () => {
  assert.match(usersFirstViolation([helper(A), server, helper(B), insert], [A], none) ?? "", /users row .*b locked after the first lock/);
});

test("users A, a server, then another users-row lock of a new person (lockReferencedRows, a raw FOR UPDATE): a violation", () => {
  assert.notEqual(usersFirstViolation([helper(A), server, referenced(A, B), insert], [A], none), null);
  assert.notEqual(usersFirstViolation([helper(A), server, drizzleForUpdate(B), insert], [A], none), null);
});

test("users A, a server, then A again: passes", () => {
  assert.equal(usersFirstViolation([helper(A), server, helper(A), referenced(A), insert], [A], none), null);
});

test("users A and B, a server, then B: passes", () => {
  assert.equal(usersFirstViolation([helper(A, B), server, helper(B), insert], [A, B], none), null);
});

test("a server first: a violation", () => {
  assert.match(usersFirstViolation([server, helper(A), insert], [A], none) ?? "", /first lock is not the users rows/);
});

test("a person whose FK the writes check, missing from the first lock: a violation", () => {
  assert.match(usersFirstViolation([helper(A), server, insert], [A, B], none) ?? "", /users lock misses/);
});

test("only the conversion fence may come before the users rows", () => {
  const fence: Statement = { text: "SELECT pg_advisory_xact_lock_shared($1, $2)", values: [1, 42] };
  assert.equal(usersFirstViolation([fence, helper(A), server, insert], [A], new Set([42])), null);
  assert.notEqual(usersFirstViolation([fence, helper(A), server, insert], [A], new Set([7])), null);
});
