import { seatRequestReadyOutcome } from "@botiverse/raft-shared";
import type { SeatRequestOutcome, SeatsAddPurpose } from "@botiverse/raft-shared";

/** ICU arguments for a seat request's purpose: `kind` picks the sentence, the rest fill it (a type, so it passes as message values). */
export type SeatCopyValues = { kind: string; name: string; role: string; count: number };

/**
 * A purpose from a server newer than this build (stored metadata may be): its
 * `kind` falls to each select's `other`, which in the owner's add-seats hint
 * and resume says the requester can go ahead. The asker's own copy only ever
 * has this build's purposes (the client builds them).
 */
const NEWER_PURPOSE_COPY_VALUES: SeatCopyValues = { kind: "other", name: "", role: "", count: 0 };

/**
 * ICU arguments for "you can <do it>" in the seat request copy (task #10): the
 * `kind` select is agent / assistant / invite / join (someone a full link
 * turned away) / other (a Guest made a member or admin). The asker's dialog
 * and toast and the card's outcome line share it. A join's outcome names no
 * one (the card's own line says it; see purposeCopyValues for the ask).
 * `null` for an outcome this build doesn't know (a newer server's): there is
 * no sentence for it, so the card says only who added the seats.
 */
export function seatActionCopyValues(outcome: Extract<SeatRequestOutcome, { kind: "ready" }>): SeatCopyValues | null {
  switch (outcome.purpose) {
    case "agent:create":
      return { kind: "agent", name: outcome.name, role: "", count: 0 };
    case "assistant:create":
      return { kind: "assistant", name: "", role: "", count: 0 };
    case "invite":
      return { kind: "invite", name: "", role: "", count: outcome.count };
    case "member:promote":
      return { kind: "promote", name: outcome.name, role: outcome.role, count: 0 };
    case "join":
      return { kind: "join", name: "", role: "", count: 0 };
    default:
      return null;
  }
}

/** The same arguments for what a request is for (the ask copy, the card's notice). */
export function purposeCopyValues(purpose: SeatsAddPurpose): SeatCopyValues {
  switch (purpose.kind) {
    case "join":
      // The ask names who it's for; the outcome doesn't.
      return { kind: "join", name: purpose.name, role: "", count: 0 };
    case "agent:create":
    case "assistant:create":
    case "invite":
    case "member:promote":
      return seatActionCopyValues(seatRequestReadyOutcome(purpose)) ?? NEWER_PURPOSE_COPY_VALUES;
    default:
      // seatRequestReadyOutcome knows only this build's purposes.
      return NEWER_PURPOSE_COPY_VALUES;
  }
}
