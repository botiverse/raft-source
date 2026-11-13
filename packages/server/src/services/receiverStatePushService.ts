export const RECEIVER_STATE_PUSH_ENABLED_ENV = "SLOCK_RECEIVER_STATE_PUSH_ENABLED";

function isDefaultOnEnvEnabled(name: string, env: NodeJS.ProcessEnv): boolean {
  const raw = env[name];
  if (raw === undefined) return true;
  const value = raw.trim().toLowerCase();
  if (value === "") return true;
  return !(value === "0" || value === "false" || value === "no" || value === "off");
}

// Default-on emergency kill-switch for RFC041 receiver-state socket fanout.
// Operators can flip false/0/no/off to suppress emits while facts, versions,
// route responses, and snapshots continue to read/write normally.
export function isReceiverStatePushEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDefaultOnEnvEnabled(RECEIVER_STATE_PUSH_ENABLED_ENV, env);
}
