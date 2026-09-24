import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  channels,
  messages,
  serverMembers,
  servers,
  tasks,
  users,
  workflowInstances,
  workflowStepInstances,
  workflowTemplates,
} from "../db/schema.js";
import { createChannel, getOrCreateThread, addHuman, removeHuman } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import { createServer } from "../services/serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return ((await res.json()) as { accessToken: string }).accessToken;
}

function headers(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

async function setup(slug: string, channelType: "channel" | "private" = "channel") {
  const owner = await seedUser(`${slug}-owner`);
  const server = await createServer(`Workflow ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, slug, undefined, channelType);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" }).onConflictDoNothing();
  await addHuman(channel.id, owner.id);
  return { owner, server, channel };
}

async function countWorkflowWrites() {
  const db = getDb();
  const [templateRows, instanceRows, stepRows, taskRows, messageRows] = await Promise.all([
    db.select({ id: workflowTemplates.id }).from(workflowTemplates),
    db.select({ id: workflowInstances.id }).from(workflowInstances),
    db.select({ id: workflowStepInstances.id }).from(workflowStepInstances),
    db.select({ id: tasks.id }).from(tasks),
    db.select({ id: messages.id }).from(messages),
  ]);
  return {
    templates: templateRows.length,
    instances: instanceRows.length,
    steps: stepRows.length,
    tasks: taskRows.length,
    messages: messageRows.length,
  };
}

async function createTemplate(baseUrl: string, token: string, serverId: string) {
  const templateRes = await fetch(`${baseUrl}/api/workflows/templates`, {
    method: "POST",
    headers: headers(token, serverId),
    body: JSON.stringify({
      name: "Two step review",
      steps: [
        { key: "draft", title: "Draft the plan", description: "Write the first pass" },
        { key: "approve", title: "Approve the plan" },
      ],
    }),
  });
  assert.equal(templateRes.status, 200, await templateRes.clone().text());
  return ((await templateRes.json()) as { template: { id: string } }).template;
}

async function startWorkflow(baseUrl: string, token: string, serverId: string, templateId: string, channelId: string) {
  const startRes = await fetch(`${baseUrl}/api/workflows/templates/${templateId}/start`, {
    method: "POST",
    headers: headers(token, serverId),
    body: JSON.stringify({ channelId }),
  });
  assert.equal(startRes.status, 200, await startRes.clone().text());
  return (await startRes.json()) as {
    workflow: {
      template: { createdById: string | null };
      instance: { id: string; status: string; currentStepIndex: number; startedById: string | null };
      step: { taskId: string; status: string; stepKey: string };
      task: { title: string };
    };
  };
}

async function moveTask(baseUrl: string, token: string, serverId: string, taskId: string, status: string) {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/status`, {
    method: "PATCH",
    headers: headers(token, serverId),
    body: JSON.stringify({ status }),
  });
  assert.equal(res.status, 200, await res.clone().text());
}

test("workflow instance creates one active task at a time and advances only after the current task is done", async ({ app }) => {
  const { owner, server, channel } = await setup("workflow-serial");
  const token = await login(app.baseUrl, owner.email);

  const template = await createTemplate(app.baseUrl, token, server.id);
  const started = await startWorkflow(app.baseUrl, token, server.id, template.id, channel.id);
  assert.equal(started.workflow.instance.status, "active");
  assert.equal(started.workflow.instance.currentStepIndex, 0);
  assert.equal(started.workflow.step.status, "active");
  assert.equal(started.workflow.step.stepKey, "draft");
  assert.equal(started.workflow.task.title, "Draft the plan");

  const premature = await fetch(`${app.baseUrl}/api/workflows/${started.workflow.instance.id}/complete-current-step`, {
    method: "POST",
    headers: headers(token, server.id),
    body: JSON.stringify({ taskId: started.workflow.step.taskId }),
  });
  assert.equal(premature.status, 409, "workflow must not advance while active task is unfinished");

  await moveTask(app.baseUrl, token, server.id, started.workflow.step.taskId, "in_progress");
  await moveTask(app.baseUrl, token, server.id, started.workflow.step.taskId, "done");

  const advanceRes = await fetch(`${app.baseUrl}/api/workflows/${started.workflow.instance.id}/complete-current-step`, {
    method: "POST",
    headers: headers(token, server.id),
    body: JSON.stringify({ taskId: started.workflow.step.taskId, output: { approved: true } }),
  });
  assert.equal(advanceRes.status, 200, await advanceRes.clone().text());
  const advanced = (await advanceRes.json()) as {
    workflow: {
      instance: { currentStepIndex: number; status: string };
      completedStep: { status: string; output: { approved: boolean } };
      nextStep: { taskId: string; status: string; stepKey: string };
      nextTask: { title: string };
    };
  };
  assert.equal(advanced.workflow.instance.status, "active");
  assert.equal(advanced.workflow.instance.currentStepIndex, 1);
  assert.equal(advanced.workflow.completedStep.status, "done");
  assert.deepEqual(advanced.workflow.completedStep.output, { approved: true });
  assert.equal(advanced.workflow.nextStep.status, "active");
  assert.equal(advanced.workflow.nextStep.stepKey, "approve");
  assert.equal(advanced.workflow.nextTask.title, "Approve the plan");

  const activeSteps = await getDb()
    .select()
    .from(workflowStepInstances)
    .where(and(
      eq(workflowStepInstances.instanceId, started.workflow.instance.id),
      eq(workflowStepInstances.status, "active"),
    ));
  assert.equal(activeSteps.length, 1, "there is exactly one active workflow task");
  assert.equal(activeSteps[0].taskId, advanced.workflow.nextStep.taskId);

  await moveTask(app.baseUrl, token, server.id, advanced.workflow.nextStep.taskId, "in_progress");
  await moveTask(app.baseUrl, token, server.id, advanced.workflow.nextStep.taskId, "done");
  const finishRes = await fetch(`${app.baseUrl}/api/workflows/${started.workflow.instance.id}/complete-current-step`, {
    method: "POST",
    headers: headers(token, server.id),
    body: JSON.stringify({ taskId: advanced.workflow.nextStep.taskId }),
  });
  assert.equal(finishRes.status, 200, await finishRes.clone().text());

  const [instance] = await getDb()
    .select()
    .from(workflowInstances)
    .where(eq(workflowInstances.id, started.workflow.instance.id));
  assert.equal(instance.status, "done");
  assert.ok(instance.completedAt instanceof Date);

  const createdTasks = await getDb()
    .select()
    .from(tasks)
    .where(eq(tasks.channelId, channel.id));
  assert.deepEqual(createdTasks.map((task) => task.title), ["Draft the plan", "Approve the plan"]);
});

test("workflow APIs reject same-server channel non-members without workflow task or message writes", async ({ app }) => {
  const { owner, server, channel } = await setup("workflow-nonmember", "private");
  const ownerToken = await login(app.baseUrl, owner.email);
  const template = await createTemplate(app.baseUrl, ownerToken, server.id);
  const outsider = await seedUser("workflow-nonmember-outsider");
  await getDb()
    .insert(serverMembers)
    .values({ serverId: server.id, userId: outsider.id, role: "member" })
    .onConflictDoNothing();
  const outsiderToken = await login(app.baseUrl, outsider.email);

  const beforeStart = await countWorkflowWrites();
  const deniedStart = await fetch(`${app.baseUrl}/api/workflows/templates/${template.id}/start`, {
    method: "POST",
    headers: headers(outsiderToken, server.id),
    body: JSON.stringify({ channelId: channel.id }),
  });
  assert.equal(deniedStart.status, 403, "private-channel non-member must not start a workflow");
  assert.deepEqual(await countWorkflowWrites(), beforeStart, "denied start must not write workflow/task/message rows");

  const started = await startWorkflow(app.baseUrl, ownerToken, server.id, template.id, channel.id);
  const deniedSnapshot = await fetch(`${app.baseUrl}/api/workflows/${started.workflow.instance.id}`, {
    method: "GET",
    headers: headers(outsiderToken, server.id),
  });
  assert.equal(deniedSnapshot.status, 404, "private-channel non-member must not read a workflow snapshot");

  await moveTask(app.baseUrl, ownerToken, server.id, started.workflow.step.taskId, "in_progress");
  await moveTask(app.baseUrl, ownerToken, server.id, started.workflow.step.taskId, "done");
  const beforeAdvance = await countWorkflowWrites();
  const deniedAdvance = await fetch(`${app.baseUrl}/api/workflows/${started.workflow.instance.id}/complete-current-step`, {
    method: "POST",
    headers: headers(outsiderToken, server.id),
    body: JSON.stringify({ taskId: started.workflow.step.taskId, output: { approved: true } }),
  });
  assert.equal(deniedAdvance.status, 403, "private-channel non-member must not advance a workflow");
  assert.deepEqual(await countWorkflowWrites(), beforeAdvance, "denied advance must not write workflow/task/message rows");

  const [activeStep] = await getDb()
    .select()
    .from(workflowStepInstances)
    .where(eq(workflowStepInstances.taskId, started.workflow.step.taskId));
  assert.equal(activeStep.status, "active");
  assert.equal(activeStep.output, null);
});

test("workflow APIs reject cross-server channel and instance access without writes", async ({ app }) => {
  const { owner: ownerA, server: serverA } = await setup("workflow-cross-a");
  const { server: serverB, channel: channelB } = await setup("workflow-cross-b");
  await getDb()
    .insert(serverMembers)
    .values({ serverId: serverB.id, userId: ownerA.id, role: "member" })
    .onConflictDoNothing();
  await addHuman(channelB.id, ownerA.id);

  const tokenA = await login(app.baseUrl, ownerA.email);
  const templateA = await createTemplate(app.baseUrl, tokenA, serverA.id);
  const beforeStart = await countWorkflowWrites();
  const deniedStart = await fetch(`${app.baseUrl}/api/workflows/templates/${templateA.id}/start`, {
    method: "POST",
    headers: headers(tokenA, serverA.id),
    body: JSON.stringify({ channelId: channelB.id }),
  });
  assert.equal(deniedStart.status, 403, "foreign channel must not satisfy active-server workflow start");
  assert.deepEqual(await countWorkflowWrites(), beforeStart, "cross-server denied start must not write rows");

  const templateB = await createTemplate(app.baseUrl, tokenA, serverB.id);
  const startedB = await startWorkflow(app.baseUrl, tokenA, serverB.id, templateB.id, channelB.id);

  const deniedSnapshot = await fetch(`${app.baseUrl}/api/workflows/${startedB.workflow.instance.id}`, {
    method: "GET",
    headers: headers(tokenA, serverA.id),
  });
  assert.equal(deniedSnapshot.status, 404, "foreign instance must not be readable through active server");

  await moveTask(app.baseUrl, tokenA, serverB.id, startedB.workflow.step.taskId, "in_progress");
  await moveTask(app.baseUrl, tokenA, serverB.id, startedB.workflow.step.taskId, "done");
  const beforeAdvance = await countWorkflowWrites();
  const deniedAdvance = await fetch(`${app.baseUrl}/api/workflows/${startedB.workflow.instance.id}/complete-current-step`, {
    method: "POST",
    headers: headers(tokenA, serverA.id),
    body: JSON.stringify({ taskId: startedB.workflow.step.taskId, output: { approved: true } }),
  });
  assert.equal(deniedAdvance.status, 404, "foreign instance must not advance through active server");
  assert.deepEqual(await countWorkflowWrites(), beforeAdvance, "cross-server denied advance must not write rows");
});

test("workflow start hides an out-of-channel template creator from an ordinary member when the human directory is hidden", async ({ app }) => {
  const { owner, server } = await setup("workflow-hidden-creator");
  const requester = await seedUser("workflow-hidden-requester");
  await getDb()
    .insert(serverMembers)
    .values({ serverId: server.id, userId: requester.id, role: "member" });
  await getDb()
    .update(servers)
    .set({ hideHumansFromMembers: true })
    .where(eq(servers.id, server.id));
  const requesterChannel = await createChannel(server.id, "requester-private", undefined, "private");
  await addHuman(requesterChannel.id, requester.id);

  const ownerToken = await login(app.baseUrl, owner.email);
  const requesterToken = await login(app.baseUrl, requester.email);
  const template = await createTemplate(app.baseUrl, ownerToken, server.id);
  const response = await fetch(`${app.baseUrl}/api/workflows/templates/${template.id}/start`, {
    method: "POST",
    headers: headers(requesterToken, server.id),
    body: JSON.stringify({ channelId: requesterChannel.id }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as {
    workflow: {
      template: { createdById: string | null };
      instance: { id: string; startedById: string | null };
    };
  };
  assert.equal(body.workflow.template.createdById, null);
  assert.equal(body.workflow.instance.startedById, requester.id, "the requester must retain their own identity");

  const snapshotResponse = await fetch(`${app.baseUrl}/api/workflows/${body.workflow.instance.id}`, {
    method: "GET",
    headers: headers(requesterToken, server.id),
  });
  assert.equal(snapshotResponse.status, 200, await snapshotResponse.clone().text());
  const snapshotBody = await snapshotResponse.json() as {
    workflow: { template: { createdById: string | null } };
  };
  assert.equal(snapshotBody.workflow.template.createdById, null, "snapshot must apply the same projection");

  await addHuman(requesterChannel.id, owner.id);
  const peerVisibleResponse = await fetch(`${app.baseUrl}/api/workflows/templates/${template.id}/start`, {
    method: "POST",
    headers: headers(requesterToken, server.id),
    body: JSON.stringify({ channelId: requesterChannel.id }),
  });
  assert.equal(peerVisibleResponse.status, 200, await peerVisibleResponse.clone().text());
  const peerVisibleBody = await peerVisibleResponse.json() as {
    workflow: { template: { createdById: string | null } };
  };
  assert.equal(
    peerVisibleBody.workflow.template.createdById,
    owner.id,
    "a human who is a current channel peer must remain visible",
  );
});

test("workflow snapshot and advance hide a starter who is no longer a channel peer", async ({ app }) => {
  const { owner, server } = await setup("workflow-hidden-starter");
  const requester = await seedUser("workflow-hidden-starter-requester");
  await getDb()
    .insert(serverMembers)
    .values({ serverId: server.id, userId: requester.id, role: "member" });
  await getDb()
    .update(servers)
    .set({ hideHumansFromMembers: true })
    .where(eq(servers.id, server.id));
  const sharedChannel = await createChannel(server.id, "shared-private", undefined, "private");
  await addHuman(sharedChannel.id, owner.id);
  await addHuman(sharedChannel.id, requester.id);

  const ownerToken = await login(app.baseUrl, owner.email);
  const requesterToken = await login(app.baseUrl, requester.email);
  const template = await createTemplate(app.baseUrl, ownerToken, server.id);
  const started = await startWorkflow(app.baseUrl, ownerToken, server.id, template.id, sharedChannel.id);
  await removeHuman(sharedChannel.id, owner.id);

  const snapshotResponse = await fetch(`${app.baseUrl}/api/workflows/${started.workflow.instance.id}`, {
    method: "GET",
    headers: headers(requesterToken, server.id),
  });
  assert.equal(snapshotResponse.status, 200, await snapshotResponse.clone().text());
  const snapshotBody = await snapshotResponse.json() as {
    workflow: {
      template: { createdById: string | null };
      instance: { startedById: string | null };
    };
  };
  assert.equal(snapshotBody.workflow.template.createdById, null);
  assert.equal(snapshotBody.workflow.instance.startedById, null);

  await getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, started.workflow.step.taskId));
  const advanceResponse = await fetch(`${app.baseUrl}/api/workflows/${started.workflow.instance.id}/complete-current-step`, {
    method: "POST",
    headers: headers(requesterToken, server.id),
    body: JSON.stringify({ taskId: started.workflow.step.taskId }),
  });
  assert.equal(advanceResponse.status, 200, await advanceResponse.clone().text());
  const advanceBody = await advanceResponse.json() as {
    workflow: { instance: { startedById: string | null } };
  };
  assert.equal(advanceBody.workflow.instance.startedById, null, "advance must apply the same projection");
});

test("workflow start in #all and #all threads hides other humans while preserving the requester", async ({ app }) => {
  const owner = await seedUser("workflow-all-owner");
  const creator = await seedUser("workflow-all-creator");
  const requester = await seedUser("workflow-all-requester");
  const server = await createServer("Workflow all scopes", `workflow-all-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: creator.id, role: "member" },
    { serverId: server.id, userId: requester.id, role: "member" },
  ]);
  await getDb()
    .update(servers)
    .set({ hideHumansFromMembers: true })
    .where(eq(servers.id, server.id));

  const [allChannel] = await getDb()
    .select()
    .from(channels)
    .where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  assert.ok(allChannel, "createServer must provision #all");

  const creatorToken = await login(app.baseUrl, creator.email);
  const requesterToken = await login(app.baseUrl, requester.email);
  const template = await createTemplate(app.baseUrl, creatorToken, server.id);

  const startedInAll = await startWorkflow(
    app.baseUrl,
    requesterToken,
    server.id,
    template.id,
    allChannel.id,
  );
  assert.equal(startedInAll.workflow.template.createdById, null, "#all must not reveal another server human");
  assert.equal(startedInAll.workflow.instance.startedById, requester.id, "#all must preserve the requester");

  const parentMessage = await createMessage(allChannel.id, "user", requester.id, "workflow all thread parent");
  const thread = await getOrCreateThread(parentMessage.id, requester.id, "user");
  const startedInAllThread = await startWorkflow(
    app.baseUrl,
    requesterToken,
    server.id,
    template.id,
    thread.id,
  );
  assert.equal(
    startedInAllThread.workflow.template.createdById,
    null,
    "a #all thread must not reveal another server human",
  );
  assert.equal(
    startedInAllThread.workflow.instance.startedById,
    requester.id,
    "a #all thread must preserve the requester",
  );
});

test("workflow start preserves the community owner exception in a hidden human directory", async ({ app }) => {
  const owner = await seedUser("workflow-community-owner");
  const requester = await seedUser("workflow-community-requester");
  const server = await createServer("Workflow community", "community", owner.id);
  await getDb()
    .insert(serverMembers)
    .values({ serverId: server.id, userId: requester.id, role: "member" });
  await getDb()
    .update(servers)
    .set({ hideHumansFromMembers: true })
    .where(eq(servers.id, server.id));
  const requesterChannel = await createChannel(server.id, "workflow-community-private", undefined, "private");
  await addHuman(requesterChannel.id, requester.id);

  const ownerToken = await login(app.baseUrl, owner.email);
  const requesterToken = await login(app.baseUrl, requester.email);
  const template = await createTemplate(app.baseUrl, ownerToken, server.id);
  const response = await fetch(`${app.baseUrl}/api/workflows/templates/${template.id}/start`, {
    method: "POST",
    headers: headers(requesterToken, server.id),
    body: JSON.stringify({ channelId: requesterChannel.id }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json() as {
    workflow: { template: { createdById: string | null } };
  };
  assert.equal(
    body.workflow.template.createdById,
    owner.id,
    "the community owner must remain visible outside the requester's channel",
  );
});
