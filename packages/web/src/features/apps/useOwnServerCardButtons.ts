import { useCallback, useEffect, useState } from "react";
import api from "../../api/client";
import { readCardButtons } from "./connected-apps/ownServerCardButtons";
import type { AllowCardButtonsOutcome, CardButtonsRead } from "./connected-apps/ownServerCardButtons";

const ENDPOINT_CHANGED = "OWN_SERVER_ACTIONS_ENDPOINT_CHANGED";
/** Refusals after which there is nothing to allow: read the section again and close the dialog on it. */
const NOTHING_TO_ALLOW: ReadonlySet<unknown> = new Set([
  "OWN_SERVER_ACTIONS_NO_ENDPOINT",
  "OWN_SERVER_ACTIONS_NOT_SERVER_LOCAL",
  "OWN_SERVER_ACTIONS_PENDING_REVIEW",
  "OWN_SERVER_ACTIONS_OFFICIAL_APP",
]);

const pathOf = (clientRowId: string) => `/integrations/clients/${clientRowId}/action-endpoint`;

/** A 409's refusal code (`{ error, code, errorCode }`), or null. */
function conflictCode(error: unknown): unknown {
  const response = (error as { response?: { status?: unknown; data?: { code?: unknown } } } | null)?.response;
  return response?.status === 409 ? response.data?.code ?? null : null;
}

/**
 * The Card buttons section (RFC 076 §17, #proj-apps:#73) of an App
 * (`clientRowId`, the App's row id; null: no section): in the editor of an App
 * made on this Server, and on the page of an App installed here. Reads
 * GET .../action-endpoint while it is open: only this Server's owners and
 * admins get an answer, anyone else a 404, as does an App with no link preview
 * registration or one not installed here; then, as on any failure, there is no
 * section. An official App reads as `official` (one line, nothing to change).
 *
 * `allow` allows the endpoint in force (or switches an own-Server App's buttons
 * back on), sending exactly the endpoint the person was shown; if the App
 * changed it meanwhile (409), the answer is read again and the new one comes
 * back for them to check. `withdraw` withdraws the allow (or switches an
 * own-Server App's buttons off). Both read the section again after; other
 * failures throw.
 */
export function useOwnServerCardButtons(clientRowId: string | null, { installed = false }: { installed?: boolean } = {}) {
  const [loaded, setLoaded] = useState<{ clientRowId: string; view: CardButtonsRead } | null>(null);

  const read = useCallback(async (id: string): Promise<CardButtonsRead> => {
    try {
      const { data } = await api.get(pathOf(id));
      return readCardButtons(data, { installed });
    } catch {
      return null;
    }
  }, [installed]);

  useEffect(() => {
    if (!clientRowId) return;
    let live = true;
    void read(clientRowId).then((view) => { if (live) setLoaded({ clientRowId, view }); });
    return () => { live = false; };
  }, [clientRowId, read]);

  const reload = useCallback(async (id: string) => {
    const view = await read(id);
    setLoaded({ clientRowId: id, view });
    return view;
  }, [read]);

  const allow = useCallback(async (actionEndpoint: string): Promise<AllowCardButtonsOutcome> => {
    const id = clientRowId;
    if (!id) return { kind: "gone" };
    try {
      await api.put(`${pathOf(id)}/own-server-actions`, { action_endpoint: actionEndpoint });
    } catch (error) {
      const code = conflictCode(error);
      if (code !== ENDPOINT_CHANGED && !NOTHING_TO_ALLOW.has(code)) throw error;
      const read = await reload(id);
      const view = read?.kind === "view" ? read.view : null;
      const next = view?.actionEndpoint;
      return code === ENDPOINT_CHANGED && view && next && next !== actionEndpoint && (view.state === "not_allowed" || view.state === "endpoint_changed" || view.state === "off")
        ? { kind: "endpoint_changed", actionEndpoint: next }
        : { kind: "gone" };
    }
    await reload(id);
    return { kind: "allowed" };
  }, [clientRowId, reload]);

  const withdraw = useCallback(async () => {
    const id = clientRowId;
    if (!id) return;
    await api.delete(`${pathOf(id)}/own-server-actions`);
    await reload(id);
  }, [clientRowId, reload]);

  const view = clientRowId && loaded?.clientRowId === clientRowId ? loaded.view : null;
  return { view, allow, withdraw };
}
