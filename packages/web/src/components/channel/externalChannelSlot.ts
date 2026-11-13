import { useCallback, useEffect, useRef, useState } from "react";
import type { PaywallSurface } from "@botiverse/raft-shared";
import { trackPaywallShown } from "../../analytics/paywall";
import { useChannelStore } from "../../store/channelStore";
import type { Channel } from "../../store/channelStore";
import { useServerStore } from "../../store/serverStore";
import { openUpgradeDialog } from "../../store/upgradeDialogStore";
import type { ExternalLimitContext } from "../../store/upgradeDialogStore";
import { isSidebarExternalOnlyChannel } from "../layout/sidebarChannelVisibility";
import { readExternalChannelFreeLimit } from "./externalInvites";

/**
 * The Free plan's one external channel, as the entries that would start
 * another read it (cindyz, Warden): at the limit (GET
 * /channels/external-availability), the sidebar External section's create
 * entries and a second channel's Invite People Outside open the upgrade
 * dialog instead of Create Channel or the invite dialog, naming the channel
 * that holds the slot. Create Channel's own External keeps its limit line.
 */

type SlotChannelFields = Pick<Channel, "id" | "name" | "type" | "serverId" | "archivedAt" | "hasExternalRelation" | "jointServers">;

/**
 * A live channel of the current server that holds its slot as the client
 * sees it, by the server's rule (externalChannelsOfServerSql and the open
 * invites, externalInviteFreeLimitReached): a Guest or an open external
 * invite (`hasExternalRelation`), joint or not, or a joint channel another
 * server is active in (one with only a pending server and neither is not
 * external yet; without the list, it is taken to be).
 */
export function holdsExternalSlot(channel: SlotChannelFields, serverId: string | null | undefined): boolean {
  if (!serverId || channel.archivedAt || (channel.serverId && channel.serverId !== serverId)) return false;
  if (channel.type === "joint") {
    return channel.hasExternalRelation === true
      || !channel.jointServers
      || channel.jointServers.some((server) => server.serverId !== serverId && server.status === "active");
  }
  return isSidebarExternalOnlyChannel(channel);
}

/**
 * What the upgrade dialog says holds the slot: the server's one external
 * channel the client knows of, as "#name"; none known (a private channel
 * the viewer isn't in, data not loaded) or more than one (which holds it is
 * not for the client to say), the gate's own words. `exceptChannelId`: the
 * channel the Upgrade was met in, never the one holding it. The availability
 * answer names no channel, so never `openInvite`.
 */
export function externalSlotContext(
  channels: readonly SlotChannelFields[],
  serverId: string | null | undefined,
  exceptChannelId?: string | null,
): ExternalLimitContext {
  const held = channels.filter((channel) => channel.id !== exceptChannelId && holdsExternalSlot(channel, serverId));
  return held.length === 1 ? { kind: "slot", channel: `#${held[0].name}` } : { kind: "slot" };
}

/** The same, from the stores at the moment of the click. */
export function currentExternalSlotContext(exceptChannelId?: string | null): ExternalLimitContext {
  return externalSlotContext(useChannelStore.getState().channels, useServerStore.getState().current?.id, exceptChannelId);
}

type ExternalLimitSurface = Extract<PaywallSurface, "sidebar" | "external_invite_dialog">;

/**
 * An entry that would start another external channel, clicked with the slot
 * taken: the upgrade dialog in its place. Recorded as the paywall shown, with
 * the entry's surface (once a session, as every paywall_shown), and opened
 * unprompted: the person pressed "+" or Create/Invite, not an Upgrade, so no
 * `upgrade` action (Nova, as the upload refusal's dialog).
 */
function openExternalLimitUpgrade(surface: ExternalLimitSurface): void {
  trackPaywallShown("external_channel_free_limit", surface);
  openUpgradeDialog("external_channel_free_limit", { surface, unprompted: true, externalContext: currentExternalSlotContext() });
}

