import { Router, type Router as RouterType } from "express";
import type { ServerId } from "@botiverse/raft-shared";
import type { PersistableJsonValue, WorkflowStepOutput, WorkflowTemplateStep } from "../db/schema.js";
import { getActorServerRoleInServer } from "../lib/actorPermissions.js";
import * as channelService from "../services/channelService.js";
import * as serverService from "../services/serverService.js";
import {
  WorkflowConflictError,
  WorkflowInputError,
  WorkflowNotFoundError,
  completeCurrentWorkflowStep,
  createWorkflowTemplate,
  getWorkflowSnapshot,
  startWorkflowInstance,
} from "../services/workflowService.js";

export const workflowRouter: RouterType = Router();

function asBodyObject(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function parseWorkflowTemplateName(body: Record<string, unknown>): string {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) throw new WorkflowInputError("name is required");
  return name;
}

function parseWorkflowTemplateSteps(body: Record<string, unknown>): WorkflowTemplateStep[] {
  const input = body.steps;
  if (!Array.isArray(input) || input.length === 0) {
    throw new WorkflowInputError("steps must be a non-empty array");
  }
  if (input.length > 50) {
    throw new WorkflowInputError("workflow templates cannot contain more than 50 steps");
  }

  const keys = new Set<string>();
  return input.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new WorkflowInputError(`step ${index + 1} must be an object`);
    }
    const step = raw as Record<string, unknown>;
    const key = typeof step.key === "string" ? step.key.trim() : "";
    const title = typeof step.title === "string" ? step.title.trim() : "";
    const description = typeof step.description === "string" ? step.description.trim() : undefined;
    if (!key) throw new WorkflowInputError(`step ${index + 1} key is required`);
    if (keys.has(key)) throw new WorkflowInputError(`duplicate step key: ${key}`);
    if (!title) throw new WorkflowInputError(`step ${index + 1} title is required`);
    keys.add(key);
    return {
      key,
      title,
      ...(description ? { description } : {}),
    };
  });
}

function isPersistableJsonValue(input: unknown): input is PersistableJsonValue {
  if (input === null) return true;
  if (typeof input === "string" || typeof input === "boolean") return true;
  if (typeof input === "number") return Number.isFinite(input);
  if (Array.isArray(input)) return input.every(isPersistableJsonValue);
  if (input && typeof input === "object") {
    return Object.values(input).every(isPersistableJsonValue);
  }
  return false;
}

function parseWorkflowStepOutput(body: Record<string, unknown>): WorkflowStepOutput | undefined {
  if (!Object.hasOwn(body, "output")) return undefined;
  const output = body.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new WorkflowInputError("output must be a JSON object");
  }
  if (!isPersistableJsonValue(output)) {
    throw new WorkflowInputError("output must be persistable JSON");
  }
  return output as WorkflowStepOutput;
}

function parseStringField(body: Record<string, unknown>, fieldName: string): string {
  const value = typeof body[fieldName] === "string" ? body[fieldName] : "";
  if (!value) throw new WorkflowInputError(`${fieldName} is required`);
  return value;
}

function workflowErrorStatus(err: unknown): number {
  if (err instanceof WorkflowInputError) return err.status;
  if (err instanceof WorkflowNotFoundError) return err.status;
  if (err instanceof WorkflowConflictError) return err.status;
  return 500;
}

function workflowErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Workflow operation failed";
}

async function isHiddenAllDirectoryScope(
  channel: NonNullable<Awaited<ReturnType<typeof channelService.getChannel>>>,
): Promise<boolean> {
  if (channelService.isAllSystemChannel(channel)) return true;
  if (channel.type !== "thread") return false;

  const jointThread = await channelService.getJointThreadProjectionByLocalThread(channel.id, channel.serverId);
  if (jointThread) {
    const localParent = await channelService.getChannel(jointThread.localParentChannelId);
    return !!localParent && channelService.isAllSystemChannel(localParent);
  }
  if (!channel.parentMessageId) return false;
  const parentMessage = await channelService.getMessage(channel.parentMessageId);
  if (!parentMessage) return false;
  const parentChannel = await channelService.getChannel(parentMessage.channelId);
  return !!parentChannel && channelService.isAllSystemChannel(parentChannel);
}

async function getVisibleWorkflowHumanIds(
  serverId: string,
  channelId: string,
  requesterId: string,
  actorIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const uniqueActorIds = [...new Set(actorIds)];
  if (!await serverService.shouldHideHumanDirectoryFromRequester(serverId, requesterId)) {
    return new Set(uniqueActorIds);
  }

  const [server, channel, actorRoles] = await Promise.all([
    serverService.getServer(serverId),
    channelService.getChannel(channelId),
    Promise.all(uniqueActorIds.map(async (actorId) => (
      [actorId, await getActorServerRoleInServer(serverId, "user", actorId)] as const
    ))),
  ]);
  const channelHumanIds = channel && !await isHiddenAllDirectoryScope(channel)
    ? new Set((await channelService.getChannelMembers(channel.id)).humans.map((human) => human.id))
    : new Set<string>();
  const actorRoleById = new Map(actorRoles);

  return new Set(uniqueActorIds.filter((actorId) => {
    if (actorId === requesterId || channelHumanIds.has(actorId)) return true;
    const role = actorRoleById.get(actorId);
    return !!role && serverService.shouldExposeHumanInHiddenDirectory({
      id: actorId,
      serverSlug: server?.slug ?? null,
      role,
    }, requesterId);
  }));
}

