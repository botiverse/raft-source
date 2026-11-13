import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";

import api from "../../api/client";
import type { ForwardSearchHandle, ForwardSearchTarget } from "./forwardComposerModel";

/** Typing settles before the servers are asked. */
const SEARCH_DEBOUNCE_MS = 200;
/** A server that hasn't answered by then counts as failed: the list never waits on one server. */
const SERVER_SEARCH_TIMEOUT_MS = 8000;

/** A server of the reader's, as the search names it on its rows. */
export interface CrossServerSearchServer {
  id: string;
  name: string;
}

type ServerAnswer = { status: "pending" } | { status: "ok"; targets: ForwardSearchTarget[] } | { status: "failed" };

/**
 * The Forward dialog's destination search across every server of the reader's
 * (the public Artifact page's Send to conversation, #proj-workspace:#128):
 * the same search (GET /messages/forward/targets/search) once per server,
 * each with that server's id (X-Server-Id), merged, every row naming its
 * server. Debounced; a newer query or a reset aborts the older one and its
 * late answers are dropped.
 *
 * - The current server's rows first (the dialog can join its channels and
 *   start its DMs), then the others in the reader's server order. From another
 *   server only conversations the reader can post in now: joining a channel
 *   or starting a DM there would need that server's own stores.
 * - Each server's rows show as soon as it answers. One that fails, or doesn't
 *   answer in SERVER_SEARCH_TIMEOUT_MS, leaves out only its own rows; a line
 *   under the rest names it (`partialFailure`). All of them failing is the
 *   search's failure, with Try Again.
 */
export function useCrossServerForwardSearch(servers: readonly CrossServerSearchServer[], currentServerId: string | null): ForwardSearchHandle {
  const { formatMessage, formatList } = useIntl();
  const [answers, setAnswers] = useState<Record<string, ServerAnswer> | null>(null);
  const requestRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controllersRef = useRef<AbortController[]>([]);
  const serversRef = useRef(servers);
  serversRef.current = servers;

  const cancel = useCallback(() => {
    ++requestRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current = [];
  }, []);
  useEffect(() => cancel, [cancel]);

  const search = useCallback((q: string) => {
    cancel();
    const request = requestRef.current;
    const asked = [...serversRef.current];
    setAnswers(Object.fromEntries(asked.map((server): [string, ServerAnswer] => [server.id, { status: "pending" }])));
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      for (const server of asked) {
        const controller = new AbortController();
        controllersRef.current.push(controller);
        const timeout = setTimeout(() => controller.abort(), SERVER_SEARCH_TIMEOUT_MS);
        const settle = (answer: ServerAnswer) => {
          clearTimeout(timeout);
          if (request !== requestRef.current) return;
          setAnswers((current) => (current ? { ...current, [server.id]: answer } : current));
        };
        api.get<{ targets: ForwardSearchTarget[] }>("/messages/forward/targets/search", {
          params: { q, limit: 20 },
          headers: { "X-Server-Id": server.id },
          signal: controller.signal,
        }).then(
          (res) => settle({ status: "ok", targets: (res.data.targets ?? []).map((target) => ({ ...target, serverId: server.id, serverName: server.name })) }),
          () => settle({ status: "failed" }),
        );
      }
    }, SEARCH_DEBOUNCE_MS);
  }, [cancel]);

  const reset = useCallback(() => {
    cancel();
    setAnswers(null);
  }, [cancel]);

  return useMemo((): ForwardSearchHandle => {
    if (!answers) return { results: [], loading: false, failed: false, partialFailure: null, search, reset };
    const ordered = [
      ...servers.filter((server) => server.id === currentServerId),
      ...servers.filter((server) => server.id !== currentServerId),
    ].filter((server) => answers[server.id]);
    const results = ordered.flatMap((server) => {
      const answer = answers[server.id];
      if (answer?.status !== "ok") return [];
      return server.id === currentServerId
        ? answer.targets
        : answer.targets.filter((target) => target.requiredAction === null && target.canForwardNow && target.channelId !== null);
    });
    const failedServers = ordered.filter((server) => answers[server.id]?.status === "failed");
    const pending = ordered.some((server) => answers[server.id]?.status === "pending");
    const allFailed = ordered.length > 0 && failedServers.length === ordered.length;
    return {
      results,
      // Waiting only while nothing has come back: the first server to answer shows its rows.
      loading: pending && results.length === 0,
      failed: allFailed,
      partialFailure: failedServers.length > 0 && !allFailed
        ? formatMessage({ id: "message.forwardComposer.serverSearchFailed" }, { servers: formatList(failedServers.map((server) => server.name), { type: "conjunction" }) })
        : null,
      search,
      reset,
    };
  }, [answers, servers, currentServerId, formatMessage, formatList, search, reset]);
}
