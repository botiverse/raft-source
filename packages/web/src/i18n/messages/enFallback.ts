// The English words code outside React reads synchronously: a fallback where
// there is no IntlProvider (ProgressBar, FormField, ...), English text a store
// keeps (agentStore, liveAgentActivity), and the English formatters for
// non-React callers (utils/activity.ts, utils/computerUpgradeIndicator.ts),
// and the refresh and crash screens when the catalogs themselves did not load
// (IntlProviderWrapper `recovery`).
//
// en.ts is a lazy chunk like every other catalog (messages/index.ts), so a
// Simplified Chinese reader never downloads it; these few strings stay in the
// app shell instead. Each one is copied from en.ts and must stay equal to it
// (tests/enFallback.test.ts compares them, and checks the formatters above
// only use ids listed here).

import type { MessageId } from "./en";

export const enFallback = {
  "agent.runtimeError.rootPrivileges": "Claude Code cannot start with root or sudo privileges while permission checks are disabled. Run Raft Computer as a non-root user, then start the agent again.",
  "agent.runtimeError.code.authRequired.title": "Sign-in required",
  "agent.runtimeError.code.billing.title": "Provider balance exhausted",
  "agent.runtimeError.code.inputTooLarge.title": "Input too large",
  "agent.runtimeError.code.messageTooLarge.title": "Message too long",
  "agent.runtimeError.code.modelUnavailable.title": "Model not available",
  "agent.runtimeError.code.networkTimeout.title": "Provider unreachable",
  "agent.runtimeError.code.usageLimit.title": "Usage limit reached",
  "agent.status.credentialInvalid.billing": "Provider balance exhausted",
  "agent.status.credentialInvalid.planDefaultModel": "Plan doesn't include this model",
  "agent.status.credentialInvalid.planModel": "Plan doesn't include {model}",
  "agent.status.credentialInvalid.signIn": "Sign-in needed for {runtime}",
  "activity.live.agentFallback": "Agent",
  "activity.log.freshnessHold.send": "Reading new messages before sending",
  "activity.log.freshnessHold.taskAmend": "Reading new messages before changing the task",
  "activity.log.freshnessHold.taskClaim": "Reading new messages before claiming the task",
  "activity.log.freshnessHold.taskUpdate": "Reading new messages before updating the task",
  "activity.log.status.stopped": "Stopped",
  "activity.status.agentErrorFallback": "Agent encountered an error",
  "activity.status.autoRestartPaused": "{detail} — automatic restarts are paused until you change the model or API key, or restart the agent",
  "activity.status.compactingContextEllipsis": "Compacting context…",
  "activity.status.deliveryUnconsumed": "Messages delivered, runtime not responding",
  "activity.status.error": "Error",
  "activity.status.errorWithDetail": "Error: {detail}",
  "activity.status.lastActive": "Last active {time}",
  "activity.status.likelyOnline": "Likely online",
  "activity.status.modelNotFound": "Model \"{model}\" is not available for this runtime — it may have been renamed or removed, or its provider has no API key on this computer. Pick another model or fix the key in the agent settings",
  "activity.status.modelUnsupported": "This runtime's account or plan doesn't include \"{model}\". Change the model, or sign in with an account that includes it",
  "activity.status.modelUnsupportedDefault": "This runtime's account or plan doesn't include this agent's model. Change the model, or sign in with an account that includes it",
  "activity.status.repeatedFailurePaused": "Kept failing the same way after starting — automatic wakes are paused; Raft tries again by itself later. Restart the agent to try now",
  "activity.status.repeatedFailurePausedAt": "Kept failing the same way after starting — automatic wakes are paused; Raft tries again by itself at {time}. Restart the agent to try now",
  "activity.status.offline": "Offline",
  "activity.status.online": "Online",
  "activity.status.providerApiKeyInvalid": "Couldn't start: there's a problem with the API key. Copy the full key again from your provider's dashboard, save, and retry.",
  "activity.status.runtimeUnavailablePaused": "{detail} — automatic wakes are paused until the runtime is available on this computer, or you move the agent or switch its runtime",
  "activity.status.sessionNeedsReset": "The context is too large and shrinking it automatically didn't fix it. Reset the session and restart; if one message is itself very large, switch to a model with a larger context or split the content.",
  "activity.status.startTimeoutPaused": "{detail} — automatic wakes are paused; Raft tries again by itself later. Restart the agent or switch its model to resume now",
  "activity.status.startTimeoutPausedAt": "{detail} — automatic wakes are paused; Raft tries again by itself at {time}. Restart the agent or switch its model to resume now",
  "activity.status.startingEllipsis": "Starting…",
  "activity.status.stoppedUnavailable": "Stopped — won't receive messages until restarted",
  "activity.status.terminalFailurePaused": "Automatic wake paused after repeated runtime failures — a manual start lifts it",
  "activity.status.thinkingEllipsis": "Thinking…",
  "activity.status.wakeCrashLoopBlocked": "Automatic wake paused — start manually",
  "activity.status.workingEllipsis": "Working…",
  "agent.avatar.alt": "Agent avatar",
  "agent.status.computerOffline": "Computer offline",
  "agent.status.computerAccessRevoked": "Computer access revoked: move the agent to another computer (re-attaching adds a new one)",
  "agent.status.computerTooOld": "Computer update required",
  "app.update.continueAnyway": "Continue anyway",
  "app.update.dismiss": "Dismiss",
  "app.update.newerVersionAvailable": "A newer version of Raft is available.",
  "app.update.refresh": "Refresh",
  "app.update.refreshNow": "Refresh now",
  "app.update.refreshToContinue": "Refresh Raft to continue",
  "app.update.staleBuildBody": "This tab is running an older app build. Refresh to load the current version; unsent text or unsaved changes in this tab may be lost.",
  "assistant.paused.chip": "Paused",
  "errorBoundary.componentStack": "Component stack",
  "errorBoundary.reloadApp": "Reload app",
  "errorBoundary.openHome": "Open Raft home",
  "errorBoundary.stack": "Stack trace",
  "errorBoundary.title": "Something went wrong",
  "errors.traceId.label": "Trace ID",
  "errors.traceId.copy": "Copy trace ID",
  "errors.traceId.copied": "Trace ID copied",
  "layout.systemNotifications.computerAttentionOfflineCount": "{count} offline",
  "layout.systemNotifications.computerAttentionUpgradeCount": "{count, plural, one {# needs upgrade} other {# need upgrade}}",
  "machine.attention.offline": "Computer offline",
  "machine.attention.status": "Computer status",
  "machine.attention.upgradeAvailable": "Update available",
  "machine.attention.upgradeAvailableOffline": "Update available · Offline",
  "machine.attention.upgradeAvailableOfflineWithVersion": "Update available: v{version} · Offline",
  "machine.attention.upgradeAvailableWithVersion": "Update available: v{version}",
  "message.content.collapse": "Collapse",
  "message.content.showMore": "Show more",
  "message.mention.agentRead": "Read",
  "ui.formField.optional": "(optional)",
  "ui.progressBar.ariaLabel": "Progress",
} as const satisfies Partial<Record<MessageId, string>>;

export type EnFallbackId = keyof typeof enFallback;

/**
 * The same strings as a react-intl message map, for createIntl in the English
 * formatters. Only the ids above are present: tests/enFallback.test.ts checks
 * those formatters ask for no other.
 */
export const enFallbackMessages = enFallback as Partial<Record<MessageId, string>> as Record<MessageId, string>;
