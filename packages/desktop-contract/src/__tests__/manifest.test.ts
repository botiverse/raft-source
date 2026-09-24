import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateManifestSchema } from "../manifest.js";

interface NamedValue {
  name: string;
  value: unknown;
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, "../../fixtures/contract-vectors.json"), "utf8"),
) as { manifest: { valid: NamedValue[]; invalid: NamedValue[] } };

describe("shared manifest contract vectors", () => {
  for (const vector of vectors.manifest.valid) {
    it(`accepts ${vector.name}`, () => {
      expect(validateManifestSchema(vector.value)).toBeNull();
    });
  }

  for (const vector of vectors.manifest.invalid) {
    it(`rejects ${vector.name}`, () => {
      expect(validateManifestSchema(vector.value)).not.toBeNull();
    });
  }
});
