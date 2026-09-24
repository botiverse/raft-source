import assert from "node:assert/strict";
import test from "node:test";
import {
  PENDING_INVITE_STORAGE_KEY,
  takePendingInviteRedirectPath,
} from "../src/utils/socialAuth.js";

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

test("social auth callback can resume a pending invite through the invite page", () => {
  const storage = new MemoryStorage();
  storage.setItem(PENDING_INVITE_STORAGE_KEY, "join/token with spaces");

  const redirect = takePendingInviteRedirectPath(storage);

  assert.equal(redirect, "/?invite=join%2Ftoken+with+spaces");
  assert.equal(storage.getItem(PENDING_INVITE_STORAGE_KEY), null);
});

test("social auth callback keeps normal return flow when no invite is pending", () => {
  const storage = new MemoryStorage();

  assert.equal(takePendingInviteRedirectPath(storage), null);
});
