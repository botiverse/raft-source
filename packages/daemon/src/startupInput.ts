// The first input of a launch (the start "ladder"), shared by every agent host
// (AgentProcessManager and the OAR host) so an agent sees the same first
// input whichever host runs it. Pure: what the start carries in, the trigger
// input and the facts about it out. Moved from AgentProcessManager; the caller
// then adds the startup memory block and, for a fresh session of a runtime
// without a native standing prompt, the standing prompt in front
// (`applyFreshSessionStandingPrompt`).

import type { AgentConfig, AgentMessage } from "@botiverse/raft-shared";
import {
  NATIVE_STANDING_PROMPT_STARTUP_INPUT,
  adoptAxSurfaceText,
  composeAxSurfaces,
  formatBoundedStartupUnreadSuffix,
  formatConcreteMessagesRuntimeInput,
  formatInboxUpdateRuntimeInput,
  inboxUpdateRenderOptions,
  formatOtherUnreadChannelsSuffix,
  formatResumeEmptyPrompt,
  formatResumeUnreadSummaryPrompt,
  formatRuntimeProfileControlCatchupLead,
  formatRuntimeProfileControlPrompt,
  formatRuntimeProfileControlStartupInput,
  formatSystemNoticeRuntimeInput,
  runtimeProfileNotificationFromMessage,
  type AxSurfaceText,
} from "./agentRuntimeInput";
import type { RuntimeDriver } from "./drivers/types";
import { deriveForegroundTurnOrigin } from "./foregroundTurnOrigin";
import type { RuntimeTurnOrigin } from "./runtimeTurnOrigin";

/** `projectThreadJoinContextsForRuntimeInput` bound to the agent's visible boundary. */
export type ThreadJoinContextProjector = (
  messages: readonly AgentMessage[],
  renderContext?: boolean,
) => { messages: AgentMessage[]; renderedContextMessages: AgentMessage[] };

export interface StartupInputRequest {
  driver: RuntimeDriver;
  runtimeConfig: AgentConfig;
  /** A native session is resumed, or a recycled one keeps the resume ladder. */
  isResume: boolean;
  /** The standing prompt this launch builds reaches the session natively (fresh, or the runtime rebuilds it on resume). */
  standingPromptReachesSession: boolean;
  /**
   * The caller puts the standing prompt ahead of this input
   * (`standingPromptGoesInFirstInput` / `applyFreshSessionStandingPrompt`): a
   * fresh session of a runtime without a native standing prompt.
   */
  standingPromptInFirstInput: boolean;
  wakeMessage?: AgentMessage;
  wakeMessageTransient: boolean;
  resumePrompt?: string;
  resumeMessages?: AgentMessage[];
  unreadSummary?: Record<string, number>;
  /** Messages delivered while the start was pending. */
  startingInboxMessages: AgentMessage[];
  projectThreadJoinContexts: ThreadJoinContextProjector;
}

export interface StartupInputPlan {
  prompt: AxSurfaceText;
  promptSource: string;
  wakeMessageDeliveredAsInboxUpdate: boolean;
  /** Task #389: exactly the messages the spawn prompt announced. */
  spawnAnnouncedMessages: AgentMessage[];
  /** Exactly the messages the start prompt's inbox notice lists (empty when it has none). */
  inboxNoticeMessages: AgentMessage[];
  wakeMessageDeliveredWithThreadContext: boolean;
  startingInboxDeliveredAsInput: boolean;
  resumeCatchupDeliveredAsInput: boolean;
  /** A caller-supplied resume prompt replaced the wake message, which stays pending, unconsumed. */
  wakeMessageWithheldByResumePrompt: boolean;
  /** The unread summary's targets went into the start input with their counts. */
  unreadSummaryShown: boolean;
  renderedStartupThreadContextMessages: AgentMessage[];
  startingInboxMessages: AgentMessage[];
  resumeCatchupMessages: AgentMessage[];
  resumeCatchupInputMessages: AgentMessage[];
  wakeMessageProjection: ReturnType<ThreadJoinContextProjector>;
  resumeCatchupProjection: ReturnType<ThreadJoinContextProjector>;
  startingInboxProjection: ReturnType<ThreadJoinContextProjector>;
  /** The messages whose body (not a content-free notice) the first input carries. */
  startupBodyMessages: readonly AgentMessage[];
  /** task #9: the messages this launch's first input names. */
  firstInputMessages: readonly AgentMessage[];
  /** task #21: the single message the first input answers, or null. */
  startOrigin: RuntimeTurnOrigin | null;
}

