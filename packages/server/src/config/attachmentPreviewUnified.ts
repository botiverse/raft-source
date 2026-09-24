import {
  evaluateFeatureFlag,
  ATTACHMENT_PREVIEW_UNIFIED_FEATURE_FLAG_KEY,
} from "../services/featureFlagService.js";

const ATTACHMENT_PREVIEW_UNIFIED_APP_OVERRIDE = "attachmentPreviewUnifiedEnabled";

type AppSettingsReader = { get(name: string): unknown };
type AppSettingsWriter = { set(name: string, value: unknown): unknown };

/**
 * Gate for the unified attachment preview surfaces.
 *
 * Separate from `message_forwarding_v0` on purpose: forwarding gates a feature
 * (its endpoint 404s when off), while this covers behaviour the chat body also
 * uses. Sharing one switch would mean disabling forwarding silently removed
 * chat-side preview behaviour too.
 *
 * DEFAULTS ON when no flag row exists. This is a kill switch over behaviour
 * that already shipped, so "nobody has created the flag yet" must not mean
 * "attachments stop previewing" — an environment that never heard of this flag
 * is exactly the environment that had previews before it existed. Only a flag
 * that exists and evaluates disabled turns it off, which is what makes the
 * switch a deliberate act rather than a consequence of absence.
 *
 * This is a fix, not a design choice made twice: the first version returned
 * `evaluation.enabled` directly, which is `false` with reason `missing_flag`
 * on any database without the row. Every fresh environment — including CI's
 * e2e — therefore lost document, HTML, audio and video previews, which is how
 * it reached staging (the e2e suites do not run on PRs).
 */
export function resolveAttachmentPreviewUnified(evaluation: {
  enabled: boolean;
  reason?: string;
}): boolean {
  if (evaluation.reason === "missing_flag") return true;
  return evaluation.enabled;
}

export async function isAttachmentPreviewUnifiedEnabledForServer(input: {
  app?: AppSettingsReader;
  userId?: string | null;
  serverId?: string | null;
}): Promise<boolean> {
  const override = input.app?.get(ATTACHMENT_PREVIEW_UNIFIED_APP_OVERRIDE);
  if (typeof override === "boolean") return override;
  const evaluation = await evaluateFeatureFlag({
    key: ATTACHMENT_PREVIEW_UNIFIED_FEATURE_FLAG_KEY,
    userId: input.userId,
    serverId: input.serverId,
  });
  return resolveAttachmentPreviewUnified(evaluation);
}

export function setAttachmentPreviewUnifiedEnabledForApp(app: AppSettingsWriter, enabled: boolean) {
  app.set(ATTACHMENT_PREVIEW_UNIFIED_APP_OVERRIDE, enabled);
}
