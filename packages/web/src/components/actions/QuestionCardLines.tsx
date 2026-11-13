// The lines a question card's frame writes under its title once it ended
// without an answer (question-card spec §4.4, §8): expired ("Mei didn't
// answer within 3 days. Scout was told.") and withdrawn ("Scout withdrew
// these questions."). The server never rebuilds an expired or withdrawn card
// (it changes only the state), so the frame says it: the person asked by
// their id, as this viewer knows them (never the handle the agent wrote), the
// agent that asked by the card's `requesterAgentId`, as this viewer's agents
// list names it (a card prepared before the id was written: the agent its
// form's description names, legacyAskingAgentRef; else "Someone").

import { useIntl } from "react-intl";
import { QUESTION_ASK_FORM_ID, QUESTION_ASK_LIMITS } from "@botiverse/raft-shared";
import type { ActionCardMetadata, ActionCardRenderedCard, ActionCardSpecEntityRef } from "@botiverse/raft-shared";
import { useAgentStore } from "../../store/agentStore";
import { isActionCardShownExpired } from "./actionCardExpired";
import { useQuestionAddresseeName } from "./questionCardAddressee";

/**
 * LEGACY, remove after 2026-12-04 (cards expire within 30 days): a card
 * prepared before #12897 has no requesterAgentId; the agent param of its
 * form's description (buildQuestionAskForms' "who sees the answers") names
 * the agent that asked.
 */
function legacyAskingAgentRef(card: ActionCardRenderedCard): ActionCardSpecEntityRef | null {
  const description = card.forms && Object.hasOwn(card.forms, QUESTION_ASK_FORM_ID) ? card.forms[QUESTION_ASK_FORM_ID]?.description : undefined;
  if (!description || typeof description === "string") return null;
  const agent = description.params?.agent;
  return typeof agent === "object" && agent !== null && agent.kind === "agent" ? agent : null;
}

/** How long the card waited, in the largest whole unit (3 days, 12 hours, 90 minutes), as the locale writes it. */
function formatQuestionWait(minutes: number, locale: string): string {
  const [unit, count] = minutes % 1440 === 0 ? ["day", minutes / 1440] as const
    : minutes % 60 === 0 ? ["hour", minutes / 60] as const
      : ["minute", minutes] as const;
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "long" }).format(count);
}

/** The ended question card's line: why it ended and who was told; null for any other card or state. */
export function QuestionCardEndedLine({ metadata, card }: { metadata: ActionCardMetadata; card: ActionCardRenderedCard }) {
  const { formatMessage, locale } = useIntl();
  const action = metadata.action;
  // Not the For row's fallback: the server fills it from the handle the agent wrote.
  const person = useQuestionAddresseeName(metadata);
  const legacyRef = metadata.requesterAgentId ? null : legacyAskingAgentRef(card);
  const agentId = metadata.requesterAgentId ?? legacyRef?.id ?? null;
  const agent = useAgentStore((state) => (agentId ? state.agents.find((candidate) => candidate.id === agentId) : undefined));
  if (action.type !== "question:ask") return null;
  const agentName = agent?.displayName || agent?.name || legacyRef?.fallback || formatMessage({ id: "actionCard.person.someone" });
  if (metadata.state === "withdrawn") {
    return <>{formatMessage({ id: "actionCard.question.withdrawnLine" }, { agent: agentName, count: action.questions.length })}</>;
  }
  if (!isActionCardShownExpired(metadata)) return null;
  // An older stored card without it waited the default (QUESTION_ASK_LIMITS).
  const minutes = Number.isFinite(action.expiresInMinutes) && action.expiresInMinutes > 0 ? action.expiresInMinutes : QUESTION_ASK_LIMITS.expiresInMinutes.default;
  const duration = formatQuestionWait(minutes, locale);
  return person !== null
    ? <>{formatMessage({ id: "actionCard.question.expiredLine" }, { person, duration, agent: agentName })}</>
    : <>{formatMessage({ id: "actionCard.question.expiredLineAnyone" }, { duration, agent: agentName })}</>;
}
