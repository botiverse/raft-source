import { listReaderGrants, setReaderGrant } from "../raftbench/readers";
import { hideUnfindableAgentsByParam } from "./unfindableAgentGate";
import { RAFTBENCH_PATTERN_KINDS } from "@botiverse/raft-shared";
import { Router, type Router as RouterType } from "express";
import { z } from "zod";
import { configureSchema } from "../raftbench/contract";
import { assignServiceAgent, configure, createUnassignedServiceAgent, dashboard, saveFindingFeedback, listServiceAgents } from "../raftbench/controls";
import { AgentRuntimeProviderError } from "../services/agentRuntimeProviderService";
import { RaftbenchError } from "../raftbench/service";
export const raftbenchRouter: RouterType = Router();
// Another person's personal assistant reads as an unknown agent (agentFindableBy).
hideUnfindableAgentsByParam(raftbenchRouter, "agentId");
raftbenchRouter.get("/agents", async (req, res, next) => {
  try { res.json({ agents: await listServiceAgents(req.serverId!, req.userId!) }); }
  catch (error) { if (error instanceof RaftbenchError) { res.status(error.status).json({ error: error.message, code: error.code }); return; } next(error); }
});
raftbenchRouter.post("/agents", async (req, res, next) => {
  const parsed = z.object({ providerTarget: z.enum(["default", "canary"]).optional() }).strict().safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid RaftBench agent settings" }); return; }
  try { res.status(201).json(await createUnassignedServiceAgent(req.serverId!, req.userId!, parsed.data.providerTarget)); }
  catch (error) { if (error instanceof RaftbenchError) { res.status(error.status).json({ error: error.message, code: error.code }); return; } if (error instanceof AgentRuntimeProviderError) { res.status(error.code === "agent_runtime_provider_disabled" ? 403 : 503).json({ error: error.message, code: error.code }); return; } next(error); }
});
raftbenchRouter.put("/assignment", async (req, res, next) => {
  const parsed = z.object({ agentId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), channelIds: z.array(z.string().uuid()).min(1).max(50).optional(), historyFrom: z.string().datetime().optional() }).strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid RaftBench assignment" }); return; }
  try { await assignServiceAgent(req.serverId!, req.userId!, parsed.data.agentId, parsed.data.expectedRevision, { channelIds: parsed.data.channelIds ?? [], historyFrom: parsed.data.historyFrom }); res.json({ saved: true }); }
  catch (error) { if (error instanceof RaftbenchError) { res.status(error.status).json({ error: error.message, code: error.code }); return; } next(error); }
});
raftbenchRouter.get("/", async (req, res, next) => {
  try {
    const raw = req.query.page ?? "1";
    if (typeof raw !== "string" || !/^[1-9]\d{0,3}$/.test(raw)) { res.status(400).json({ error: "Invalid result page" }); return; }
    const filter = z.object({ kind: z.enum(RAFTBENCH_PATTERN_KINDS).optional(), channelId: z.string().uuid().optional(), period: z.enum(["recent", "history"]).optional() }).safeParse({ kind: req.query.kind, channelId: req.query.channelId, period: req.query.period });
    if (!filter.success) { res.status(400).json({ error: "Invalid finding filter" }); return; }
    res.json(await dashboard(req.serverId!, req.userId!, Number(raw), filter.data));
  } catch (error) {
    if (error instanceof RaftbenchError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    next(error);
  }
});
raftbenchRouter.put("/", async (req, res, next) => {
  const parsed = configureSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid RaftBench settings", issues: parsed.error.issues }); return; }
  try {
    await configure(req.serverId!, req.userId!, parsed.data);
    res.json({ saved: true });
  } catch (error) {
    if (error instanceof RaftbenchError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    if (error instanceof AgentRuntimeProviderError) { res.status(error.code === "agent_runtime_provider_disabled" ? 403 : 503).json({ error: error.message, code: error.code }); return; }
    next(error);
  }
});

raftbenchRouter.put("/findings/:id/feedback", async (req, res, next) => {
  const id = z.string().uuid().safeParse(req.params.id);
  const parsed = z.object({ revision: z.number().int().positive(), version: z.string().regex(/^[0-9a-f]{32}$/), value: z.enum(["agree", "inaccurate"]).nullable() }).strict().safeParse(req.body);
  if (!id.success || !parsed.success) { res.status(400).json({ error: "Invalid finding feedback" }); return; }
  try {
    const result = await saveFindingFeedback(req.serverId!, req.userId!, id.data, parsed.data);
    res.status(result.saved ? 200 : 409).json(result.saved ? result : { error: "This finding changed or was withdrawn. Refresh before reviewing it.", code: "raftbench_feedback_stale" });
  } catch (error) {
    if (error instanceof RaftbenchError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
    next(error);
  }
});

raftbenchRouter.get("/readers", async (req, res, next) => {
  try { res.json({ readers: await listReaderGrants(req.serverId!, req.userId!) }); }
  catch (error) { if (error instanceof RaftbenchError) { res.status(error.status).json({ error: error.message, code: error.code }); return; } next(error); }
});
raftbenchRouter.put("/readers/:agentId", async (req, res, next) => {
  const id = z.string().uuid().safeParse(req.params.agentId);
  const body = z.object({ enabled: z.boolean() }).strict().safeParse(req.body);
  if (!id.success || !body.success) { res.status(400).json({ error: "Select an agent and whether to grant access." }); return; }
  try { await setReaderGrant(req.serverId!, req.userId!, id.data, body.data.enabled); res.json({ saved: true }); }
  catch (error) { if (error instanceof RaftbenchError) { res.status(error.status).json({ error: error.message, code: error.code }); return; } next(error); }
});
