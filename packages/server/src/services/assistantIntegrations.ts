/**
 * RFC 077 (task #7): a personal assistant may use exactly one Raft app, the
 * Reminder app, so it can schedule its own reminders (they wake it as agent
 * events). Every other app stays out of its reach: the integration list shows
 * it only that app and a login to any other is refused.
 */

/**
 * The client id this deployment names the Reminder app by, or null when it has
 * none. It may be an old id of that App: compare Apps with
 * assistantAllowedOAuthClientUuid, not with this string.
 */
export function assistantAllowedIntegrationClientId(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.REMINDER_APP_CLIENT_ID?.trim() || null;
}

export const ASSISTANT_INTEGRATION_NOT_ALLOWED_BODY = {
  error: "A personal assistant can only use the Reminder app.",
  code: "assistant_integration_not_allowed",
  suggestedNextAction: "Use the Reminder app for reminders; for anything else, tell your owner. Do not retry: this will not change.",
} as const;
