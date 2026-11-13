// POST /api/integrations/antiproton/approvals: antiproton's signed hint that
// one of a hosted agent's held calls changed (docs/contracts/hosted-agent-approvals.md).
// No login: an Ed25519 signature under the configured public key its key id
// names, within the time window, is the authentication (verifyApprovalHint),
// and the body only says which agent to pull; everything shown comes from that
// pull, made with Raft's own provider token. Answered before the pull
// (antiproton waits 5 s).
import type { RequestHandler } from "express";
import type { Server as SocketServer } from "socket.io";
import { scheduleAgentApprovalPull, verifyApprovalHint } from "../services/agentRuntimeApprovalService";

export const receiveAntiprotonApprovalHint: RequestHandler = (req, res) => {
  const verdict = verifyApprovalHint({
    body: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
    timestamp: req.get("x-antiproton-timestamp"),
    signature: req.get("x-antiproton-signature"),
    nowMs: Date.now(),
  });
  if (!verdict.ok) {
    res.status(verdict.status).json({ error: { code: verdict.code } });
    return;
  }
  res.status(202).json({ ok: true });
  void scheduleAgentApprovalPull({
    target: verdict.target,
    raftAgentId: verdict.raftAgentId,
    raftServerId: verdict.raftServerId,
    io: (req.app.get("io") ?? null) as SocketServer | null,
  });
};
