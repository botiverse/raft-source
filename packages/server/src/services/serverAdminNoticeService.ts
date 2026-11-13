import { durableTaskKind, DurableTaskRegistry, type DurableTaskDefinition } from "./durableTasks";

/**
 * Retired: the server-admin notice (#13746), a system message in each owner's
 * and admin's own DM with themselves (`human_self`), is no longer sent
 * (cindyz, #wg-rbac:#42 option A: no DMs anywhere in the external channel
 * flow). Connecting and disconnecting servers is told in the channel itself
 * (a channel system message on every connected server) and recorded by the
 * `channel.server_connected` / `channel.server_disconnected` audit events.
 *
 * What stays is the durable task kind `server.admin_notice`, as a drain: rows
 * an earlier release queued (or an older replica still queues during the
 * rollout) are completed without sending anything. Recovery claims only kinds
 * a registry knows (claimExpiredDurableTasks), so without this definition such
 * rows would stay `open` forever, counted as overdue. Any payload completes:
 * the row's content no longer matters. Notices delivered before stay where
 * they are (system rows, `system_subtype` `server.admin_notice`).
 */
const legacyServerAdminNoticeDefinition: DurableTaskDefinition<null> = {
  kind: durableTaskKind("server.admin_notice"),
  payloadVersion: 1,
  leaseMs: 60_000,
  maxAttempts: 12,
  decode: () => null,
  async handle() {
    // Nothing to send (see above): the task succeeds.
  },
};

// Recovered on every replica, independent of the legacy durable-task switch.
export const serverAdminNoticeRegistry = new DurableTaskRegistry().register(legacyServerAdminNoticeDefinition);
