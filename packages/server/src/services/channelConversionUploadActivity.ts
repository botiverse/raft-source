import { sql } from "drizzle-orm";

// Which upload rows can still publish into a channel: the one rule every
// "uploads in flight" check for channel conversion uses (the prepare
// preflight and reconcileConversionUploadBlocker).
//
// A row past its expires_at can't publish, so it doesn't block conversion:
// completing an expired session is refused (its transfer intent is no longer
// publishable), as is adopting an expired transfer intent or sending with an
// expired reservation. Expired reservations are only marked expired by the
// lifecycle sweep, which is off in production, so without this rule an upload
// someone abandoned in a composer would hold its channel's conversion for good
// (#triage:#103). The database clock decides, like the lifecycle sweep.
//
// Each fragment reads its table under the alias the checks use: `upload`
// (attachment_upload_sessions), `intent` (attachment_transfer_intents) and
// `reservation` (attachment_upload_reservations).

export const SESSION_IN_FLIGHT = sql`upload.state IN ('pending', 'verifying') AND upload.expires_at > now()`;
export const TRANSFER_INTENT_IN_FLIGHT = sql`intent.state = 'planned' AND intent.expires_at > now()`;
export const RESERVATION_IN_FLIGHT = sql`reservation.state = 'pending' AND reservation.expires_at > now()`;
