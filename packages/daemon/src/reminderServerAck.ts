/**
 * RFC 081 D7 (one read state): this daemon build always declares this token
 * in `X-Raft-Client-Capabilities` on what its agent proxy sends, and always
 * acks a fired reminder through the Server (`POST /app-sources/ack`), never in
 * its local cache alone, whatever the agent's inbox items flag. The CLI never
 * declares it. The shared-package constant (Remy's server PR) can replace
 * this one.
 */
export const REMINDER_SERVER_ACK_CAPABILITY = "reminder-server-ack@1";