// The ids of the channels holding the slot, for the channel list last read:
// the selector runs on every change to the channel store.
let slotKeyCache: { channels: readonly SlotChannelFields[]; serverId: string; key: string } | null = null;

function slotChannelsKey(channels: readonly SlotChannelFields[], serverId: string): string {
  if (slotKeyCache?.channels === channels && slotKeyCache.serverId === serverId) return slotKeyCache.key;
  const key = channels.filter((channel) => holdsExternalSlot(channel, serverId)).map((channel) => channel.id).join(",");
  slotKeyCache = { channels, serverId, key };
  return key;
}

/**
 * An entry that would start another external channel: `gate(proceed)` runs
 * `proceed` (Create Channel, the invite dialog), or, with the current
 * server's one Free external channel taken, opens the upgrade dialog with
 * `surface` instead. Asked ahead of the click while `enabled` (the viewer may
 * create external channels) on a Free server only (the plan as Plan & Billing
 * reads it; not yet known: not asked), and again when the server's external
 * channels change. A click that finds it taken asks once more before
 * deciding (the slot may have been freed elsewhere: a channel archived, an
 * invite withdrawn); still taken, the upgrade dialog; freed or a failed read,
 * `proceed`. Clicks while that is out do nothing. Not answered yet: `proceed`.
 */
export function useExternalLimitGate(enabled: boolean, surface: ExternalLimitSurface): (proceed: () => void) => void {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const free = useServerStore((s) => (s.billing?.plan || s.current?.plan) === "free");
  const active = enabled && free && serverId !== null;
  const refreshKey = useChannelStore((s) => (active && serverId ? slotChannelsKey(s.channels, serverId) : ""));
  const [answer, setAnswer] = useState<{ serverId: string; reached: boolean } | null>(null);
  useEffect(() => {
    if (!active || !serverId) return;
    let cancelled = false;
    readExternalChannelFreeLimit().then(
      (reached) => {
        if (!cancelled) setAnswer({ serverId, reached });
      },
      () => {
        if (!cancelled) setAnswer({ serverId, reached: false });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [active, serverId, refreshKey]);
  const taken = active && answer?.serverId === serverId && answer.reached;
  const rereading = useRef(false);
  return useCallback((proceed: () => void) => {
    if (!taken || !serverId) {
      proceed();
      return;
    }
    if (rereading.current) return;
    rereading.current = true;
    // Nothing to do once the person has moved to another server.
    const stillHere = () => useServerStore.getState().current?.id === serverId;
    readExternalChannelFreeLimit().then(
      (reached) => {
        rereading.current = false;
        setAnswer({ serverId, reached });
        if (!stillHere()) return;
        if (reached) openExternalLimitUpgrade(surface);
        else proceed();
      },
      () => {
        rereading.current = false;
        if (stillHere()) proceed();
      },
    );
  }, [taken, serverId, surface]);
}

/**
 * Invite People Outside <server> in a channel's member list: the invite
 * dialog's open state and its opener. On a channel that doesn't hold the
 * server's one Free external channel, with the slot taken, the opener opens
 * the upgrade dialog instead (surface `external_invite_dialog`).
 */
/** Where Invite People Outside was opened from, for external_invite_opened (Nova, #14521). */
export type AddExternalMemberEntry = "add_members_row" | "members_page_button";

export function useAddExternalMemberEntry(channel: SlotChannelFields | null, access: boolean) {
  const serverId = useServerStore((s) => s.current?.id);
  const gate = useExternalLimitGate(access && channel !== null && !holdsExternalSlot(channel, serverId), "external_invite_dialog");
  const [showAddExternal, setShowAddExternal] = useState<AddExternalMemberEntry | null>(null);
  const openAddExternalFromRow = useCallback(() => gate(() => setShowAddExternal("add_members_row")), [gate]);
  const openAddExternalFromPage = useCallback(() => gate(() => setShowAddExternal("members_page_button")), [gate]);
  const closeAddExternal = useCallback(() => setShowAddExternal(null), []);
  return { showAddExternal, openAddExternalFromRow, openAddExternalFromPage, closeAddExternal };
}
