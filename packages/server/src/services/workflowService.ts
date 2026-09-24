import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  channels,
  messages,
  taskEvents,
  tasks,
  workflowInstances,
  workflowStepInstances,
  workflowTemplates,
  type WorkflowStepOutput,
  type WorkflowTemplateStep,
} from "../db/schema.js";
import { enrichSingleLegacyTask } from "./taskService.js";

type ActorType = "user" | "agent";

export class WorkflowInputError extends Error {
  readonly status = 400;
}

export class WorkflowNotFoundError extends Error {
  readonly status = 404;
}

export class WorkflowConflictError extends Error {
  readonly status = 409;
}

export type WorkflowSnapshot = {
  instance: typeof workflowInstances.$inferSelect;
  template: typeof workflowTemplates.$inferSelect;
  steps: (typeof workflowStepInstances.$inferSelect)[];
};

export async function createWorkflowTemplate(
  serverId: string,
  actorType: ActorType,
  actorId: string,
  input: { name: string; steps: WorkflowTemplateStep[] },
) {
  const [template] = await getDb()
    .insert(workflowTemplates)
    .values({
      serverId,
      name: input.name,
      steps: input.steps,
      createdByType: actorType,
      createdById: actorId,
    })
    .returning();
  return template;
}

async function createWorkflowTask(
  tx: DatabaseExecutor,
  channelId: string,
  actorType: ActorType,
  actorId: string,
  step: WorkflowTemplateStep,
) {
  const [channel] = await tx
    .select({ id: channels.id })
    .from(channels)
    .where(and(
      eq(channels.id, channelId),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .for("update");
  if (!channel) throw new WorkflowConflictError("workflow channel is unavailable");

  const [{ maxMsgNum }] = await tx
    .select({ maxMsgNum: sql<number>`COALESCE(MAX(${messages.taskNumber}), 0)` })
    .from(messages)
    .where(eq(messages.channelId, channelId));
  const [{ maxTaskNum }] = await tx
    .select({ maxTaskNum: sql<number>`COALESCE(MAX(${tasks.taskNumber}), 0)` })
    .from(tasks)
    .where(eq(tasks.channelId, channelId));
  const taskNumber = Math.max(maxMsgNum ?? 0, maxTaskNum ?? 0) + 1;

  const [hostMessage] = await tx
    .insert(messages)
    .values({
      channelId,
      senderType: actorType,
      senderId: actorId,
      messageType: "chat",
      content: step.title,
    })
    .returning();

  const [task] = await tx
    .insert(tasks)
    .values({
      channelId,
      taskNumber,
      title: step.title,
      description: step.description ?? null,
      status: "todo",
      createdByType: actorType,
      createdById: actorId,
      messageId: hostMessage.id,
    })
    .returning();

  await tx.insert(taskEvents).values({
    taskId: task.id,
    eventType: "created",
    actorType,
    actorId,
    payload: {
      taskNumber,
      status: "todo",
      workflowStepKey: step.key,
    },
  });

  return { task, hostMessage };
}

async function recordWorkflowTaskInbox(hostMessages: (typeof messages.$inferSelect)[]) {
  if (hostMessages.length === 0) return;
  const { recordInboxFactsForPersistedMessages } = await import("./messageService.js");
  await recordInboxFactsForPersistedMessages(hostMessages, {
    inboxFactPolicy: {
      mode: "record",
      producer: "task.body",
      reason: "workflow-created task messages are durable shared work items",
    },
    dedupeLogicalReceiverAcrossJointProjections: true,
  });
}

export async function startWorkflowInstance(
  serverId: string,
  actorType: ActorType,
  actorId: string,
  input: { templateId: string; channelId: string },
) {
  const hostMessages: (typeof messages.$inferSelect)[] = [];
  const result = await getDb().transaction(async (tx) => {
    const [template] = await tx
      .select()
      .from(workflowTemplates)
      .where(and(eq(workflowTemplates.id, input.templateId), eq(workflowTemplates.serverId, serverId)))
      .limit(1);
    if (!template) throw new WorkflowNotFoundError("workflow template not found");
    const firstStep = template.steps[0];
    if (!firstStep) throw new WorkflowConflictError("workflow template has no steps");

    const [channel] = await tx
      .select({ id: channels.id })
      .from(channels)
      .where(and(
        eq(channels.id, input.channelId),
        eq(channels.serverId, serverId),
        isNull(channels.deletedAt),
        isNull(channels.archivedAt),
      ))
      .limit(1);
    if (!channel) throw new WorkflowNotFoundError("channel not found");

    const [instance] = await tx
      .insert(workflowInstances)
      .values({
        templateId: template.id,
        serverId,
        channelId: channel.id,
        status: "active",
        currentStepIndex: 0,
        startedByType: actorType,
        startedById: actorId,
      })
      .returning();

    const created = await createWorkflowTask(tx, channel.id, actorType, actorId, firstStep);
    hostMessages.push(created.hostMessage);

    const [step] = await tx
      .insert(workflowStepInstances)
      .values({
        instanceId: instance.id,
        stepIndex: 0,
        stepKey: firstStep.key,
        taskId: created.task.id,
        status: "active",
      })
      .returning();

    return { template, instance, step, task: created.task };
  });
  await recordWorkflowTaskInbox(hostMessages);
  return { ...result, task: await enrichSingleLegacyTask(result.task) };
}

export async function completeCurrentWorkflowStep(
  serverId: string,
  actorType: ActorType,
  actorId: string,
  instanceId: string,
  input: { taskId: string; output?: WorkflowStepOutput },
) {
  const hostMessages: (typeof messages.$inferSelect)[] = [];

  const result = await getDb().transaction(async (tx) => {
    const [instance] = await tx
      .select()
      .from(workflowInstances)
      .where(and(eq(workflowInstances.id, instanceId), eq(workflowInstances.serverId, serverId)))
      .for("update");
    if (!instance) throw new WorkflowNotFoundError("workflow instance not found");
    if (instance.status !== "active") throw new WorkflowConflictError("workflow instance is not active");

    const [template] = await tx
      .select()
      .from(workflowTemplates)
      .where(eq(workflowTemplates.id, instance.templateId))
      .limit(1);
    if (!template) throw new WorkflowConflictError("workflow template is missing");

    const [currentStep] = await tx
      .select()
      .from(workflowStepInstances)
      .where(and(
        eq(workflowStepInstances.instanceId, instance.id),
        eq(workflowStepInstances.stepIndex, instance.currentStepIndex),
      ))
      .for("update");
    if (!currentStep || currentStep.status !== "active") {
      throw new WorkflowConflictError("workflow has no active current step");
    }
    if (currentStep.taskId !== input.taskId) {
      throw new WorkflowConflictError("task is not the workflow's active task");
    }

    const [task] = await tx
      .select()
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .for("update");
    if (!task) throw new WorkflowNotFoundError("task not found");
    if (task.status !== "done") {
      throw new WorkflowConflictError("active task must be done before the workflow can advance");
    }

    const now = currentDate();
    const [completedStep] = await tx
      .update(workflowStepInstances)
      .set({
        status: "done",
        output: input.output ?? null,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(workflowStepInstances.id, currentStep.id))
      .returning();

    const nextStepIndex = instance.currentStepIndex + 1;
    const nextStepTemplate = template.steps[nextStepIndex];
    if (!nextStepTemplate) {
      const [updatedInstance] = await tx
        .update(workflowInstances)
        .set({
          status: "done",
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(workflowInstances.id, instance.id))
        .returning();
      return { instance: updatedInstance, completedStep, nextStep: null, nextTask: null };
    }

    const created = await createWorkflowTask(tx, instance.channelId, actorType, actorId, nextStepTemplate);
    hostMessages.push(created.hostMessage);
    const [nextStep] = await tx
      .insert(workflowStepInstances)
      .values({
        instanceId: instance.id,
        stepIndex: nextStepIndex,
        stepKey: nextStepTemplate.key,
        taskId: created.task.id,
        status: "active",
      })
      .returning();
    const [updatedInstance] = await tx
      .update(workflowInstances)
      .set({
        currentStepIndex: nextStepIndex,
        updatedAt: now,
      })
      .where(eq(workflowInstances.id, instance.id))
      .returning();

    return {
      instance: updatedInstance,
      completedStep,
      nextStep,
      nextTask: created.task,
    };
  });
  await recordWorkflowTaskInbox(hostMessages);
  return {
    ...result,
    nextTask: result.nextTask ? await enrichSingleLegacyTask(result.nextTask) : null,
  };
}

export async function getWorkflowSnapshot(serverId: string, instanceId: string): Promise<WorkflowSnapshot | null> {
  const db = getDb();
  const [instance] = await db
    .select()
    .from(workflowInstances)
    .where(and(eq(workflowInstances.id, instanceId), eq(workflowInstances.serverId, serverId)))
    .limit(1);
  if (!instance) return null;
  const [template] = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, instance.templateId))
    .limit(1);
  if (!template) return null;
  const steps = await db
    .select()
    .from(workflowStepInstances)
    .where(eq(workflowStepInstances.instanceId, instance.id))
    .orderBy(asc(workflowStepInstances.stepIndex));
  return { instance, template, steps };
}
