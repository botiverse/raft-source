/**
 * Kimi's Bash tool reports a command that exited non-zero as an error result
 * ("Command failed with exit code: N."): the command ran, so the tool call is
 * ok and the exit code is recorded. `isError` is optional in the SDK; when it
 * is absent the outcome is unknown and left out. Shared by the Kimi SDK and
 * Kimi CLI (wire) drivers, which see the same tool results.
 */
export function kimiToolResultOutcome(event: { isError?: boolean; output?: unknown }): { ok?: boolean; exitCode?: number } {
  if (event.isError !== true) return event.isError === false ? { ok: true } : {};
  const text = typeof event.output === "string" ? event.output : JSON.stringify(event.output ?? "").slice(0, 4096);
  const exit = /Command failed with exit code: (\d+)/.exec(text);
  return exit ? { ok: true, exitCode: Number(exit[1]) } : { ok: false };
}
