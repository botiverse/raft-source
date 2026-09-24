import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRaftUri } from "../uri.js";

interface UriVector {
  name: string;
  uri: string;
  action?: "open" | "channel" | "dm";
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, "../../fixtures/contract-vectors.json"), "utf8"),
) as { uri: { valid: UriVector[]; invalid: UriVector[] } };

describe("shared raft URI contract vectors", () => {
  for (const vector of vectors.uri.valid) {
    it(`accepts ${vector.name}`, () => {
      const result = parseRaftUri(vector.uri);
      expect(result).not.toBeNull();
      expect(result?.action).toBe(vector.action);
    });
  }

  for (const vector of vectors.uri.invalid) {
    it(`rejects ${vector.name}`, () => {
      expect(parseRaftUri(vector.uri)).toBeNull();
    });
  }
});
