import { useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import api from "../../api/client";
import { copyTextToClipboard } from "../../utils/selectMarkdown";

type Credential = {
  id: string;
  maskedToken?: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

/** Mount keyed by agent id. Secrets stay in this panel, never in the agent store. */
export function ExternalAgentToken({ agentId }: { agentId: string }) {
  const { formatMessage, formatDate } = useIntl();
  const [token, setToken] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [inventory, setInventory] = useState<{ credentials: Credential[]; loading: boolean; listError: boolean }>({ credentials: [], loading: true, listError: false });
  const { credentials, loading, listError } = inventory;
  const [listRevision, setListRevision] = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [copied, setCopied] = useState(false);
  const requesting = useRef(false);

  useEffect(() => {
    let active = true;
    void api.get(`/agents/${encodeURIComponent(agentId)}/credentials`).then(({ data }) => {
      if (!active) return;
      if (data.agentId !== agentId || !Array.isArray(data.credentials)) throw new Error("Invalid credential list");
      setInventory({ credentials: data.credentials, loading: false, listError: false });
    }).catch(() => { if (active) setInventory({ credentials: [], loading: false, listError: true }); });
    return () => { active = false; };
  }, [agentId, listRevision]);

  async function revoke(credentialId: string) {
    if (requesting.current) return;
    requesting.current = true;
    setRevokingId(credentialId);
    setRevokeError(false);
    try {
      await api.delete(`/agents/${encodeURIComponent(agentId)}/credentials/${encodeURIComponent(credentialId)}`);
      setInventory((previous) => ({ ...previous, credentials: previous.credentials.map((item) => item.id === credentialId ? { ...item, revokedAt: new Date().toISOString() } : item) }));
      if (tokenId === credentialId) { setToken(""); setTokenId(""); setCopied(false); }
      setConfirmId(null);
    } catch {
      // An ambiguous failure is not a successful revocation; allow list refresh.
      setRevokeError(true);
    } finally {
      requesting.current = false;
      setRevokingId(null);
    }
  }

  async function generate() {
    if (requesting.current) return;
    requesting.current = true;
    setPending(true);
    setError(false);
    try {
      const { data } = await api.post(`/agents/${encodeURIComponent(agentId)}/credentials`, {});
      if (data.agentId !== agentId || typeof data.credentialId !== "string" || !data.credentialId || typeof data.apiKey !== "string" || !data.apiKey.startsWith("sk_agent_")) {
        throw new Error("Invalid credential response");
      }
      setToken(data.apiKey);
      setTokenId(data.credentialId);
      setInventory((previous) => ({ ...previous, loading: true, listError: false }));
      setListRevision((value) => value + 1);
    } catch {
      // Neither error payloads nor successful responses belong in logs/telemetry.
      setError(true);
    } finally {
      requesting.current = false;
      setPending(false);
    }
  }

  return (
    <div className="min-w-0 space-y-2" data-testid="external-agent-token">
      <p className="text-xs text-black/70">{formatMessage({ id: "agent.detail.externalTokenDescription" })}</p>
      {token ? (
        <>
          <label className="block text-xs font-bold">
            {formatMessage({ id: "agent.detail.externalTokenLabel" })}
            <input type="text" readOnly value={`${token.slice(0, 14)}***${token.slice(-7)}`} autoComplete="off" spellCheck={false}
              className="mt-1 block w-full min-w-0 border border-black/20 bg-white p-2 font-mono text-xs"
              data-private="true" data-ph-mask="true" />
          </label>
          <p className="text-xs text-black/60">{formatMessage({ id: "agent.detail.externalTokenOnce" })}</p>
          <button type="button" className="btn-brutal-sm whitespace-normal bg-white px-2 py-1 text-xs"
            onClick={async () => { try { await copyTextToClipboard(token); setCopied(true); } catch { setCopied(false); } }}>
            {formatMessage({ id: copied ? "agent.detail.copied" : "agent.detail.externalTokenCopy" })}
          </button>
        </>
      ) : (
        <button type="button" disabled={pending || revokingId !== null} onClick={() => void generate()}
          className="btn-brutal-sm whitespace-normal bg-white px-2 py-1 text-xs">
          {formatMessage({ id: pending ? "agent.detail.externalTokenGenerating" : "agent.detail.externalTokenGenerate" })}
        </button>
      )}
      {error && <p role="alert" className="text-xs text-brutal-orange">{formatMessage({ id: "agent.detail.externalTokenError" })}</p>}
      <div className="min-w-0 space-y-2 border-t border-black/20 pt-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-bold">{formatMessage({ id: "agent.detail.externalTokenList" })}</p>
          <button type="button" disabled={loading || pending || revokingId !== null}
            onClick={() => { setConfirmId(null); setRevokeError(false); setInventory((previous) => ({ ...previous, loading: true, listError: false })); setListRevision((value) => value + 1); }}
            className="btn-brutal-sm whitespace-normal bg-white px-2 py-1 text-xs">
            {formatMessage({ id: "agent.detail.externalTokenRefresh" })}
          </button>
        </div>
        {loading && <p role="status" className="text-xs">{formatMessage({ id: "agent.detail.externalTokenLoading" })}</p>}
        {listError && <p role="alert" className="text-xs text-brutal-orange">{formatMessage({ id: "agent.detail.externalTokenListError" })}</p>}
        {!loading && !listError && credentials.length === 0 && <p className="text-xs">{formatMessage({ id: "agent.detail.externalTokenEmpty" })}</p>}
        {!loading && !listError && credentials.map((credential) => (
          <div key={credential.id} className="min-w-0 space-y-1 border border-black/20 p-2 text-xs">
            <p className="break-words font-bold">{credential.name || formatMessage({ id: "agent.detail.externalTokenLabel" })} <span className="break-all font-mono font-normal">{credential.maskedToken || credential.id.slice(0, 8)}</span></p>
            <p>{formatMessage({ id: "agent.detail.externalTokenCreated" }, { date: formatDate(credential.createdAt, { dateStyle: "medium", timeStyle: "short" }) })}</p>
            <p>{formatMessage({ id: credential.revokedAt ? "agent.detail.externalTokenRevoked" : "agent.detail.externalTokenActive" })}</p>
            {!credential.revokedAt && (confirmId === credential.id ? (
              <>
                <p>{formatMessage({ id: "agent.detail.externalTokenRevokeWarning" })}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={pending || revokingId !== null} onClick={() => void revoke(credential.id)}
                    className="btn-brutal-sm whitespace-normal bg-white px-2 py-1">
                    {formatMessage({ id: "agent.detail.externalTokenConfirmRevoke" })}
                  </button>
                  <button type="button" disabled={revokingId !== null} onClick={() => setConfirmId(null)}
                    className="btn-brutal-sm whitespace-normal bg-white px-2 py-1">
                    {formatMessage({ id: "agent.detail.externalTokenCancel" })}
                  </button>
                </div>
              </>
            ) : (
              <button type="button" disabled={pending || revokingId !== null} onClick={() => { setConfirmId(credential.id); setRevokeError(false); }}
                className="btn-brutal-sm whitespace-normal bg-white px-2 py-1">
                {formatMessage({ id: "agent.detail.externalTokenRevoke" })}
              </button>
            ))}
          </div>
        ))}
        {revokeError && <p role="alert" className="text-xs text-brutal-orange">{formatMessage({ id: "agent.detail.externalTokenRevokeError" })}</p>}
      </div>
    </div>
  );
}
