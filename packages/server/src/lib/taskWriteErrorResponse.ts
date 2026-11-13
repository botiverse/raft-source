import { JointTaskWriteDeniedError } from "../services/jointTaskWriteAuthority";
import type { Response } from "express";
import { ChannelConversionInProgressError } from "../services/channelConversionFenceService";
import { DmTargetResolutionError } from "../services/dmTargetResolutionError";
import { TaskCreateStatusError, TaskMutationConflictError, TaskSourceMessageError, TaskStatusNotAvailableError } from "../services/taskService";
import { TaskV2NotEnabledError } from "../services/taskConversationsGate";

/** Preserve the same typed write-admission result on Web and Agent task routes. */
export function respondToTaskWriteError(error: unknown, res: Response): boolean {
  if (error instanceof ChannelConversionInProgressError) {
    res.status(error.status).json({ error: error.message, code: error.code, conversionEpoch: error.conversionEpoch });
    return true;
  }
  // A task target like dm:@Twin that names both a human and an agent.
  if (error instanceof DmTargetResolutionError) {
    res.status(error.status).json(error.toResponseBody());
    return true;
  }
  if (error instanceof JointTaskWriteDeniedError || error instanceof TaskMutationConflictError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  // Task v2: a create item's sourceMessageId cannot carry a task.
  if (error instanceof TaskSourceMessageError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  // A create asked for a status a task can't start in (in_review, done, closed).
  if (error instanceof TaskCreateStatusError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  // A status write asked for backlog on a task that isn't task v2.
  if (error instanceof TaskStatusNotAvailableError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  // A source message on a server without task v2 conversations.
  if (error instanceof TaskV2NotEnabledError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}
