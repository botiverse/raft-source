import type { MouseEvent } from "react";
import { useCallback, useEffect, useReducer, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import api from "../api/client";
type Reader = { agentId: string; name: string; displayName: string | null; enabled: boolean };
/** Mounted with a server/user key; unmount discards grants and pending requests. */
export default function ReaderAccess({ serverId, enabled }: { serverId: string; enabled: boolean }) {
  const { formatMessage: t } = useIntl();
  const [{ readers, failed }, update] = useReducer((state: { readers: Reader[]; failed: boolean }, patch: Partial<{ readers: Reader[]; failed: boolean }>) => ({ ...state, ...patch }), { readers: [], failed: false });
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api.get<{ readers: Reader[] }>("/raftbench/readers", { headers: { "X-Server-Id": serverId }, signal: controller.signal }).then(({ data }) => { if (!controller.signal.aborted) { update({ readers: data.readers, failed: false }); } }).catch(() => { if (!controller.signal.aborted) { update({ readers: [], failed: true }); } });
    return () => controller.abort();
  }, [serverId, revision]);
  const toggle = useCallback(async (reader: Reader) => {
    if (busy) return;
    setBusy(true); update({ failed: false });
    try { await api.put(`/raftbench/readers/${reader.agentId}`, { enabled: !reader.enabled }, { headers: { "X-Server-Id": serverId } }); setRevision(value => value + 1); }
    catch { update({ failed: true }); }
    finally { setBusy(false); }
  }, [busy, serverId]);
  const click = useCallback((event: MouseEvent<HTMLButtonElement>) => { const reader = readers.find(value => value.agentId === event.currentTarget.dataset.agent); if (reader) void toggle(reader); }, [readers, toggle]);
  return <details className="mt-4"><summary className="cursor-pointer text-callout font-semibold">{t({ id: "raftbench.readerAccess" })}</summary>
    <p className="mt-2 text-caption text-foreground-hint">{t({ id: "raftbench.readerAccessHelp" })}</p>
    {failed && <p role="alert" className="mt-2 text-callout">{t({ id: "raftbench.readerAccessError" })}</p>}
    <ul className="mt-2 stack-y-2">{readers.map(reader => <li key={reader.agentId} className="flex items-center justify-between gap-2 text-callout"><span>{reader.displayName || reader.name}</span><Button size="md" disabled={busy || (!enabled && !reader.enabled)} data-agent={reader.agentId} onClick={click}>{t({ id: reader.enabled ? "raftbench.readerRevoke" : "raftbench.readerGrant" })}</Button></li>)}</ul>
  </details>;
}
