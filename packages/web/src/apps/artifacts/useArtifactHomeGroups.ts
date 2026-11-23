import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { ArtifactCard, ArtifactId, ArtifactSettled, ArtifactWebDashboardAll } from "@botiverse/raft-shared";

import { showToast } from "../../components/toastBridge";
import { artifactErrorCode } from "./artifactApi";
import type { ArtifactDashboardItem } from "./artifactDashboardItems";
import { onOwnSettle, reportOwnSettle } from "./artifactOwnSettles";
import { decideHomeGroups, groupArtifactItems, settleRefusal, settledShown, withOwnSettles } from "./artifactSettled";
import type { ArtifactHomeDecision, ArtifactHomeGroups, ArtifactHomeSettle } from "./artifactSettled";
import { artifactSource } from "./artifactSource";

/** The reader's own answers, on the page of rows they were answered on: a new page is the server's word again. */
interface OwnAnswers {
  page: ArtifactWebDashboardAll | null;
  settled: ReadonlyMap<string, ArtifactSettled | null>;
}

/** The reader's own acts on this server's rows, by Artifact: the latest act's sequence number (decideHomeGroups' `acts`). */
interface OwnActs {
  serverId: string | null;
  acts: ReadonlyMap<string, number>;
}

const NO_ACTS: ReadonlyMap<string, number> = new Map();
const NO_DECISIONS: ReadonlyMap<string, ArtifactHomeDecision> = new Map();

export interface ArtifactHomeSettled {
  /** The rows as drawn: with the reader's own settles and unsettles on them until the list is read again. */
  items: ArtifactDashboardItem[];
  /** Working and Other (#334); null where the rows say nothing of Settled (the flag off): one list, as before. */
  groups: ArtifactHomeGroups | null;
  /** Settle or unsettle one from its menu (ArtifactHomeMenu), and which are being asked. */
  settle: ArtifactHomeSettle;
}

/**
 * The home page's Working and Other (#334). Nothing moves while the page is open: each row's group is decided when
 * the page first lists it, and kept while the page stays mounted, through every read again (closing the viewer, new
 * activity, another filter or sort, "Show more"), so opening one, which clears what was new on it, doesn't send it
 * to the fold under the reader's eyes (decideHomeGroups). Two exceptions:
 * - the tab's cached page (the previous visit's rows, shown at once on mount) decides only until the page's own first
 *   read answers (`fresh`), which decides those rows again;
 * - the reader's own settle or unsettle moves its row at once, from the row's menu here or from the viewer
 *   (reportOwnSettle): its answer goes on the row and its group is decided again with it. From the menu the list is
 *   also read again behind it (not past the first page: that would drop what "Show more" added).
 * The next visit decides afresh; so does another server's list.
 */
export function useArtifactHomeGroups({ items, page, fresh, serverId, searching, extended, read }: {
  items: ArtifactDashboardItem[];
  /** The rows' page: the reader's own answers are on it until another replaces it. */
  page: ArtifactWebDashboardAll | null;
  /** The rows come from a read of this page's own, not the tab's cache. */
  fresh: boolean;
  serverId: string | null;
  /** A title search: no groups, Working first. */
  searching: boolean;
  /** "Show more" added to the rows: no read again after a settle. */
  extended: boolean;
  read: (keepRows: boolean) => Promise<void>;
}): ArtifactHomeSettled {
  const { formatMessage } = useIntl();
  const [answers, setAnswers] = useState<OwnAnswers>({ page: null, settled: new Map() });
  const [ownActs, setOwnActs] = useState<OwnActs>({ serverId, acts: NO_ACTS });
  // The reader's own answers, wherever they were made (the menu here, the viewer over the page).
  useEffect(() => onOwnSettle(({ id, settled, seq }) => {
    setAnswers((current) => ({ page, settled: new Map(current.page === page ? current.settled : []).set(id, settled) }));
    setOwnActs((current) => ({ serverId, acts: new Map(current.serverId === serverId ? current.acts : []).set(id, seq) }));
  }), [page, serverId]);
  const shown = useMemo(() => (answers.page === page ? withOwnSettles(items, answers.settled) : items), [items, answers, page]);
  const enabled = shown.some((item) => settledShown(item.card));
  const acts = ownActs.serverId === serverId ? ownActs.acts : NO_ACTS;
  // "Updated in the last 7 days" counts from when the page opened: it decides then, and nothing moves after.
  const [openedAt] = useState(() => Date.now());
  // Each row's group as decided so far, for the page's server: what decideHomeGroups adds is kept as it renders (it
  // returns the same map when nothing is new, so this settles at once).
  const [decided, setDecided] = useState<{ serverId: string | null; groups: ReadonlyMap<string, ArtifactHomeDecision> }>({ serverId, groups: NO_DECISIONS });
  const kept = decided.serverId === serverId ? decided.groups : NO_DECISIONS;
  const next = enabled ? decideHomeGroups(kept, shown, { now: openedAt, fresh, acts }) : kept;
  if (next !== decided.groups || decided.serverId !== serverId) setDecided({ serverId, groups: next });
  const groups = useMemo(
    () => (enabled ? groupArtifactItems(shown, (item) => next.get(item.card.id)?.working ?? true, searching) : null),
    [enabled, shown, next, searching],
  );

  // One settle or unsettle at a time per Artifact: a second press waits for the first's answer.
  const asking = useRef(new Set<ArtifactId>());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const setSettled = useCallback(async (card: ArtifactCard, settled: boolean) => {
    const source = artifactSource();
    if (!source.setSettled || asking.current.has(card.id)) return;
    asking.current.add(card.id);
    setPending(new Set(asking.current));
    try {
      const answer = await source.setSettled(card.id, settled);
      reportOwnSettle(card.id, answer.settled);
      if (!extended) void read(true);
    } catch (error: unknown) {
      showToast({ title: formatMessage({ id: settleRefusal(artifactErrorCode(error)) }), type: "error" });
    } finally {
      asking.current.delete(card.id);
      setPending(new Set(asking.current));
    }
  }, [extended, read, formatMessage]);
  const settle = useMemo(() => ({ setSettled, pending }), [setSettled, pending]);

  return { items: shown, groups, settle };
}
