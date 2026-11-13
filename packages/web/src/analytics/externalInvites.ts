// The host's "invite people outside" flow (cindyz via Warden/Nova, 2026-11-12,
// #wg-rbac:db8d6e83): Invite People Outside <server> on a channel
// (`existing_channel`) and Create Channel's External choice (`create_channel`).
// Opened, reviewed, how a send ended, and where the person was when it closed.
// Enums and booleans only: counts go in buckets, and never an address, a
// channel, a server or an error's text.

import { EXTERNAL_INVITE_SEND_ERROR_CODES } from "@botiverse/raft-shared";
import type { ProductEventProperties } from "@botiverse/raft-shared";
import { useEffect, useState } from "react";
import { getProductEventServerId, trackEvent } from "./track";

type Opened = ProductEventProperties<"external_invite_opened">;
type Reviewed = ProductEventProperties<"external_invite_reviewed">;
type SendFinished = ProductEventProperties<"external_invite_send_finished">;

export type ExternalInviteFlow = Opened["flow"];
export type ExternalInviteEntry = Opened["entry"];
export type ExternalInviteStage = ProductEventProperties<"external_invite_closed">["stage"];
export type ExternalInviteSendErrorCode = NonNullable<SendFinished["error_code"]>;

/** Addresses the send would act on, as a bucket (at most 20 go at a time). */
export function externalInviteEmailsBucket(count: number): Reviewed["emails"] {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  return count <= 5 ? "2-5" : "6-20";
}

/** The person's own servers checked, as a bucket. */
export function externalInviteServersBucket(count: number): Reviewed["servers"] {
  if (count <= 0) return "0";
  return count === 1 ? "1" : "2+";
}

/**
 * A send that answered: `partial` when some of the person's own servers were
 * refused, or connecting them failed as a whole; else `sent`.
 */
export function externalInviteSendResult(result: {
  servers?: ReadonlyArray<{ state: string }>;
  serversFailed?: boolean;
}): "sent" | "partial" {
  return result.serversFailed || (result.servers ?? []).some((server) => server.state === "refused") ? "partial" : "sent";
}

/** The server's code for a failed send, when the dialog has a sentence for it; anything else (or none) is `other`. */
export function externalInviteSendErrorCode(code: string | null | undefined): ExternalInviteSendErrorCode {
  return (EXTERNAL_INVITE_SEND_ERROR_CODES as readonly string[]).includes(code ?? "")
    ? (code as ExternalInviteSendErrorCode)
    : "other";
}

/** One opening of the flow: what its dialog and its invite steps report. */
export interface ExternalInviteTracker {
  /** The flow became visible. Only the first call of an opening counts. */
  opened(entry: ExternalInviteEntry): void;
  /** The review is on screen, after the addresses were checked. */
  reviewed(shown: { emails: number; servers: number; historyWarningShown: boolean; becomesPrivate: boolean }): void;
  /** The review's Back, to the emails. */
  backToInput(): void;
  /** The send answered. */
  sendSucceeded(result: Parameters<typeof externalInviteSendResult>[0]): void;
  /** The send threw; `upgradeOffered`: the error shown offers Upgrade. */
  sendFailed(code: string | null, upgradeOffered: boolean): void;
  /**
   * The dialog closed. `stage`: the dialog's own step when it is not on the
   * invite steps (Create Channel's `details` / `people`); else where the
   * invite steps were. Once, and only for a flow that was opened.
   */
  closed(stage?: ExternalInviteStage): void;
}

/** The events of one opening, counted for the server the flow started in. */
export function createExternalInviteTracker(flow: ExternalInviteFlow): ExternalInviteTracker {
  const options = { serverId: getProductEventServerId() };
  let wasOpened = false;
  let wasClosed = false;
  let sent = false;
  let stepsStage: ExternalInviteStage = "input";
  return {
    opened(entry) {
      if (wasOpened) return;
      wasOpened = true;
      trackEvent("external_invite_opened", { flow, entry }, options);
    },
    reviewed({ emails, servers, historyWarningShown, becomesPrivate }) {
      stepsStage = "review";
      trackEvent("external_invite_reviewed", {
        flow,
        emails: externalInviteEmailsBucket(emails),
        servers: externalInviteServersBucket(servers),
        history_warning_shown: historyWarningShown,
        becomes_private: becomesPrivate,
      }, options);
    },
    backToInput() {
      stepsStage = "input";
    },
    sendSucceeded(result) {
      sent = true;
      trackEvent("external_invite_send_finished", { flow, result: externalInviteSendResult(result), upgrade_offered: false }, options);
    },
    sendFailed(code, upgradeOffered) {
      trackEvent("external_invite_send_finished", {
        flow, result: "failed", error_code: externalInviteSendErrorCode(code), upgrade_offered: upgradeOffered,
      }, options);
    },
    closed(stage) {
      if (!wasOpened || wasClosed) return;
      wasClosed = true;
      trackEvent("external_invite_closed", { flow, stage: stage ?? stepsStage, sent }, options);
    },
  };
}

/**
 * The tracker of a dialog's one opening. `entryOnOpen`: what opened the
 * dialog with the flow already showing; it is on screen because the dialog
 * mounted, and no click inside it says so.
 */
export function useExternalInviteTracker(flow: ExternalInviteFlow, entryOnOpen?: ExternalInviteEntry): ExternalInviteTracker {
  const [tracker] = useState(() => createExternalInviteTracker(flow));
  useEffect(() => {
    // Nothing to clean up: `opened` counts once per tracker, so a second run of this effect records nothing.
    // oxlint-disable-next-line react-doctor/no-event-handler -- No handler sees this: the dialog is loaded on demand and shown by its caller's state (a sidebar entry, a link's query), so "it is on screen" is its mount. What happens inside it is reported from its handlers.
    if (entryOnOpen) tracker.opened(entryOnOpen);
  }, [tracker, entryOnOpen]);
  return tracker;
}
