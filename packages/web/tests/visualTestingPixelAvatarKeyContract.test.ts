import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// task #536 / #534: the shared fixture carried `pixel:paint` for weeks. "paint" is
// not a registry key, so web and Android each fell back differently and the
// react<->android diff blamed rendering. Nothing in the chain said a word.
// This pins every `pixel:` value in visual-testing/shared/*.json to the registry.

const registry = JSON.parse(
  readFileSync(new URL("../assets/avatars/pixelAvatars.json", import.meta.url), "utf8"),
) as { avatars: Record<string, unknown>; reservedKeys?: string[]; defaultKey?: string };

const sharedDir = new URL("../../visual-testing/shared/", import.meta.url);

function collectPixelValues(value: unknown, path: string, out: Array<{ path: string; value: string }>): void {
  if (typeof value === "string") {
    if (value.startsWith("pixel:")) out.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectPixelValues(item, `${path}[${index}]`, out));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectPixelValues(child, `${path}.${key}`, out);
    }
  }
}

/** Same grammar as PixelAvatar.parsePixelAvatar: "pixel:<key>" or "pixel:random:<seed>". */
export function pixelAvatarValueProblem(value: string, avatars: Record<string, unknown>, reserved: string[]): string | null {
  const body = value.slice("pixel:".length);
  if (body.startsWith("random:")) {
    return body.length > "random:".length ? null : "random form needs a seed";
  }
  if (reserved.includes(body)) return `key "${body}" is reserved, not renderable`;
  if (!(body in avatars)) return `key "${body}" is not in pixelAvatars.json`;
  return null;
}

test("every pixel: value in the shared visual fixtures names a registry key", () => {
  const files = readdirSync(sharedDir).filter((name) => name.endsWith(".json"));
  assert.ok(files.length > 0, "no shared fixture json found — the walker has nothing to scan");
  const found: Array<{ path: string; value: string }> = [];
  for (const name of files) {
    const data = JSON.parse(readFileSync(new URL(name, sharedDir), "utf8")) as unknown;
    collectPixelValues(data, name, found);
  }
  // Positive control: a walker that finds nothing must not pass.
  assert.ok(found.length > 0, "no pixel: values found in any shared fixture — walker or fixtures changed shape");

  const problems = found
    .map((hit) => ({ ...hit, problem: pixelAvatarValueProblem(hit.value, registry.avatars, registry.reservedKeys ?? []) }))
    .filter((hit) => hit.problem !== null);
  assert.deepEqual(problems, [], `invalid pixel avatar values: ${JSON.stringify(problems, null, 2)}`);
});

test("the predicate rejects the exact value that slipped through (mutation control)", () => {
  const reserved = registry.reservedKeys ?? [];
  assert.equal(pixelAvatarValueProblem("pixel:paint", registry.avatars, reserved), 'key "paint" is not in pixelAvatars.json');
  assert.equal(pixelAvatarValueProblem("pixel:random:", registry.avatars, reserved), "random form needs a seed");
  for (const key of reserved) {
    assert.match(pixelAvatarValueProblem(`pixel:${key}`, registry.avatars, reserved) ?? "", /reserved/);
  }
  assert.equal(pixelAvatarValueProblem(`pixel:${registry.defaultKey ?? "robot"}`, registry.avatars, reserved), null);
  assert.equal(pixelAvatarValueProblem("pixel:random:seed-1", registry.avatars, reserved), null);
});
