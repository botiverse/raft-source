import assert from "node:assert/strict";
import { test } from "vitest";

import { createWindowsPowerShellChildEnv } from "./windowsPowerShellEnv.js";

test("Windows PowerShell child env removes every PSModulePath case variant without mutating the source", () => {
  const source: NodeJS.ProcessEnv = {
    Path: "C:\\Windows\\System32",
    PSModulePath: "C:\\Program Files\\PowerShell\\Modules",
    psmodulepath: "C:\\Users\\test\\Documents\\PowerShell\\Modules",
    TASK_ENV: "present",
  };
  const original = { ...source };

  const childEnv = createWindowsPowerShellChildEnv(source);

  assert.deepEqual(childEnv, {
    Path: "C:\\Windows\\System32",
    TASK_ENV: "present",
  });
  assert.deepEqual(source, original);
  assert.notStrictEqual(childEnv, source);
});

test("Windows PowerShell child env sanitizes the inherited process env when no env is supplied", () => {
  const previous = process.env.PSModulePath;
  process.env.PSModulePath = "C:\\Program Files\\PowerShell\\7\\Modules";
  try {
    const childEnv = createWindowsPowerShellChildEnv(undefined);

    assert.equal(
      Object.keys(childEnv).some((key) => key.toLowerCase() === "psmodulepath"),
      false,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.PSModulePath;
    } else {
      process.env.PSModulePath = previous;
    }
  }
});
