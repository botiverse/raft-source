import { useCallback, useEffect, useEffectEvent, useState } from "react";
import api from "../../api/client";
import { getSocket } from "../../api/socket";
import { createVisiblePoll } from "../../utils/visiblePoll";
import type { AttachableServer, DeviceLoginGrant, DeviceLoginRequest } from "../../components/auth/deviceLoginApproval";
import type { DeviceLoginApproval } from "../../components/auth/useDeviceLoginApproval";

// Add Computer's pairing (docs/contracts/computer-pairing.md, design
// "one-click Computer login" §11 B): while the window shows the command, it
// holds a pairing for its server, and the one-paste command carries
// `--pair <pairingId>`. The Computer that runs it starts its ordinary device
// login, linked to this window, which then shows the device login's confirm
// screen without a code typed. The id only routes a request here; nothing is
// approved without the person's click. It lives in this hook's memory only:
// never in an address, storage, a log, a trace or an event.

/** Renew well before the server's 10 minutes run out. */
export const PAIRING_RENEW_MS = 5 * 60_000;
/** The status read when no realtime event came (only while the page is visible). */
export const PAIRING_POLL_MS = 10_000;

type Pairing = { pairingId: string; pairingRef: string };

type PairingState = "waiting" | "requested" | "conflict" | "voided" | "expired" | "approved" | "denied";

/** What `POST /computer-pairings/status` answers. */
type PairingStatus = {
  pairingRef: string;
  state: PairingState;
  request?: Omit<DeviceLoginRequest, "grant" | "pairingId"> & {
    grant: Pick<DeviceLoginGrant, "machineName" | "hostname" | "os"> & { kind: "computer_attach" | "computer_migrate" };
  };
};

type Failure = { response?: { status?: number; data?: { code?: string } } };
const codeOf = (err: unknown) => (err as Failure).response?.data?.code ?? null;

/**
 * The window's pairing while `active` (the command is on screen) for
 * `server`: created on open, renewed while open, cancelled on close, a server
 * change or leaving the command. Returns the id for the command (null: none,
 * the command goes without `--pair`) and whether the last one was voided
 * because the command was run more than once (`conflict`).
 */
export function useComputerPairing({ active, server, channel, approval }: {
  active: boolean;
  server: AttachableServer | null;
  /** The Hands channel the window's one-paste command installs from: the
   *  server pairs only when that channel's Computer takes `--pair`. */
  channel: "main" | "alpha";
  approval: DeviceLoginApproval;
}) {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  // Bumped to replace the pairing with a new one (a new command).
  const [generation, setGeneration] = useState(0);
  const [conflict, setConflict] = useState(false);
  // The pairing's request was approved: nothing more to pair.
  const [done, setDone] = useState(false);
  const serverId = server?.id ?? null;
  const live = active && serverId !== null && !done;

  const replace = useCallback(() => setGeneration((value) => value + 1), []);

  // Create, and cancel when this pairing stops being the window's.
  useEffect(() => {
    if (!live) return;
    let current = true;
    let created: Pairing | null = null;
    void api.post<Pairing>(`/servers/${serverId}/computer-pairings`, { channel }).then(({ data }) => {
      created = { pairingId: data.pairingId, pairingRef: data.pairingRef };
      if (current) {
        setPairing(created);
      } else {
        void api.post("/computer-pairings/cancel", { pairingId: created.pairingId }).catch(() => undefined);
      }
    }, () => {
      // Not allowed here, too many windows, a server without pairing, or a
      // channel whose Computer doesn't take --pair yet:
      // today's command, and the code field still works.
    });
    return () => {
      current = false;
      setPairing(null);
      if (created) void api.post("/computer-pairings/cancel", { pairingId: created.pairingId }).catch(() => undefined);
    };
  }, [live, serverId, channel, generation]);

  const showsThisPairing = (pairingId: string) => {
    const { step } = approval;
    return (step.kind === "confirm" || step.kind === "stepUp") && step.request.pairingId === pairingId;
  };

  // A second machine used the command: neither request is approvable here.
  const voidedByConflict = useEffectEvent((pairingId: string) => {
    if (showsThisPairing(pairingId)) approval.reset();
    setConflict(true);
    replace();
  });

  const approvalRefused = useEffectEvent((pairingId: string, code: string | null) => {
    if (code === "computer_pairing_conflict") voidedByConflict(pairingId);
    else if (code?.startsWith("computer_pairing_")) replace();
  });

  const applyStatus = useEffectEvent((current: Pairing, status: PairingStatus) => {
    if (status.state === "requested" && status.request && server) {
      // Only into an idle window (or after a denial): a code being reviewed keeps its screen.
      if ((approval.step.kind !== "enter" && approval.step.kind !== "denied") || approval.submitting !== null) return;
      const request: DeviceLoginRequest = {
        ...status.request,
        // The server this window is for, the only one the pairing approves for.
        grant: { ...status.request.grant, servers: [server] },
        pairingId: current.pairingId,
      };
      setConflict(false);
      approval.show(request, (code) => approvalRefused(current.pairingId, code));
    } else if (status.state === "conflict") {
      voidedByConflict(current.pairingId);
    } else if (status.state === "approved") {
      setDone(true);
    } else if (status.state !== "waiting" && status.state !== "requested") {
      // Expired, cancelled, or its request denied: quietly a new command.
      if (showsThisPairing(current.pairingId)) approval.reset();
      replace();
    }
  });

  const pairingEnded = useEffectEvent((current: Pairing, code: string | null) => {
    if (code === "computer_pairing_conflict") voidedByConflict(current.pairingId);
    else if (code === "computer_pairing_ended" || code === "computer_pairing_not_found") replace();
  });

  // Renew while open; read the status on realtime events and, as a fallback,
  // every 10 s while the page is visible.
  useEffect(() => {
    if (!pairing) return;
    let current = true;
    const readStatus = () => {
      void api.post<PairingStatus>("/computer-pairings/status", { pairingId: pairing.pairingId }).then(({ data }) => {
        if (current) applyStatus(pairing, data);
      }, (err: unknown) => {
        if (current) pairingEnded(pairing, codeOf(err));
      });
    };
    const renew = setInterval(() => {
      void api.post("/computer-pairings/renew", { pairingId: pairing.pairingId }).catch((err: unknown) => {
        if (current) pairingEnded(pairing, codeOf(err));
      });
    }, PAIRING_RENEW_MS);
    const poll = createVisiblePoll(readStatus, { intervalMs: PAIRING_POLL_MS });
    // Sent to this person's own sockets only (`user:<id>`); matched by the pairing's row id.
    const socket = getSocket();
    const onRequested = (event: { pairingRef?: string }) => {
      if (event?.pairingRef === pairing.pairingRef) poll.request();
    };
    const onVoided = (event: { pairingRef?: string; reason?: string }) => {
      if (event?.pairingRef !== pairing.pairingRef) return;
      if (event.reason === "conflict") voidedByConflict(pairing.pairingId);
      else poll.request();
    };
    socket.on("computer_pairing:requested", onRequested);
    socket.on("computer_pairing:voided", onVoided);
    return () => {
      current = false;
      clearInterval(renew);
      poll.stop();
      socket.off("computer_pairing:requested", onRequested);
      socket.off("computer_pairing:voided", onVoided);
    };
  }, [pairing]);

  return { pairingId: live ? pairing?.pairingId ?? null : null, conflict: live && conflict };
}
