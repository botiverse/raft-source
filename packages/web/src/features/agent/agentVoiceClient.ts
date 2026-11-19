// Raft voice (#wg-runtime-form:#22): an agent's voice settings and who asked
// it side questions, for the people who may edit it. Every refusal from these
// routes is a 404 (flag off, or not theirs to see): read as "nothing to show".
import type { AgentVoiceQuestionRecord, AgentVoiceQuestionRecordList } from "@botiverse/raft-shared";
import api from "../../api/client";

export type AgentVoiceSettings = { askable: boolean; callable: boolean };

function notFound(error: unknown): boolean {
  return (error as { response?: { status?: unknown } } | null)?.response?.status === 404;
}

/** The settings, or null when the viewer may not see them. */
export async function readAgentVoiceSettings(agentId: string): Promise<AgentVoiceSettings | null> {
  try {
    return (await api.get<AgentVoiceSettings>(`/agents/${encodeURIComponent(agentId)}/voice-settings`)).data;
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}

export async function saveAgentVoiceSettings(agentId: string, change: Partial<AgentVoiceSettings>): Promise<AgentVoiceSettings> {
  return (await api.put<AgentVoiceSettings>(`/agents/${encodeURIComponent(agentId)}/voice-settings`, change)).data;
}

/** Who asked, newest first, or null when the viewer may not see it. */
export async function readAgentVoiceQuestions(agentId: string): Promise<AgentVoiceQuestionRecord[] | null> {
  try {
    return (await api.get<AgentVoiceQuestionRecordList>(`/agents/${encodeURIComponent(agentId)}/voice-questions`)).data.questions;
  } catch (error) {
    if (notFound(error)) return null;
    throw error;
  }
}
