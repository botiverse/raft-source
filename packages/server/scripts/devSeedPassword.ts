/**
 * Seed-account passwords for raftdev. `raftdev preview --with-agent-runs`
 * passes a random RAFTDEV_SEED_PASSWORD: those instances run agents with the
 * machine's model credentials behind a public URL, so the well-known default
 * must not sign anyone in. `start` can reuse an existing Postgres container,
 * whose seed accounts were created with an earlier password, so an explicit
 * password is also written onto every existing seed account the seed would
 * otherwise have created. Without RAFTDEV_SEED_PASSWORD nothing existing is
 * touched (plain `raftdev start`/`seed` keep their behaviour).
 * Guard: scripts/devSeedPassword.test.ts.
 */
export const DEFAULT_SEED_PASSWORD = "password123";

/** The explicit seed password, or null when the default applies. */
export function explicitSeedPassword(env: NodeJS.ProcessEnv): string | null {
  const value = env.RAFTDEV_SEED_PASSWORD?.trim();
  return value ? value : null;
}

export function seedPassword(env: NodeJS.ProcessEnv): string {
  return explicitSeedPassword(env) ?? DEFAULT_SEED_PASSWORD;
}

/**
 * Called for a seed account that already existed. Re-hashes and stores the
 * explicit password (same hashing as account creation); returns whether it did.
 */
export async function resetExistingSeedUserPassword(options: {
  user: { id: string; email: string };
  explicitPassword: string | null;
  hash: (password: string) => Promise<string>;
  update: (userId: string, passwordHash: string) => Promise<void>;
}): Promise<boolean> {
  if (options.explicitPassword === null) return false;
  await options.update(options.user.id, await options.hash(options.explicitPassword));
  return true;
}
