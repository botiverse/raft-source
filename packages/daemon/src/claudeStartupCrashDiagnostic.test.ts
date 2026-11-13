import { expect, test } from "vitest";
import { buildClaudeStartupCrashActivity } from "./claudeStartupCrashDiagnostic";
const refusal = "--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons";
const process = { driver: { id: "claude" }, lastRuntimeError: null, recentStderr: [refusal] };

test("only Claude's exact startup refusal gets fixed guidance", () => {
  expect(buildClaudeStartupCrashActivity(process, true, "exit code 1", 1).detail).toContain("Run Raft Computer as a non-root user");
  expect(buildClaudeStartupCrashActivity({ ...process, driver: { id: "codex" } }, true, "exit code 1", 1).detail).toBe("Crashed (exit code 1)");
  expect(buildClaudeStartupCrashActivity(process, false, "exit code 1", 1).detail).toBe("Crashed (exit code 1)");
  for (const line of ["TypeError: root is undefined", "permission denied", `Quoted error: ${refusal}`, `${refusal} private request body`]) {
    expect(buildClaudeStartupCrashActivity({ ...process, recentStderr: [line] }, true, "exit code 1", 1).detail).toBe("Crashed (exit code 1)");
  }
});
