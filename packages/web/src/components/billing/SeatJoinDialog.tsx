import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { create } from "zustand";
import { PRO_AGENT_SEAT_BLOCK_SIZE, seatTenths, seatsFromTenths } from "@botiverse/raft-shared";
import type { SeatJoinBlock, SeatJoinSeatUsage } from "@botiverse/raft-shared";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerStore } from "../../store/serverStore";
import { notifySeatJoinBlocksChanged } from "../layout/useSeatJoinBlocks";
import { deferredDialog } from "../../boot/deferredUi";
import type { AddSeatsNeed, SeatUsage } from "./AddSeatsDialog";

const AddSeatsDialog = deferredDialog(() => import("./AddSeatsDialog"));

/** The notice the dialog is for, on the server it was opened on, with the seats the notice list gave. */
const useSeatJoinDialogStore = create<{ request: { serverId: string; block: SeatJoinBlock; usage: SeatJoinSeatUsage | null } | null }>(() => ({ request: null }));

/**
 * From the notification center's "someone couldn't join" notice (task #10,
 * behind pro_seat_add): a seat for that person. Billing is read first, so the
 * owner's dialog counts from the server's real seats; a link's creator who
 * can't read billing counts from the notice list's `usage`.
 */
export async function openSeatJoinDialog(block: SeatJoinBlock, usage?: SeatJoinSeatUsage): Promise<void> {
  const { current, billing, loadBilling } = useServerStore.getState();
  if (!current) return;
  if (!billing) await loadBilling();
  useSeatJoinDialogStore.setState({ request: { serverId: current.id, block, usage: usage ?? null } });
}

function closeSeatJoinDialog(): void {
  useSeatJoinDialogStore.setState({ request: null });
}

/**
 * Mounted once in the app, beside the upgrade dialog: the notification center
 * closes as its notice opens the dialog (`opensDialog`), so the dialog can't
 * live in it. An owner adds a seat for the person (AddSeatsDialog); an admin
 * or the link's creator asks an owner for it with a `join` seat request,
 * under an asking title. Either way the person opens the link again; nothing
 * joins them here.
 */
export default function SeatJoinDialogHost() {
  const { formatMessage } = useIntl();
  const request = useSeatJoinDialogStore((state) => state.request);
  const serverId = useServerStore((state) => state.current?.id);
  const serverName = useServerStore((state) => state.current?.name ?? "");
  const billing = useServerStore((state) => state.billing);
  const { capabilities } = useServerPermissions();
  const block = request && request.serverId === serverId ? request.block : null;
  const asksOwner = !capabilities.manageBilling;

  // Billing when this viewer can read it, else the notice list's numbers.
  // A partial billing response (no capacity/usage) falls back to the notice's numbers.
  const usage: SeatUsage = billing?.capacity && billing.usage
    ? { seats: Math.max(0, billing.capacity.maxUniversalSeats), humans: billing.usage.humans, agents: billing.usage.agents }
    : { seats: request?.usage?.seats ?? 0, humans: request?.usage?.humans ?? 0, agents: request?.usage?.agents ?? 0 };
  const { seats, humans, agents } = usage;
  const roomTenths = seats * PRO_AGENT_SEAT_BLOCK_SIZE - seatTenths(humans, agents);
  const need: AddSeatsNeed | null = useMemo(() => (block ? {
    tenths: PRO_AGENT_SEAT_BLOCK_SIZE,
    label: formatMessage({ id: "addSeats.join.label" }, { name: block.name }),
    title: formatMessage({ id: asksOwner ? "addSeats.join.askTitle" : "addSeats.join.title" }, { name: block.name }),
    hint: asksOwner
      ? formatMessage({ id: "addSeats.askHint" }, { server: serverName, seats })
      : roomTenths > 0
        ? formatMessage({ id: "addSeats.join.hintRoom" }, { server: serverName, room: seatsFromTenths(roomTenths), name: block.name })
        : formatMessage({ id: "addSeats.join.hint" }, { server: serverName, seats, name: block.name }),
    resume: formatMessage({ id: "addSeats.join.resume" }, { name: block.name }),
    gate: "seat_limit_invite",
  } : null), [asksOwner, block, formatMessage, roomTenths, seats, serverName]);
  const ask = useMemo(() => (block && asksOwner ? {
    purpose: { kind: "join" as const, userId: block.userId, name: block.name },
    usage: { seats, humans, agents },
  } : undefined), [agents, asksOwner, block, humans, seats]);

  // Added, or asked: the notice reads again (it goes once there's a seat).
  const handleDone = useCallback(() => {
    closeSeatJoinDialog();
    notifySeatJoinBlocksChanged(serverId);
  }, [serverId]);

  if (!need) return null;
  return <AddSeatsDialog need={need} ask={ask} onClose={closeSeatJoinDialog} onAdded={handleDone} onSent={handleDone} />;
}
