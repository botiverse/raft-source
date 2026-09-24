import { createInterface } from "node:readline/promises";

export type KTargetConsent = "confirmed" | "declined" | "non-interactive";

export interface KTargetConsentDeps {
  isInteractive?: () => boolean;
  ask?: (prompt: string) => Promise<string>;
}

async function askOnTerminal(prompt: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(prompt);
  } finally {
    terminal.close();
  }
}

/**
 * Bind confirmation to the exact version resolved for this one transaction.
 * A non-interactive caller must supply `--target-version`; broad approval of
 * a moving channel is not K consent for whichever version happens to resolve.
 */
export async function requestKTargetConsent(
  targetVersion: string,
  deps: KTargetConsentDeps = {},
): Promise<KTargetConsent> {
  const interactive = deps.isInteractive
    ? deps.isInteractive()
    : process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (!interactive) return "non-interactive";
  const answer = (await (deps.ask ?? askOnTerminal)(
    `Install Raft Computer ${targetVersion}? [y/N] `,
  )).trim().toLowerCase();
  return answer === "y" || answer === "yes" ? "confirmed" : "declined";
}
