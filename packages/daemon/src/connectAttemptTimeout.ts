import net from "node:net";

// Node connects to a host name one resolved address at a time
// (`autoSelectFamily`, on by default): it gives each address but the last
// 250 ms, then drops that attempt and tries the next. On a link whose TCP
// connect alone takes ~1 s, every attempt is dropped before the server
// answers. api.raft.build has 4 A and 8 AAAA records, so on a machine where
// IPv6 fails at once the request fails after ~1 s, as UND_ERR_CONNECT_TIMEOUT
// (undici 8 reports Node's all-timed-out AggregateError that way), long before
// the dispatcher's own connect timeout (#proj-raft-computer:#47). A longer
// per-address attempt keeps slow but working links. It costs time only when an
// address really does not answer, and the dispatcher's connect timeout (30 s
// for the agent proxy, undici's 10 s for the shared pool) still bounds the
// whole connect.
export const DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS = 2_500;

/** Process-wide; called once when the daemon starts. Never lowers a longer setting. */
export function applyDaemonConnectAttemptTimeout(): void {
  if (net.getDefaultAutoSelectFamilyAttemptTimeout() < DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS) {
    net.setDefaultAutoSelectFamilyAttemptTimeout(DAEMON_CONNECT_ATTEMPT_TIMEOUT_MS);
  }
}
