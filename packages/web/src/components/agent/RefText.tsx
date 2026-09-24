import { createContext, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useRefNavigation } from "../../hooks/useRefNavigation";
import { resolveRef } from "../../utils/refTarget";
import type { RefNavContext, RefParts, ResolvedRef } from "../../utils/refTarget";
import {
  CHANNEL_REF_NAME_PATTERN,
  THREAD_SHORT_ID_PATTERN,
  DM_REF_PEER_PATTERN,
} from "../../utils/messageReferencePatterns";
import { MSG_REF_CHIP } from "../message/messageRefChip";
import type { MessageId } from "../../i18n/messages";

// ---------------------------------------------------------------------------
// Activity-local tokenizer.
//
// Per the seam locked with @Bugen (#proj-uiux:2921feaf): the *tokenizer*
// stays here, NOT in the shared util. MessageItem refs are produced by the
// remark/rehype AST and never see a raw string, so a shared string→ReactNode
// tokenizer would be a fake abstraction with one consumer. Only the
// resolve/navigate layer (utils/refTarget.ts) is shared.
//
// Activity Diagnostics text is a raw string, so we scan it with the existing
// ref regexes (longest form first so `#c:shortid` isn't shadowed by `#c`).
// ---------------------------------------------------------------------------

// channel-thread | dm-thread | channel | dm  (alternation order = priority,
// longest form first so `#c:shortid` isn't shadowed by `#c`).
//
// Built from the SAME exported grammar constants the messageReferencePatterns
// factories use — one grammar source feeding both the message-body renderer
// and this activity tokenizer. Do NOT re-spell the char classes here; that
// reintroduces the chat/activity drift this shared seam exists to kill
// (@Bugen review 2026-05-18 #proj-uiux:2921feaf).
const SCAN = new RegExp(
  `#(${CHANNEL_REF_NAME_PATTERN}):(${THREAD_SHORT_ID_PATTERN})` +
    `|dm:@(${DM_REF_PEER_PATTERN}):(${THREAD_SHORT_ID_PATTERN})` +
    `|#(${CHANNEL_REF_NAME_PATTERN})` +
    `|dm:@(${DM_REF_PEER_PATTERN})`,
  "giu",
);

function partsFromMatch(m: RegExpExecArray): RefParts {
  if (m[1] !== undefined) return { channelName: m[1], threadShortId: m[2] };
  if (m[3] !== undefined) return { dmPeer: m[3], threadShortId: m[4] };
  if (m[5] !== undefined) return { channelName: m[5] };
  return { dmPeer: m[6] };
}

/** Surface a thread-unavailable notice up to AgentActivityLog. Default no-op
 *  keeps RefText usable anywhere without a provider. */
const ThreadRefNoticeContext = createContext<(message: MessageId) => void>(() => {});

export function ThreadRefNoticeProvider({
  onNotice,
  children,
}: {
  onNotice: (message: MessageId) => void;
  children: ReactNode;
}) {
  return (
    <ThreadRefNoticeContext.Provider value={onNotice}>{children}</ThreadRefNoticeContext.Provider>
  );
}

function RefToken({ resolved }: { resolved: ResolvedRef }) {
  const [busy, setBusy] = useState(false);
  const isThread = resolved.kind === "channel-thread" || resolved.kind === "dm-thread";

  // Reuse the exact chat ref affordance recipe — no new link visual language.
  // Thread refs = cyan (matches MessageItem thread refs), channel/DM = pink
  // (matches MessageItem #channel refs). Font size is inherited so the chip
  // sits inside the dim `text-xs font-mono` activity row without changing the
  // row rhythm. text-black + border + tint give it enough contrast against
  // the row's black/50 text by construction.
  const tint = isThread
    ? "bg-brutal-cyan/30 hover:bg-brutal-cyan/60"
    : "bg-brutal-pink/30 hover:bg-brutal-pink/60";

  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    if (busy) return;
    const r = resolved.navigate();
    if (r && typeof (r as Promise<void>).then === "function") {
      setBusy(true);
      void (r as Promise<void>).finally(() => setBusy(false));
    }
  };

  return (
    <a
      href="#"
      role="link"
      aria-busy={busy}
      onClick={onClick}
      // In-message refs are the explicit arrow-cursor exception to the app's
      // link-hand control contract. Busy state = dim + non-interactive, no
      // spinner in the mono row (locked with @Bugen).
      className={`${MSG_REF_CHIP} cursor-default text-black ${tint} ${
        busy ? "pointer-events-none opacity-60" : ""
      }`}
    >
      {resolved.label}
    </a>
  );
}

/**
 * Scan a raw activity string and return text interleaved with linkified ref
 * chips. Unresolvable refs (channel/DM not in store, or not a ref) fall back
 * to the verbatim source text — never a dead link.
 */
export function linkifyRefs(text: string, ctx: RefNavContext): ReactNode[] {
  if (!text) return [text];
  const out: ReactNode[] = [];
  const re = new RegExp(SCAN.source, SCAN.flags);
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const resolved = resolveRef(partsFromMatch(m), ctx);
    if (resolved.resolvable) {
      out.push(<RefToken key={`r${key++}`} resolved={resolved} />);
    } else {
      // Verbatim — reads identically to the original source.
      out.push(m[0]);
    }
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++; // guard against zero-width loops
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Drop-in replacement for a plain `{text}` slot in the Activity Diagnostics
 * renderers. Linkifies channel / thread / DM target refs.
 */
export function RefText({ text }: { text: string }) {
  const onNotice = useContext(ThreadRefNoticeContext);
  const ctx = useRefNavigation(onNotice);
  const nodes = useMemo(() => linkifyRefs(text, ctx), [text, ctx]);
  return <>{nodes}</>;
}
