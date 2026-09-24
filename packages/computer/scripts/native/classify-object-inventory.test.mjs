import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const script = fileURLToPath(
  new URL("./classify-object-inventory.mjs", import.meta.url),
);

function classify(response, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    input: typeof response === "string" ? response : JSON.stringify(response),
  });
}

function classifyAfterFailingUpstream(response) {
  return spawnSync(
    "bash",
    [
      "-o",
      "pipefail",
      "-c",
      'sh -c \'printf "%s" "$INVENTORY"; exit 23\' | "$NODE_BIN" "$CLASSIFIER"',
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CLASSIFIER: script,
        INVENTORY: JSON.stringify(response),
        NODE_BIN: process.execPath,
      },
    },
  );
}

test("classifies the historical empty R2 response as zero objects", () => {
  const result = classify({});

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "0\n");
  assert.equal(result.stderr, "");
});

test("classifies canonical empty and non-empty S3 responses", () => {
  const empty = classify({ KeyCount: 0, Contents: [] });
  assert.equal(empty.status, 0);
  assert.equal(empty.stdout, "0\n");

  const nonEmpty = classify({
    KeyCount: 1,
    Contents: [{ Key: "manifest.json" }],
  });
  assert.equal(nonEmpty.status, 0);
  assert.equal(nonEmpty.stdout, "1\n");
});

test("accepts omitted KeyCount when Contents is authoritative", () => {
  const result = classify({ Contents: [{ Key: "candidate-receipt.json" }] });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "1\n");
});

test("classifies a truncated non-empty page only as non-empty", () => {
  const result = classify({
    Contents: [{ Key: "candidate-receipt.json" }],
    IsTruncated: true,
    KeyCount: 1,
    NextContinuationToken: "next-page",
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "1\n");
  assert.equal(result.stderr, "");
});

test("fails closed on incomplete pagination when a complete page is required", () => {
  for (const response of [
    {
      Contents: [{ Key: "candidate-receipt.json" }],
      IsTruncated: true,
      KeyCount: 1,
    },
    {
      Contents: [{ Key: "candidate-receipt.json" }],
      NextContinuationToken: "next-page",
      KeyCount: 1,
    },
  ]) {
    const result = classify(response, ["--require-complete"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Could not classify object inventory/);
  }
});

test("rejects unknown classifier options", () => {
  const result = classify({}, ["--unknown"]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Could not classify object inventory/);
});

test("preserves an upstream transport failure under pipefail", () => {
  const result = classifyAfterFailingUpstream({});

  assert.equal(result.status, 23);
});

test("fails closed on malformed or contradictory inventory responses", () => {
  for (const response of [
    "not-json",
    "null",
    JSON.stringify({ Contents: {} }),
    JSON.stringify({ KeyCount: "0", Contents: [] }),
    JSON.stringify({ KeyCount: 1, Contents: [] }),
    JSON.stringify({ Contents: [{}] }),
    JSON.stringify({ IsTruncated: true }),
  ]) {
    const result = classify(response);
    assert.notEqual(result.status, 0, response);
    assert.equal(result.stdout, "", response);
    assert.match(
      result.stderr,
      /Could not classify object inventory/,
      response,
    );
  }
});