function projectWorkflowHumanActorIds<T extends {
  template?: { createdByType: string; createdById: string | null };
  instance?: { startedByType: string; startedById: string | null };
}>(workflow: T, visibleHumanIds: ReadonlySet<string>): T {
  const hideTemplateCreator = workflow.template?.createdByType === "user"
    && workflow.template.createdById !== null
    && !visibleHumanIds.has(workflow.template.createdById);
  const hideInstanceStarter = workflow.instance?.startedByType === "user"
    && workflow.instance.startedById !== null
    && !visibleHumanIds.has(workflow.instance.startedById);
  if (!hideTemplateCreator && !hideInstanceStarter) return workflow;
  return {
    ...workflow,
    ...(hideTemplateCreator ? { template: { ...workflow.template!, createdById: null } } : {}),
    ...(hideInstanceStarter ? { instance: { ...workflow.instance!, startedById: null } } : {}),
  };
}

async function projectWorkflowForRequester<T extends {
  template?: { createdByType: string; createdById: string | null };
  instance?: { startedByType: string; startedById: string | null };
}>(serverId: string, channelId: string, requesterId: string, workflow: T): Promise<T> {
  const humanActorIds = [
    workflow.template?.createdByType === "user" ? workflow.template.createdById : null,
    workflow.instance?.startedByType === "user" ? workflow.instance.startedById : null,
  ].filter((actorId): actorId is string => actorId !== null);
  const visibleHumanIds = await getVisibleWorkflowHumanIds(serverId, channelId, requesterId, humanActorIds);
  return projectWorkflowHumanActorIds(workflow, visibleHumanIds);
}

async function rejectIfNoChannelWriteAccess(
  channelId: string,
  userId: string,
  serverId: ServerId,
  res: import("express").Response,
): Promise<boolean> {
  if (
    !await channelService.canUserAccessChannel(channelId, userId, serverId)
    || !await channelService.canUserPostToChannel(channelId, userId)
  ) {
    res.status(403).json({ error: "You must join this channel to start or advance workflows" });
    return true;
  }
  return false;
}

workflowRouter.post("/templates", async (req, res) => {
  try {
    const body = asBodyObject(req.body);
    const template = await createWorkflowTemplate(req.serverId!, "user", req.userId!, {
      name: parseWorkflowTemplateName(body),
      steps: parseWorkflowTemplateSteps(body),
    });
    res.json({ template });
  } catch (err) {
    res.status(workflowErrorStatus(err)).json({ error: workflowErrorMessage(err) });
  }
});

workflowRouter.post("/templates/:templateId/start", async (req, res) => {
  try {
    const body = asBodyObject(req.body);
    const channelId = parseStringField(body, "channelId");
    if (await rejectIfNoChannelWriteAccess(channelId, req.userId!, req.serverId!, res)) return;

    const workflow = await startWorkflowInstance(req.serverId!, "user", req.userId!, {
      templateId: req.params.templateId,
      channelId,
    });
    res.json({
      workflow: await projectWorkflowForRequester(req.serverId!, channelId, req.userId!, workflow),
    });
  } catch (err) {
    res.status(workflowErrorStatus(err)).json({ error: workflowErrorMessage(err) });
  }
});

workflowRouter.post("/:instanceId/complete-current-step", async (req, res) => {
  try {
    const body = asBodyObject(req.body);
    const snapshot = await getWorkflowSnapshot(req.serverId!, req.params.instanceId);
    if (!snapshot) {
      res.status(404).json({ error: "workflow instance not found" });
      return;
    }
    if (await rejectIfNoChannelWriteAccess(snapshot.instance.channelId, req.userId!, req.serverId!, res)) return;

    const workflow = await completeCurrentWorkflowStep(
      req.serverId!,
      "user",
      req.userId!,
      req.params.instanceId,
      {
        taskId: parseStringField(body, "taskId"),
        output: parseWorkflowStepOutput(body),
      },
    );
    res.json({
      workflow: await projectWorkflowForRequester(
        req.serverId!,
        snapshot.instance.channelId,
        req.userId!,
        workflow,
      ),
    });
  } catch (err) {
    res.status(workflowErrorStatus(err)).json({ error: workflowErrorMessage(err) });
  }
});

workflowRouter.get("/:instanceId", async (req, res) => {
  try {
    const snapshot = await getWorkflowSnapshot(req.serverId!, req.params.instanceId);
    if (!snapshot) {
      res.status(404).json({ error: "workflow instance not found" });
      return;
    }
    if (!await channelService.canUserAccessChannel(snapshot.instance.channelId, req.userId!, req.serverId!)) {
      res.status(404).json({ error: "workflow instance not found" });
      return;
    }
    res.json({
      workflow: await projectWorkflowForRequester(
        req.serverId!,
        snapshot.instance.channelId,
        req.userId!,
        snapshot,
      ),
    });
  } catch (err) {
    res.status(workflowErrorStatus(err)).json({ error: workflowErrorMessage(err) });
  }
});
