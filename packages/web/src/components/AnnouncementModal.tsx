import { useEffect, useLayoutEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { InlineCode, toast } from "raft-ui";
import type { Announcement } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import Modal from "./Modal";
import { useAnnouncementStore } from "../store/announcementStore";
import { shouldAutoDismissSlockdevAnnouncement } from "../utils/devMode";

/**
 * ============================================================================
 * Account-level announcement modal — contract
 * ============================================================================
 *
 * 1. WHEN THE MODAL APPEARS
 *    - On every page load, after login, and on foreground recovery the client calls
 *      `GET /api/announcements/active`. The server returns the OLDEST row the
 *      user has not finished reading, inside the visibility window.
 *    - The store puts that row at `pending[0]`. The modal renders iff
 *      `pending[0]` exists AND `pending[0].pages.length > 0`.
 *    - An announcement with `pages: []` is the "clear" signal — server still
 *      returns it, but the modal renders nothing for it.
 *    - ⚠️ "Older rows are never resurfaced once a newer row exists" WAS an
 *      invariant here and is now DELIBERATELY ABOLISHED — oldest-unread-first
 *      is the product decision (Cindy, 2026-08-07), not a regression. Do not
 *      "fix" a resurfacing old announcement back to newest-only.
 *
 * 2. WHAT COUNTS AS READ-COMPLETE (server write)
 *    Read-complete is EXPLICIT confirmation on the last page (OK or Enter).
 *    Rendering a single-page announcement and navigating onto the last page are
 *    read-only. This keeps one tab from persisting account-level dismissal just
 *    because it rendered while another tab is still presenting the row.
 *
 * 3. WHAT CLOSES THE MODAL (local visibility only)
 *    OK and Enter-on-last-page call `dismiss` (persist + local close). ✕ and
 *    background overlay call `close` (local visibility only).
 *    Pressing Enter on a non-last page advances to Next instead. IME
 *    composition (`isComposing`) suppresses Enter so CJK input methods don't
 *    accidentally fire it.
 *    Closing with ✕ or overlay never creates a read-complete write, so the row
 *    returns on the next entry/focus load.
 *
 * 4. AFTER READ-COMPLETE
 *    - Persisted as a `(userId, announcementId)` row; account-level, so the
 *      user will not see it again on any future load, login, or device.
 *    - Scoped per-user: one user finishing does not affect any other user.
 *    ⚠️ If the explicit confirmation write FAILS, the id is held in
 *      `writeFailedIds` (memory only)
 *      so the oldest-first queue keeps advancing this session — option B
 *      (Cindy, 2026-08-09). The server has no record, so a reload brings it
 *      back. The failure raises a toast; it must never be silent, because the
 *      user believes they have read it.
 *
 * 5. NAVIGATION INSIDE THE MODAL
 *    - Multi-page content lives in `current.pages: { title?, body }[]`.
 *    - Back / Next buttons walk between pages without dismissing.
 *    - The Next button becomes the OK button on the last page (the same
 *      button does both jobs, just relabeled).
 *    - Page index resets to 0 whenever `current.id` changes. Automatic loads do
 *      not replace an announcement this tab is already presenting.
 * ============================================================================
 */
export default function AnnouncementModal({ suppressed = false }: { suppressed?: boolean }) {
  const pending = useAnnouncementStore((state) => state.pending);
  const writeFailedIds = useAnnouncementStore((state) => state.writeFailedIds);
  const { formatMessage } = useIntl();
  const notifiedRef = useRef<Set<string>>(new Set());

  // A failed read-complete write is invisible by construction: the modal has
  // already closed and the queue has already advanced past the row, so nothing
  // else in the UI would reveal that it was never recorded. Raised here rather
  // than inside the store so the copy stays translatable. This component is
  // mounted for the whole session (it returns null when idle), so the toast
  // still fires for a row whose modal has gone.
  useEffect(() => {
    for (const id of writeFailedIds) {
      if (notifiedRef.current.has(id)) continue;
      notifiedRef.current.add(id);
      toast.error(formatMessage({ id: "common.announcement.saveFailed" }));
    }
  }, [writeFailedIds, formatMessage]);

  const current = suppressed ? undefined : pending[0];
  if (!current || current.pages.length === 0) return null;
  return <AnnouncementModalContent key={current.id} current={current} />;
}

function AnnouncementModalContent({ current }: { current: Announcement }) {
  const { formatMessage } = useIntl();
  const dismiss = useAnnouncementStore((s) => s.dismiss);
  const close = useAnnouncementStore((s) => s.close);
  const [pageIndex, setPageIndex] = useState(0);
  const pageIndexRef = useRef(0);
  const okButtonRef = useRef<HTMLButtonElement>(null);
  const autoDismissSlockdevAnnouncement = shouldAutoDismissSlockdevAnnouncement(
    import.meta.env?.VITE_DEPLOYMENT_ENV,
  );

  // Modal opens / announcement switches → move focus to the primary action
  // button. Without this, focus stays on whatever was focused behind the modal
  // (e.g. the message composer, which preventDefault()s Enter), so the
  // window-level Enter handler below bails on `e.defaultPrevented` and the modal
  // never advances. Surfaced as the preview-mode e2e flake announcement-modal:103
  // (modal stuck on page 1/3 — dev's slower/StrictMode focus timing masked it).
  // useLayoutEffect so focus lands in the commit phase before paint.
  // oxlint-disable react-hooks/exhaustive-deps -- refocus only on announcement identity change; `current` is pending[0], a fresh ref on every store update, so depending on the whole object would refocus on unrelated announcement-store churn.
  useLayoutEffect(() => {
    if (!current || current.pages.length === 0) return;
    okButtonRef.current?.focus();
  }, [current?.id]);
  // oxlint-enable react-hooks/exhaustive-deps

  // Slockdev should still show the account-level popup briefly, then perform
  // the same dismissal a user would create by clicking OK. Scheduling the
  // dismiss one animation frame later lets reviewers see the popup appear,
  // while keeping the dev flow unblocked.
  // oxlint-disable react-hooks/exhaustive-deps -- keyed on announcement identity (current?.id) + page count; `current` is pending[0], a fresh ref on every store update, so depending on the whole object would reschedule the rAF on unrelated announcement-store churn.
  useEffect(() => {
    if (!autoDismissSlockdevAnnouncement || !current || current.pages.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      void dismiss(current.id);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoDismissSlockdevAnnouncement, current?.id, current?.pages.length, dismiss]);
  // oxlint-enable react-hooks/exhaustive-deps

  // Enter advances Next / confirms OK while the modal is open. Capture phase
  // gives the takeover layer first ownership even if a background composer
  // steals focus and prevents Enter's default action. The ref is updated
  // synchronously so a burst of key events observes each prior transition;
  // waiting for a render/effect rebind would leave the last-page decision on a
  // stale closure.
  // oxlint-disable react-hooks/exhaustive-deps -- rebind only on announcement identity / page count; `current` is pending[0], a fresh ref on every store update, so depending on the whole object would rebind the listener on unrelated announcement-store churn.
  useEffect(() => {
    if (!current || current.pages.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.defaultPrevented) return;
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      if (pageIndexRef.current === current.pages.length - 1) {
        void dismiss(current.id);
      } else {
        const nextPageIndex = Math.min(pageIndexRef.current + 1, current.pages.length - 1);
        pageIndexRef.current = nextPageIndex;
        setPageIndex(nextPageIndex);
      }
    };
    // keydown-focus-on-open
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [current?.id, current?.pages.length, dismiss]);
  // oxlint-enable react-hooks/exhaustive-deps

  const totalPages = current.pages.length;
  const page = current.pages[pageIndex];
  const isLast = pageIndex === totalPages - 1;

  const handleNext = () => {
    if (pageIndexRef.current === totalPages - 1) {
      void dismiss(current.id);
    } else {
      const nextPageIndex = Math.min(pageIndexRef.current + 1, totalPages - 1);
      pageIndexRef.current = nextPageIndex;
      setPageIndex(nextPageIndex);
    }
  };

  const handleBack = () => {
    const nextPageIndex = Math.max(pageIndexRef.current - 1, 0);
    pageIndexRef.current = nextPageIndex;
    setPageIndex(nextPageIndex);
  };

  return (
    <Modal onClose={() => close(current.id)} layer={1} closeOnBackdrop>
      <div className="card-brutal w-full max-w-xl flex flex-col" data-testid="announcement-modal" role="dialog" aria-modal="true" aria-label={current.title}>
        <div className="flex items-center justify-between border-b-2 border-black px-5 py-3 bg-soft-signal">
          <h2 className="text-lg font-bold uppercase truncate" data-testid="announcement-title">
            {current.title}
          </h2>
          <button
            type="button"
            onClick={() => close(current.id)}
            className="btn-brutal-sm bg-white p-1"
            aria-label={formatMessage({ id: "common.announcement.dismiss" })}
          >
            <X size={20} />
          </button>
        </div>

        <div
          className="max-h-[60vh] overflow-y-auto px-6 py-5 text-sm leading-relaxed"
          data-testid="announcement-page-body"
        >
          {page.title && <h3 className="mt-0 mb-3 text-base font-bold uppercase">{page.title}</h3>}
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
              ul: ({ children }) => <ul className="mb-2 pl-5 list-disc">{children}</ul>,
              ol: ({ children }) => <ol className="mb-2 pl-5 list-decimal">{children}</ol>,
              li: ({ children }) => <li className="mb-0.5">{children}</li>,
              a: ({ children, href }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" className="underline font-medium">
                  {children}
                </a>
              ),
              code: ({ children }) => (
                <InlineCode className="rounded-sm bg-white px-1 text-[0.85em]">
                  {children}
                </InlineCode>
              ),
              h1: ({ children }) => <h1 className="text-base font-bold uppercase mt-3 mb-2">{children}</h1>,
              h2: ({ children }) => <h2 className="text-base font-bold uppercase mt-3 mb-2">{children}</h2>,
              h3: ({ children }) => <h3 className="text-sm font-bold uppercase mt-3 mb-2">{children}</h3>,
            }}
          >
            {page.body}
          </ReactMarkdown>
        </div>

        <div className="flex items-center justify-between gap-3 border-t-2 border-black px-5 py-3 bg-white">
          <div>
            {totalPages > 1 && (
              <span className="font-mono text-xs text-black/60" data-testid="announcement-page-indicator">
                {pageIndex + 1} / {totalPages}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {totalPages > 1 && pageIndex > 0 && (
              <button
                type="button"
                onClick={handleBack}
                className="btn-brutal bg-white px-4 py-2 text-sm inline-flex items-center gap-1"
                data-testid="announcement-back"
              >
                <ChevronLeft size={14} />
                {formatMessage({ id: "common.announcement.back" })}
              </button>
            )}
            <button
              ref={okButtonRef}
              type="button"
              onClick={handleNext}
              className="btn-brutal bg-brutal-pink px-4 py-2 text-sm font-bold inline-flex items-center gap-1"
              data-testid={isLast ? "announcement-ok" : "announcement-next"}
            >
              {isLast
                ? formatMessage({ id: "common.announcement.ok" })
                : (
                  <>
                    {formatMessage({ id: "common.announcement.next" })}
                    <ChevronRight size={14} />
                  </>
                )}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
