// v0 scope: human-facing reminder surface is read-only. Humans see pending
// reminders on the agent profile; agents own the write side entirely
// (schedule via MCP → /internal/agent/:id/reminders, cancel via MCP →
// /internal/agent/:id/reminders/:id). Creating or canceling on behalf of an
// agent from the human UI is deliberately out of scope until v1.
import { Router, type Router as RouterType } from "express";
import { isReminderStatus, type ReminderStatus } from "@botiverse/raft-shared";
import { listAppReminders } from "../apps/reminder/crud.js";
import * as reminderService from "../apps/reminder/service.js";
import * as agentService from "../services/agentService.js";
import { canInspectAgentPrivateSurfaces } from "./agents.js";

export const reminderRouter: RouterType = Router();

function parseStatusParam(raw: unknown): ReminderStatus[] | null | "invalid" {
  if (raw == null) return null;
  const parts = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  // Use the shared type-guard to narrow each part — no `as ReminderStatus` cast.
  const validated: ReminderStatus[] = [];
  for (const p of parts) {
    if (!isReminderStatus(p)) return "invalid";
    validated.push(p);
  }
  return validated;
}

// GET /api/reminders?ownerAgentId=...&status=scheduled,fired
reminderRouter.get("/", async (req, res) => {
  try {
    const ownerAgentId = typeof req.query.ownerAgentId === "string" ? req.query.ownerAgentId : undefined;
    const parsedStatus = parseStatusParam(req.query.status);
    if (parsedStatus === "invalid") {
      res.status(400).json({ error: "Invalid status value" });
      return;
    }

    if (ownerAgentId) {
      const agent = await agentService.getAgent(ownerAgentId);
      if (!agent || agent.serverId !== req.serverId) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      if (!await canInspectAgentPrivateSurfaces(req.serverId!, req.userId!, agent)) {
        res.status(403).json({ error: "The `editAgents` capability or human creator authority is required to view agent reminders" });
        return;
      }
    }

    const rows = await listAppReminders({
      serverId: req.serverId!,
      ownerAgentId,
      status: parsedStatus ?? undefined,
    });
    const reminders = await reminderService.toReminderSummaries(rows, req.serverId!);
    res.json({ reminders });
  } catch (err) {
    console.error("[reminders] list failed:", err);
    res.status(500).json({ error: "Failed to list reminders" });
  }
});
