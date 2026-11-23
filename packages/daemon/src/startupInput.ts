// The first input of a launch (the start "ladder"), shared by every agent host
// (AgentProcessManager and the OAR host) so an agent sees the same first
// input whichever host runs it. Pure: what the start carries in, the trigger
// input and the facts about it out. Moved from AgentProcessManager; the caller
// then adds the startup memory block and, for a fresh session of a runtime
// without a native standing prompt, the standing prompt in front
// (`applyFreshSessionStandingPrompt`).

import type { AgentConfig, AgentMessage, AgentStartOpenTasks } from "@botiverse/raft-shared";
import {
  NATIVE_STANDING_PROMPT_STARTUP_INPUT,
  adoptAxSurfaceText,
  composeAxSurfaces,
  selectFocusedBodies,
  type FocusedBodyRowCause,
  formatBoundedStartupUnreadSuffix,
  formatConcreteMessagesRuntimeInput,
  formatInboxUpdateRuntimeInput,
  inboxUpdateRenderOptions,
  formatOtherUnreadChannelsSuffix,
  formatResumeEmptyPrompt,
  formatResumeOpenTasksPrompt,
  formatResumeUnreadSummaryPrompt,
  hasResumeOpenTasks,
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
  /**
   * The host's carrier decision: the standing prompt has a native carrier on
   * this host (legacy: the driver's flag; OAR host: also a launch that carries
   * it as a session option). Decided once by the host, never re-read here.
   */
  nativeStandingPrompt: boolean;
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
  /**
   * The open tasks the agent holds, as the server's `agent:start` named them
   * (only on a start that resumes its session with no wake message and no
   * resume prompt; absent from an older server). A resume with nothing else
   * to do lists them instead of telling the agent to stop.
   */
  openTasks?: AgentStartOpenTasks;
  /** Messages delivered while the start was pending. */
  startingInboxMessages: AgentMessage[];
  /** #proj-runtime:#80: true when an interrupted-turn handoff note rides on this start, so unread catch-up drops its unconditional stop. */
  continueAfterCatchup?: boolean;
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
  /** How many open tasks (of `openTasks`) the start input names; 0 when it names none. */
  openTasksShown: number;
  renderedStartupThreadContextMessages: AgentMessage[];
  startingInboxMessages: AgentMessage[];
  resumeCatchupMessages: AgentMessage[];
  resumeCatchupInputMessages: AgentMessage[];
  wakeMessageProjection: ReturnType<ThreadJoinContextProjector>;
  resumeCatchupProjection: ReturnType<ThreadJoinContextProjector>;
  startingInboxProjection: ReturnType<ThreadJoinContextProjector>;
  /** The messages whose body (not a content-free notice) the first input carries. */
  startupBodyMessages: readonly AgentMessage[];
  /**
   * Focus (docs/contracts/agent-focus.md): the messages of
   * `startupBodyMessages` tagged `focused`, while the start's config has
   * `agentFocus`; empty otherwise. A wake or starting-inbox message among
   * them is in full only because of the tag; a catch-up message is in full
   * anyway. `promptSource` does not tell the two apart.
   */
  focusedStartupBodies: readonly AgentMessage[];
  /**
   * Focus: the focused messages the first input lists as notice rows because
   * of a size limit (`selectFocusedBodies`), each with that limit. They are
   * handled as unfocused messages are; this is for the start's telemetry.
   */
  focusedStartupRows: ReadonlyArray<{ message: AgentMessage; limit: FocusedBodyRowCause }>;
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
    nativeStandingPrompt,
    standingPromptReachesSession,
    standingPromptInFirstInput,
    wakeMessage,
    wakeMessageTransient,
    resumePrompt,
    resumeMessages,
    unreadSummary,
    openTasks,
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
  let openTasksShown = 0;
  let renderedStartupThreadContextMessages: AgentMessage[] = [];
  // Focus: the messages the Server tagged `focused` are written in full. None
  // (always, unless the config has `agentFocus`) leaves every branch as it was.
  const focusOn = runtimeConfig.agentFocus === true;
  let focusedStartupBodies: AgentMessage[] = [];
  let focusedStartupRows: Array<{ message: AgentMessage; limit: FocusedBodyRowCause }> = [];
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
  const standingPromptCarriesControl = (nativeStandingPrompt && standingPromptReachesSession) || standingPromptInFirstInput;
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
    // A wake that brings its thread context is in full anyway: the size limits leave it alone.
    const wakeSelection = selectFocusedBodies(
      [wakeMessage, ...startingInboxMessages],
      focusOn && !transientWakeMessage && !runtimeProfileControlPrompt,
      new Set(wakeMessageProjection.renderedContextMessages.length > 0 ? [wakeMessage] : []),
    );
    const focusedAtWake = wakeSelection.bodies;
    focusedStartupRows = wakeSelection.rows;
    if (transientWakeMessage) {
      prompt = formatSystemNoticeRuntimeInput(projectedWakeMessage, driver);
    } else if (runtimeProfileControlPrompt) {
      prompt = runtimeProfileControlPrompt;
    } else if (focusedAtWake.length > 0) {
      // Focus: the wake message in full when it is focused (or brings its
      // thread context, as below), the focused messages that arrived during
      // the start in full under it, and the rest as the notice.
      focusedStartupBodies = focusedAtWake;
      const focusedSet = new Set(focusedAtWake);
      const wakeIsBody = wakeMessageProjection.renderedContextMessages.length > 0 || focusedSet.has(wakeMessage);
      const startingBodies = startingInboxMessages.filter((message) => focusedSet.has(message));
      const noticeMessages = [...(wakeIsBody ? [] : [wakeMessage]), ...startingInboxMessages.filter((message) => !focusedSet.has(message))];
      inboxNoticeMessages = noticeMessages;
      if (wakeIsBody) {
        wakeMessageDeliveredWithThreadContext = true;
        renderedStartupThreadContextMessages = wakeMessageProjection.renderedContextMessages;
        // The notice under the wake told these: recorded as told, so the turn end does not announce them again.
        spawnAnnouncedMessages = noticeMessages.filter((message) => !runtimeProfileNotificationFromMessage(message));
      } else {
        wakeMessageDeliveredAsInboxUpdate = true;
        spawnAnnouncedMessages = noticeMessages;
      }
      prompt = formatConcreteMessagesRuntimeInput(
        // As for a wake with thread context, a starting-inbox message brings no thread context of its own here.
        [...(wakeIsBody ? [projectedWakeMessage] : []), ...request.projectThreadJoinContexts(startingBodies, false).messages],
        driver,
        noticeMessages.length > 0
          ? formatInboxUpdateRuntimeInput(noticeMessages, driver, noticeMessages.length, inboxOptions)
          : undefined,
        { focus: true },
      );
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
    // Focus: a catch-up message is in full anyway; the tag adds the `focus_change` line and the read report.
    // So no size limit applies here: nothing would be saved by listing one as a row.
    focusedStartupBodies = selectFocusedBodies(resumeCatchupInputMessages, focusOn, new Set(resumeCatchupInputMessages)).bodies;
    prompt = focusedStartupBodies.length > 0
      ? formatConcreteMessagesRuntimeInput(resumeCatchupProjection.messages, driver, undefined, { focus: true })
      : formatConcreteMessagesRuntimeInput(resumeCatchupProjection.messages, driver);
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
    const startingSelection = selectFocusedBodies(startingInboxMessages, focusOn, new Set(renderedStartupThreadContextMessages));
    focusedStartupBodies = startingSelection.bodies;
    focusedStartupRows = startingSelection.rows;
    if (focusedStartupBodies.length > 0) {
      // Focus: the focused messages in full beside the thread-context ones, in arrival order; the rest as the notice.
      const bodySet = new Set([...renderedStartupThreadContextMessages, ...focusedStartupBodies]);
      const pendingMessages = startingInboxMessages.filter((message) => !bodySet.has(message));
      inboxNoticeMessages = pendingMessages;
      prompt = formatConcreteMessagesRuntimeInput(
        startingInboxMessages.flatMap((message, index) => (bodySet.has(message) ? [startingInboxProjection.messages[index]!] : [])),
        driver,
        pendingMessages.length > 0
          ? formatInboxUpdateRuntimeInput(pendingMessages, driver, pendingMessages.length, inboxOptions)
          : undefined,
        { focus: true },
      );
      promptSource = "starting_thread_context";
      spawnAnnouncedMessages = pendingMessages.filter((message) => !runtimeProfileNotificationFromMessage(message));
    } else if (renderedStartupThreadContextMessages.length > 0) {
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
  } else if (unreadSummary && Object.keys(unreadSummary).length > 0) {
    // #proj-runtime:#80: unread channels + open tasks apply to fresh starts
    // too (model/runtime switch, migration, manual session reset), not only
    // resumed sessions. Brand-new agents have neither and fall to cold_start.
    // The open tasks ride along, so the catch-up does not end on an
    // unconditional stop for an agent with unfinished work.
    prompt = formatResumeUnreadSummaryPrompt(
      unreadSummary,
      driver,
      openTasks,
      request.continueAfterCatchup ? { ...inboxOptions, continueAfterCatchup: true } : inboxOptions,
    );
    promptSource = isResume ? "resume_unread_summary" : "fresh_unread_summary";
    unreadSummaryShown = true;
    openTasksShown = hasResumeOpenTasks(openTasks) ? openTasks.tasks.length : 0;
  } else if (hasResumeOpenTasks(openTasks)) {
    // Nothing new arrived, but the agent still holds work: name it rather
    // than say there is nothing to do.
    prompt = formatResumeOpenTasksPrompt(openTasks, driver);
    promptSource = isResume ? "resume_open_tasks" : "fresh_open_tasks";
    openTasksShown = openTasks.tasks.length;
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
  const bodiesBesideFocus: readonly AgentMessage[] = wakeMessageDeliveredWithThreadContext && wakeMessage
    ? [wakeMessage, ...renderedStartupThreadContextMessages]
    : resumeCatchupDeliveredAsInput
      ? [...resumeCatchupInputMessages, ...renderedStartupThreadContextMessages]
      : startingInboxDeliveredAsInput
        ? renderedStartupThreadContextMessages
        : [];
  // Focus: the focused messages shown in full are bodies too (each message once).
  const startupBodyMessages: readonly AgentMessage[] = focusedStartupBodies.length > 0
    ? [...new Set([...bodiesBesideFocus, ...focusedStartupBodies])]
    : bodiesBesideFocus;
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
    openTasksShown,
    renderedStartupThreadContextMessages,
    startingInboxMessages,
    resumeCatchupMessages,
    resumeCatchupInputMessages,
    wakeMessageProjection,
    resumeCatchupProjection,
    startingInboxProjection,
    startupBodyMessages,
    focusedStartupBodies,
    focusedStartupRows,
    firstInputMessages,
    startOrigin,
  };
}
