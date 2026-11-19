// Raft voice (#wg-runtime-form:#22): the agent panel's Voice section, for
// whoever may edit the agent (the server decides: its routes answer 404 to
// anyone else, and the section then renders nothing). Two settings that apply
// at once (Raft DS › Forms: a switch saves itself, a failure is said under it
// and the switch goes back): whether people may ask the agent what it is doing
// and ask it side questions, and whether they may call it. Under them, who
// asked it side questions (never the question or the answer).

import { useCallback, useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useIntl } from "react-intl";
import { ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, Separator } from "@botiverse/raft-ui";
import { AGENT_VOICE_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { AgentVoiceQuestionRecord } from "@botiverse/raft-shared";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import { ImmediateSwitchRow, apiErrorText, useImmediateSave } from "../../components/settings/ImmediateSetting";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { readAgentVoiceQuestions, readAgentVoiceSettings, saveAgentVoiceSettings } from "./agentVoiceClient";
import type { AgentVoiceSettings } from "./agentVoiceClient";

/** The most askers the section lists (the server keeps more). */
const SHOWN_QUESTIONS = 10;

/**
 * Mount it keyed by the agent (`key={agentId}`): its state is one agent's, so
 * another agent's values never show, or get saved, while the next one loads.
 */
export function AgentVoiceSection({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const enabled = useServerFeatureFlag(AGENT_VOICE_FEATURE_FLAG_KEY).enabled;
  const [settings, setSettings] = useState<AgentVoiceSettings | null>(null);
  const [questions, setQuestions] = useState<AgentVoiceQuestionRecord[] | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void readAgentVoiceSettings(agentId).then((value) => { if (live) setSettings(value); }).catch(() => {});
    void readAgentVoiceQuestions(agentId).then((value) => { if (live) setQuestions(value); }).catch(() => {});
    return () => { live = false; };
  }, [agentId, enabled]);

  if (!enabled || !settings) return null;
  return (
    <>
      <Separator />
      <section className="px-(--surface-inset) py-4" data-testid="agent-voice-section">
        <SectionEyebrow as="div" className="mb-3">
          {formatMessage({ id: "agent.voice.section" })}
        </SectionEyebrow>
        <div className="stack-y-4">
          <VoiceSwitch
            agentId={agentId}
            field="askable"
            settings={settings}
            onSaved={setSettings}
            title={formatMessage({ id: "agent.voice.askable.title" })}
            description={formatMessage({ id: "agent.voice.askable.description" })}
          />
          <VoiceSwitch
            agentId={agentId}
            field="callable"
            settings={settings}
            onSaved={setSettings}
            title={formatMessage({ id: "agent.voice.callable.title" })}
            description={formatMessage({ id: "agent.voice.callable.description" })}
          />
          <VoiceQuestions questions={questions} />
        </div>
      </section>
    </>
  );
}

function VoiceSwitch({ agentId, field, settings, onSaved, title, description }: {
  agentId: string;
  field: keyof AgentVoiceSettings;
  settings: AgentVoiceSettings;
  onSaved: Dispatch<SetStateAction<AgentVoiceSettings | null>>;
  title: string;
  description: string;
}) {
  const { formatMessage } = useIntl();
  const { feedback, saving, run } = useImmediateSave();
  const handleChange = useCallback((checked: boolean) => {
    // Only this field moves, and only this field goes back: the other switch may be saving too.
    const before = settings[field];
    const setField = (value: boolean) => onSaved((now) => (now ? { ...now, [field]: value } : now));
    setField(checked);
    void run(
      () => saveAgentVoiceSettings(agentId, { [field]: checked }).then((saved) => setField(saved[field])),
      (error) => apiErrorText(error, formatMessage({ id: "agent.voice.saveFailed" })),
    ).then((ok) => { if (!ok) setField(before); });
  }, [agentId, field, formatMessage, onSaved, run, settings]);
  return (
    <ImmediateSwitchRow
      idPrefix={`agent-voice-${field}`}
      title={title}
      description={description}
      checked={settings[field]}
      disabled={saving}
      onCheckedChange={handleChange}
      feedback={feedback}
      testId={`agent-voice-${field}`}
    />
  );
}

function VoiceQuestions({ questions }: { questions: AgentVoiceQuestionRecord[] | null }) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  if (questions === null) return null;
  return (
    <div data-testid="agent-voice-questions">
      {/* Part of Voice, not a sibling section: the quieter heading View Context's "Viewed by" uses. */}
      <h3 className="mb-2 text-sm font-semibold text-foreground-muted">{formatMessage({ id: "agent.voice.questions.title" })}</h3>
      {questions.length === 0 ? (
        <p className="text-footnote text-foreground-muted">{formatMessage({ id: "agent.voice.questions.empty" })}</p>
      ) : (
        <ListRowGroup>
          {questions.slice(0, SHOWN_QUESTIONS).map((question) => (
            <ListRow key={`${question.at}-${question.asker?.id ?? "former"}`} variant="plain" interactive={false}>
              <ListRowBody>
                <ListRowTitle>{question.asker?.name ?? formatMessage({ id: "agent.voice.questions.formerMember" })}</ListRowTitle>
                <ListRowDescription>
                  {question.app
                    ? formatMessage({ id: "agent.voice.questions.meta" }, { app: question.app.name, time: formatShortDateTime(question.at) })
                    : formatShortDateTime(question.at)}
                </ListRowDescription>
              </ListRowBody>
            </ListRow>
          ))}
        </ListRowGroup>
      )}
    </div>
  );
}
