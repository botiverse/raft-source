/**
 * What the personal (account/DataExportSection.tsx) and server
 * (administration/ServerDataPrivacySection.tsx) data export sections share:
 * the list, read again every 5 s while an export is being prepared and the
 * page is in view; the emailed link's export (`?data_export=<id>`), marked
 * once and taken off the address; the day format; the cooldown's "now".
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import { DATA_EXPORT_LINK_PARAM, DATA_EXPORT_SERVER_LINK_PARAM, dataExportIdOf } from "../../../utils/dataExportLink";
import { cachedDateTimeFormat } from "../../../utils/timeFormatting";
import { listDataExports, serverDataExports } from "./dataExportApi";
import type { DataExportList, DataExportMount } from "./dataExportApi";

/** While an export is being prepared, the list is read again this often. */
const DATA_EXPORT_POLL_MS = 5_000;
/** How often the cooldown's "now" moves on while the page stays open. */
const NOW_TICK_MS = 60_000;

export type DataExportLoad = { state: "loading" } | { state: "off" } | ({ state: "on" } & Omit<DataExportList, "available">);

/**
 * The mount's list: `off` while data export is off here (the 404) or can't be asked for
 * (`available` false); a list that can't be read keeps what was shown (fails closed to `off`).
 * `mount` must be stable (a constant, or memoized on its server).
 */
export function useDataExportList(mount: DataExportMount | null): { load: DataExportLoad; reload: () => Promise<void> } {
  const [load, setLoad] = useState<DataExportLoad>({ state: "loading" });
  const reload = useCallback(async () => {
    if (!mount) {
      setLoad({ state: "off" });
      return;
    }
    try {
      const listed = await listDataExports(mount);
      setLoad(listed && listed.available
        ? { state: "on", exports: listed.exports, nextAllowedAt: listed.nextAllowedAt, contextServerIds: listed.contextServerIds, closed: listed.closed }
        : { state: "off" });
    } catch {
      setLoad((current) => (current.state === "on" ? current : { state: "off" }));
    }
  }, [mount]);
  useEffect(() => {
    void reload();
  }, [reload]);

  // Data export off here: an emailed link still lands on the page; take its parameters off the address.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (load.state !== "off" || !params.has(DATA_EXPORT_LINK_PARAM)) return;
    setParams(withoutLinkParams(params), { replace: true });
  }, [load.state, params, setParams]);

  const preparing = load.state === "on" && load.exports.some((item) => item.status === "queued" || item.status === "running");
  useEffect(() => {
    if (!preparing) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") void reload();
    }, DATA_EXPORT_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reload();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [preparing, reload]);
  return { load, reload };
}

/**
 * The emailed link's export (call it where the list shows): marked once (and
 * brought into view), its parameters taken off the address.
 */
export function useLinkedDataExport(): string | null {
  const [params, setParams] = useSearchParams();
  const [linked, setLinked] = useState<string | null>(null);
  useEffect(() => {
    if (!params.has(DATA_EXPORT_LINK_PARAM)) return;
    const id = dataExportIdOf(params.get(DATA_EXPORT_LINK_PARAM));
    setLinked(id);
    if (id) document.getElementById(`data-export-${id}`)?.scrollIntoView?.({ block: "center" });
    setParams(withoutLinkParams(params), { replace: true });
  }, [params, setParams]);
  return linked;
}

function withoutLinkParams(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(DATA_EXPORT_LINK_PARAM);
  next.delete(DATA_EXPORT_SERVER_LINK_PARAM);
  return next;
}

export function useDay(): (iso: string | null | undefined) => string {
  const { options } = useTimeFormatter();
  return useCallback((iso) => {
    const date = iso ? new Date(iso) : null;
    if (!date || Number.isNaN(date.getTime())) return "";
    return cachedDateTimeFormat(options.locale, { month: "long", day: "numeric", timeZone: options.timeZone || undefined }).format(date);
  }, [options.locale, options.timeZone]);
}

/** The current time, moved on every minute (the cooldown ends while the page is open). */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), NOW_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * When the person (or server) may ask again: the server's `nextAllowedAt`
 * (it counts the exports the list leaves out: a deleted one still counts), or null.
 */
export function cooldownUntil(nextAllowedAt: string | null, now: number): Date | null {
  const until = nextAllowedAt ? new Date(nextAllowedAt) : null;
  return until && until.getTime() > now ? until : null;
}

/**
 * Whether this person may export this server (an owner, data export on for
 * them and the server): its list answers and says `available`. False until
 * read, and when it can't be read.
 */
export function useServerDataExportOffered(server: { id: string; slug: string } | null): boolean {
  const serverId = server?.id ?? null;
  const serverSlug = server?.slug ?? null;
  const [read, setRead] = useState<{ serverId: string; offered: boolean } | null>(null);
  useEffect(() => {
    if (!serverId || !serverSlug) return;
    let cancelled = false;
    listDataExports(serverDataExports({ id: serverId, slug: serverSlug })).then((listed) => {
      if (!cancelled) setRead({ serverId, offered: listed?.available === true });
    }, () => undefined);
    return () => {
      cancelled = true;
    };
  }, [serverId, serverSlug]);
  return read !== null && read.serverId === serverId && read.offered;
}
