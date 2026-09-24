const CHANNEL_TRACE_STATE_KEYS = [
  "channels",
  "dmChannels",
  "channelActivity",
  "channelLocalMembership",
] as const;

const TASK_TRACE_STATE_KEYS = [
  "tasks",
  "serverTasks",
  "taskMetadataByMessageId",
  "taskMessageIdByTaskId",
] as const;

function sliceChanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.some((key) => after[key] !== undefined && after[key] !== before[key]);
}

export function channelTraceStateChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return sliceChanged(before, after, CHANNEL_TRACE_STATE_KEYS);
}

export function taskTraceStateChanged(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return sliceChanged(before, after, TASK_TRACE_STATE_KEYS);
}

export function transitionOutcomeDetail(touched: number, outcomeDetail: string): string {
  return touched > 0 ? outcomeDetail : "unchanged";
}
