import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { describe, expect, it } from "vitest";

interface NamedValue {
  name: string;
  value: unknown;
  schemaInvalid?: boolean;
}

const vectors = JSON.parse(
  readFileSync(join(__dirname, "../../fixtures/contract-vectors.json"), "utf8"),
) as { manifest: { valid: NamedValue[]; invalid: NamedValue[] } };
const schema = JSON.parse(
  readFileSync(
    join(__dirname, "../../schemas/desktop-manifest.schema.json"),
    "utf8",
  ),
);
const validate = new Ajv({ allErrors: true }).compile(schema);

describe("JSON schema matches shared manifest vectors", () => {
  for (const vector of vectors.manifest.valid) {
    it(`accepts ${vector.name}`, () => {
      expect(validate(vector.value), JSON.stringify(validate.errors)).toBe(true);
    });
  }

  for (const vector of vectors.manifest.invalid) {
    it(`rejects ${vector.name}`, () => {
      expect(validate(vector.value)).toBe(vector.schemaInvalid === false);
    });
  }
});
