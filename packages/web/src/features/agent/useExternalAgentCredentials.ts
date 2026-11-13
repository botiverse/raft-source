// An external agent's credentials on its page (#wg-external-agent-ux:#2): the list, a new one made
// here (named PAGE_CREDENTIAL_NAME, replacing only the page's earlier one), and revoke. The secret of
// a new credential lives only in this hook's state, never in a store.
import { useCallback, useEffect, useRef, useState } from "react";
import api from "../../api/client";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../../components/settings/secondFactorStepUp";
import { PAGE_CREDENTIAL_NAME } from "./externalAgentSetup";
import type { AgentCredentialRow } from "./externalAgentSetup";

type Inventory = { credentials: AgentCredentialRow[]; loading: boolean; listError: boolean };

export function useExternalAgentCredentials(agentId: string, enabled: boolean) {
  const [inventory, setInventory] = useState<Inventory>({ credentials: [], loading: enabled, listError: false });
  const [revision, setRevision] = useState(0);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"create" | "revoke" | null>(null);
  const requesting = useRef(false);

  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    void api.get(`/agents/${encodeURIComponent(agentId)}/credentials`).then(({ data }) => {
      if (!active) return;
      if (data?.agentId !== agentId || !Array.isArray(data.credentials)) throw new Error("Invalid credential list");
      setInventory({ credentials: data.credentials, loading: false, listError: false });
    }).catch(() => { if (active) setInventory({ credentials: [], loading: false, listError: true }); });
    return () => { active = false; };
  }, [agentId, enabled, revision]);

  const active = inventory.credentials.filter((credential) => !credential.revokedAt);
  const pageCredential = active.find((credential) => credential.name === PAGE_CREDENTIAL_NAME) ?? null;

  /** A new credential made on this page; it replaces the page's earlier one, never a CLI login's. */
  const create = useCallback(async (replacesCredentialId: string | null) => {
    if (requesting.current) return false;
    requesting.current = true;
    setBusy(true);
    setError(null);
    try {
      const body = replacesCredentialId ? { name: PAGE_CREDENTIAL_NAME, replacesCredentialId } : { name: PAGE_CREDENTIAL_NAME };
      // Two-step verification on: "Verify it's you" first, then the same request once more.
      const { data } = await withSecondFactorStepUp(() => api.post(`/agents/${encodeURIComponent(agentId)}/credentials`, body), "agentKey");
      if (data?.agentId !== agentId || typeof data.apiKey !== "string" || !data.apiKey.startsWith("sk_agent_")) throw new Error("Invalid credential response");
      setSecret(data.apiKey);
      setRevision((value) => value + 1);
      return true;
    } catch (err) {
      // Closed "Verify it's you": nothing was created, nothing to say. Payloads never go to logs.
      if (!isSecondFactorStepUpCancelled(err)) setError("create");
      return false;
    } finally {
      requesting.current = false;
      setBusy(false);
    }
  }, [agentId]);

  const revoke = useCallback(async (credentialId: string) => {
    if (requesting.current) return false;
    requesting.current = true;
    setBusy(true);
    setError(null);
    try {
      await api.delete(`/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}`);
      setInventory((previous) => ({ ...previous, credentials: previous.credentials.map((item) => item.id === credentialId ? { ...item, revokedAt: new Date().toISOString() } : item) }));
      return true;
    } catch {
      // An ambiguous failure is not a revocation: the row stays.
      setError("revoke");
      return false;
    } finally {
      requesting.current = false;
      setBusy(false);
    }
  }, [agentId]);

  return { ...inventory, active, pageCredential, secret, busy, error, create, revoke };
}
