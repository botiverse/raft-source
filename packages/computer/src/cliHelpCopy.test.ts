import assert from "node:assert/strict";
import { program } from "./cli";

test("root help has no reset verb", () => {
  const help = program.helpInformation();
  assert.doesNotMatch(help, /\n\s+reset\b/, "reset should not appear in primary help");
  assert.equal(
    program.commands.find((child) => child.name() === "reset"),
    undefined,
    "reset should not be registered as a user-facing CLI verb",
  );
});

test("root help does not expose a public JSON error flag", () => {
  const help = program.helpInformation();
  assert.doesNotMatch(help, /--json\b/);
});