export function planStartupInput(request: StartupInputRequest): StartupInputPlan {
  const {
    driver,
    runtimeConfig,
    isResume,
    standingPromptReachesSession,
    standingPromptInFirstInput,
    wakeMessage,
    wakeMessageTransient,
    resumePrompt,
    resumeMessages,
    unreadSummary,
    startingInboxMessages,
  } = request;
  let prompt: AxSurfaceText;
  let promptSource: string;
  let wakeMessageDeliveredAsInboxUpdate = false;
  // Task #389: exactly the messages the spawn prompt announced, captured when
  // the prompt is built; anything arriving during the start is not in it.
  let spawnAnnouncedMessages: AgentMessage[] = [];
  let inboxNoticeMessages: AgentMessage[] = [];
  let wakeMessageDeliveredWithThreadContext = false;
  let startingInboxDeliveredAsInput = false;
  let resumeCatchupDeliveredAsInput = false;
  // A caller-supplied resume prompt replaces the wake message as the first
  // input, so the wake is never shown: it stays pending, unconsumed.
  let wakeMessageWithheldByResumePrompt = false;
  // The unread summary's targets went into the start input with their counts.
  let unreadSummaryShown = false;
  let renderedStartupThreadContextMessages: AgentMessage[] = [];
  // task #1221: a start that follows a start-failure block carries the
  // messages refused as wakes during it, including for a session-less agent
  // (the server only sends resumeMessages then, or for a resumed session).
  const resumeCatchupMessages = !wakeMessage && !resumePrompt ? (resumeMessages ?? []) : [];
  const resumeCatchupInputMessages = resumeCatchupMessages.length > 0
    ? [...resumeCatchupMessages, ...startingInboxMessages]
    : [];
  const wakeMessageProjection = request.projectThreadJoinContexts(
    wakeMessage ? [wakeMessage] : [],
    wakeMessageTransient !== true,
  );
  const resumeCatchupProjection = request.projectThreadJoinContexts(resumeCatchupInputMessages);
  const startingInboxProjection = request.projectThreadJoinContexts(startingInboxMessages);
  const inboxOptions = inboxUpdateRenderOptions(runtimeConfig);
  // The release notice is part of the standing prompt; when that reaches the
  // session (natively or in this input), the input need not repeat it.
  const standingPromptCarriesControl = (driver.supportsNativeStandingPrompt && standingPromptReachesSession) || standingPromptInFirstInput;
  // RFC 071 F9: a control start that also carries the owed resume catch-up
  // takes the catch-up branch below (the notice rides ahead of it), as a
  // control start with a wake message takes the wake branch. The control
  // notice never replaces the catch-up: the server counts this launch as the
  // one that delivered it.
  if (runtimeConfig.runtimeProfileControl && !wakeMessage && resumeCatchupInputMessages.length === 0) {
    // A neutral starter is enough when the standing prompt carries the notice.
    prompt = standingPromptCarriesControl
      ? NATIVE_STANDING_PROMPT_STARTUP_INPUT
      : formatRuntimeProfileControlStartupInput(runtimeConfig.runtimeProfileControl, driver);
    promptSource = "runtime_profile_control";
  } else if (isResume && resumePrompt) {
    prompt = adoptAxSurfaceText(resumePrompt);
    promptSource = "resume_prompt";
    wakeMessageWithheldByResumePrompt = Boolean(wakeMessage) && wakeMessageTransient !== true;
  } else if (wakeMessage) {
    const transientWakeMessage = wakeMessageTransient === true;
    const projectedWakeMessage = wakeMessageProjection.messages[0];
    const runtimeProfileControlPrompt = transientWakeMessage ? null : formatRuntimeProfileControlPrompt([projectedWakeMessage]);
    if (transientWakeMessage) {
      prompt = formatSystemNoticeRuntimeInput(projectedWakeMessage, driver);
    } else if (runtimeProfileControlPrompt) {
      prompt = runtimeProfileControlPrompt;
    } else if (wakeMessageProjection.renderedContextMessages.length > 0) {
      wakeMessageDeliveredWithThreadContext = true;
      renderedStartupThreadContextMessages = wakeMessageProjection.renderedContextMessages;
      inboxNoticeMessages = startingInboxMessages;
      const pendingInboxNotice = startingInboxMessages.length > 0
        ? formatInboxUpdateRuntimeInput(startingInboxMessages, driver, startingInboxMessages.length, inboxOptions)
        : undefined;
      prompt = formatConcreteMessagesRuntimeInput([projectedWakeMessage], driver, pendingInboxNotice);
    } else {
      wakeMessageDeliveredAsInboxUpdate = true;
      spawnAnnouncedMessages = [wakeMessage, ...startingInboxMessages];
      inboxNoticeMessages = spawnAnnouncedMessages;
      prompt = formatInboxUpdateRuntimeInput(spawnAnnouncedMessages, driver, undefined, inboxOptions);
    }
    promptSource = transientWakeMessage
      ? "transient_wake_message"
      : runtimeProfileControlPrompt
        ? "runtime_profile_control_message"
        : wakeMessageDeliveredWithThreadContext
          ? "wake_thread_context"
        : "wake_inbox_update";

    if (!transientWakeMessage && !runtimeProfileControlPrompt) {
      prompt = composeAxSurfaces(prompt, formatOtherUnreadChannelsSuffix(unreadSummary));
      unreadSummaryShown = true;
    }
  } else if (resumeCatchupInputMessages.length > 0) {
    resumeCatchupDeliveredAsInput = true;
    renderedStartupThreadContextMessages = resumeCatchupProjection.renderedContextMessages;
    prompt = formatConcreteMessagesRuntimeInput(resumeCatchupProjection.messages, driver);
    promptSource = "resume_catchup_inbox";

    prompt = composeAxSurfaces(prompt, formatBoundedStartupUnreadSuffix(unreadSummary));
    unreadSummaryShown = true;
    // RFC 071 F9: a release notice this start also carries goes first, unless
    // the standing prompt that reaches the session already holds it.
    if (runtimeConfig.runtimeProfileControl && !standingPromptCarriesControl) {
      prompt = composeAxSurfaces(formatRuntimeProfileControlCatchupLead(runtimeConfig.runtimeProfileControl, driver), prompt);
    }
  } else if (startingInboxMessages.length > 0) {
    startingInboxDeliveredAsInput = true;
    renderedStartupThreadContextMessages = startingInboxProjection.renderedContextMessages;
    if (renderedStartupThreadContextMessages.length > 0) {
      const renderedSet = new Set(renderedStartupThreadContextMessages);
      const pendingMessages = startingInboxMessages.filter((message) => !renderedSet.has(message));
      inboxNoticeMessages = pendingMessages;
      const pendingInboxNotice = pendingMessages.length > 0
        ? formatInboxUpdateRuntimeInput(pendingMessages, driver, pendingMessages.length, inboxOptions)
        : undefined;
      prompt = formatConcreteMessagesRuntimeInput(
        renderedStartupThreadContextMessages,
        driver,
        pendingInboxNotice,
      );
      promptSource = "starting_thread_context";
      spawnAnnouncedMessages = pendingMessages.filter((message) => !runtimeProfileNotificationFromMessage(message));
    } else {
      inboxNoticeMessages = startingInboxMessages;
      prompt = formatInboxUpdateRuntimeInput(startingInboxMessages, driver, undefined, inboxOptions);
      promptSource = "starting_inbox_update";
      spawnAnnouncedMessages = startingInboxMessages.filter((message) => !runtimeProfileNotificationFromMessage(message));
    }
  } else if (isResume && unreadSummary && Object.keys(unreadSummary).length > 0) {
    prompt = formatResumeUnreadSummaryPrompt(unreadSummary, driver);
    promptSource = "resume_unread_summary";
    unreadSummaryShown = true;
  } else if (isResume) {
    prompt = formatResumeEmptyPrompt(driver);
    promptSource = "resume_empty";
  } else {
    // Native drivers carry the standing prompt themselves; the others get it
    // ahead of this starter (the caller's applyFreshSessionStandingPrompt).
    prompt = NATIVE_STANDING_PROMPT_STARTUP_INPUT;
    promptSource = "cold_start";
  }
  // The messages whose body (not a content-free notice) the first input
  // carries: the single list for model-seen reporting, spawn consumption of
  // a starting inbox, and the third-party delivered report. A transient
  // system notice and a runtime-profile control prompt are never third-party
  // events, and a resume prompt shows no message.
  const startupBodyMessages: readonly AgentMessage[] = wakeMessageDeliveredWithThreadContext && wakeMessage
    ? [wakeMessage, ...renderedStartupThreadContextMessages]
    : resumeCatchupDeliveredAsInput
      ? [...resumeCatchupInputMessages, ...renderedStartupThreadContextMessages]
      : startingInboxDeliveredAsInput
        ? renderedStartupThreadContextMessages
        : [];
  // task #9: the messages this launch's first input names (tracked mentions
  // among them count as told to this process).
  const firstInputMessages: readonly AgentMessage[] =
    promptSource === "wake_inbox_update" || promptSource === "wake_thread_context" || promptSource === "transient_wake_message"
      ? [...(wakeMessage ? [wakeMessage] : []), ...(promptSource === "transient_wake_message" ? [] : startingInboxMessages)]
      : promptSource === "resume_catchup_inbox"
        ? resumeCatchupInputMessages
        : promptSource === "starting_thread_context" || promptSource === "starting_inbox_update"
          ? startingInboxMessages
          : [];
  // task #21: a start names an origin only when its input carries a single concrete message
  // envelope (@peng msg 4b57d30e). That is the wake message or the messages buffered during start,
  // whether they render as thread context or as a content-free inbox notice. Everything else has no
  // envelope and is null: transient system notices, runtime-profile control, resume prompts
  // (including an app-inbox notice passed as one), unread summaries, and cold start. Resume
  // CATCH-UP (`resume_catchup_inbox`) is null too: those are unread messages re-driven after an
  // offline period, not a new message that triggered this wake. Whether the native session is
  // resumed is not an authority dimension -- a resumed session woken by one new message qualifies.
  // ⚠️ Derived HERE, while the prompt's inputs are still what the prompt was built from: the
  // starting inbox array is handed to the process and drained before the start call, so reading
  // it there sees it empty (caught by managedMcpOrigin.daemon.e2e.test.ts).
  const startOrigin = promptSource === "wake_thread_context" || promptSource === "wake_inbox_update"
    ? deriveForegroundTurnOrigin(wakeMessage ? [wakeMessage, ...startingInboxMessages] : [])
    : promptSource === "starting_thread_context" || promptSource === "starting_inbox_update"
      ? deriveForegroundTurnOrigin(startingInboxMessages)
      : null;
  return {
    prompt,
    promptSource,
    wakeMessageDeliveredAsInboxUpdate,
    spawnAnnouncedMessages,
    inboxNoticeMessages,
    wakeMessageDeliveredWithThreadContext,
    startingInboxDeliveredAsInput,
    resumeCatchupDeliveredAsInput,
    wakeMessageWithheldByResumePrompt,
    unreadSummaryShown,
    renderedStartupThreadContextMessages,
    startingInboxMessages,
    resumeCatchupMessages,
    resumeCatchupInputMessages,
    wakeMessageProjection,
    resumeCatchupProjection,
    startingInboxProjection,
    startupBodyMessages,
    firstInputMessages,
    startOrigin,
  };
}
