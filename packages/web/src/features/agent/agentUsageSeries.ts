import type { MessageId } from "../../i18n/messages/en";

/** The Usage tab's kinds of tokens: label and chart hue (raft-ui palette; New input and Cache write share lavender, Output is cyan, Cache read stone). */
export const USAGE_SERIES = {
  inputNew: { labelId: "agent.usage.kind.newInput", color: "var(--palette-lavender-600)" },
  cacheWrite: { labelId: "agent.usage.kind.cacheWrite", color: "var(--palette-lavender-300)" },
  output: { labelId: "agent.usage.kind.output", color: "var(--palette-cyan-500)" },
  cacheRead: { labelId: "agent.usage.kind.cacheRead", color: "var(--palette-stone-400)" },
} as const satisfies Record<string, { labelId: MessageId; color: string }>;
export type UsageSeriesKey = keyof typeof USAGE_SERIES;
