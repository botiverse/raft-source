import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  FilePlus2,
  Loader2,
  Megaphone,
  Plus,
  Save,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { announcementCatalog, type AnnouncementUiLocale } from "./announcementCatalog";

type AnnouncementLocale = "en" | "zh-cn";
type AnnouncementPage = { title?: string; body: string };
type AnnouncementContent = { title: string; pages: AnnouncementPage[] };
type AnnouncementContentByLocale = Partial<Record<AnnouncementLocale, AnnouncementContent>>;
type EffectiveStatus = "draft" | "scheduled" | "published" | "expired";

type AdminAnnouncement = {
  id: string;
  defaultLocale: AnnouncementLocale;
  content: AnnouncementContentByLocale;
  status: "draft" | "published" | "expired";
  effectiveStatus: EffectiveStatus;
  startsAt: string | null;
  endsAt: string | null;
  publishedAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string | null;
  updatedByUserId: string | null;
  publishedByUserId: string | null;
};

type AuditEvent = {
  id: string;
  actorUserId: string | null;
  action:
    | "created"
    | "updated"
    | "published"
    | "scheduled"
    | "schedule_updated"
    | "schedule_cancelled"
    | "activated"
    | "expired";
  createdAt: string;
};

type EditorDraft = {
  id: string | null;
  defaultLocale: AnnouncementLocale;
  content: AnnouncementContentByLocale;
  startsAt: string;
  endsAt: string;
  status: EffectiveStatus;
};

const LOCALES: Array<{ value: AnnouncementLocale; label: string }> = [
  { value: "en", label: "English" },
  { value: "zh-cn", label: "简体中文" },
];

function emptyContent(pageCount = 1): AnnouncementContent {
  return {
    title: "",
    pages: Array.from({ length: pageCount }, () => ({ title: "", body: "" })),
  };
}

function emptyDraft(): EditorDraft {
  return {
    id: null,
    defaultLocale: "en",
    content: { en: emptyContent() },
    startsAt: "",
    endsAt: "",
    status: "draft",
  };
}

function toLocalDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function toIso(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function editorFromAnnouncement(announcement: AdminAnnouncement): EditorDraft {
  return {
    id: announcement.id,
    defaultLocale: announcement.defaultLocale,
    content: structuredClone(announcement.content),
    startsAt: toLocalDateTime(announcement.startsAt),
    endsAt: toLocalDateTime(announcement.endsAt),
    status: announcement.effectiveStatus,
  };
}

function formatWhen(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function statusTone(status: EffectiveStatus): string {
  if (status === "published") return "bg-brutal-lime";
  if (status === "scheduled") return "bg-brutal-yellow";
  if (status === "expired") return "bg-black text-white";
  return "bg-white";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as {
    error?: string | { message?: string };
  };
  if (!response.ok) {
    const message = typeof body.error === "string"
      ? body.error
      : body.error?.message ?? `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function createLatestAuditLoader(
  fetchAudit: (id: string) => Promise<AuditEvent[]>,
  applyAudit: (events: AuditEvent[]) => void,
) {
  let generation = 0;

  return {
    async load(id: string | null) {
      const requestGeneration = ++generation;
      if (!id) {
        applyAudit([]);
        return;
      }
      try {
        const events = await fetchAudit(id);
        if (requestGeneration === generation) applyAudit(events);
      } catch {
        if (requestGeneration === generation) applyAudit([]);
      }
    },
    invalidate() {
      generation += 1;
    },
  };
}

function samePageCount(content: AnnouncementContentByLocale): number {
  return Object.values(content)[0]?.pages.length ?? 1;
}

type AnnouncementCopy = (typeof announcementCatalog)[AnnouncementUiLocale];

function validateDraft(draft: EditorDraft, copy: AnnouncementCopy): string | null {
  const selected = Object.entries(draft.content) as Array<[AnnouncementLocale, AnnouncementContent]>;
  if (!draft.content[draft.defaultLocale]) return copy.invalidDefault;
  if (selected.length === 0) return copy.invalidLocales;
  const pageCount = selected[0]?.[1].pages.length ?? 0;
  if (pageCount < 1 || pageCount > 20) return copy.invalidPageCount;
  for (const [locale, content] of selected) {
    if (!content.title.trim()) return copy.invalidTitle(locale);
    if (content.pages.length !== pageCount) return copy.invalidPageShape;
    for (const [index, page] of content.pages.entries()) {
      if (!page.body.trim()) return copy.invalidBody(locale, index + 1);
    }
  }
  const startsAt = draft.startsAt ? new Date(draft.startsAt) : null;
  const endsAt = draft.endsAt ? new Date(draft.endsAt) : null;
  if (startsAt && Number.isNaN(startsAt.getTime())) return copy.invalidStart;
  if (endsAt && Number.isNaN(endsAt.getTime())) return copy.invalidEnd;
  if (startsAt && endsAt && endsAt <= startsAt) return copy.invalidWindow;
  return null;
}

function Preview({
  content,
  pageIndex,
  onPageIndex,
  copy,
}: {
  content: AnnouncementContent;
  pageIndex: number;
  onPageIndex: (index: number) => void;
  copy: AnnouncementCopy;
}) {
  const page = content.pages[pageIndex] ?? content.pages[0] ?? { body: "" };
  const last = pageIndex >= content.pages.length - 1;
  return (
    <div className="border-2 border-black bg-white shadow-brutal" data-testid="announcement-live-preview">
      <div className="border-b-2 border-black bg-brutal-yellow px-5 py-3">
        <div className="text-lg font-black uppercase">{content.title || copy.announcementTitlePlaceholder}</div>
      </div>
      <div className="min-h-56 max-h-[420px] overflow-y-auto px-6 py-5 text-sm leading-relaxed">
        {page.title ? <h3 className="mb-3 text-base font-bold uppercase">{page.title}</h3> : null}
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
            ul: ({ children }) => <ul className="mb-2 list-disc pl-5">{children}</ul>,
            ol: ({ children }) => <ol className="mb-2 list-decimal pl-5">{children}</ol>,
            li: ({ children }) => <li className="mb-0.5">{children}</li>,
            a: ({ children, href }) => (
              <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium underline">
                {children}
              </a>
            ),
            code: ({ children }) => <code className="rounded-sm bg-brutal-cream px-1 text-[0.85em]">{children}</code>,
            h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-bold uppercase">{children}</h1>,
            h2: ({ children }) => <h2 className="mb-2 mt-3 text-base font-bold uppercase">{children}</h2>,
            h3: ({ children }) => <h3 className="mb-2 mt-3 text-sm font-bold uppercase">{children}</h3>,
          }}
        >
          {page.body || copy.previewPlaceholder}
        </ReactMarkdown>
      </div>
      <div className="flex items-center justify-between border-t-2 border-black px-5 py-3">
        <span className="font-mono text-xs font-bold text-black/55">
          {content.pages.length ? `${pageIndex + 1} / ${content.pages.length}` : "0 / 0"}
        </span>
        <div className="flex gap-2">
          {pageIndex > 0 ? (
            <button className="btn-brutal-sm bg-white px-3 py-2 text-xs" onClick={() => onPageIndex(pageIndex - 1)}>
              <ChevronLeft size={14} /> {copy.back}
            </button>
          ) : null}
          <button
            className="btn-brutal-sm bg-brutal-pink px-3 py-2 text-xs"
            onClick={() => onPageIndex(last ? 0 : pageIndex + 1)}
          >
            {last ? copy.ok : copy.next} {!last ? <ChevronRight size={14} /> : null}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AnnouncementsSurface() {
  const [uiLocale, setUiLocale] = useState<AnnouncementUiLocale>(() => (
    typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")
      ? "zh-cn"
      : "en"
  ));
  const [announcements, setAnnouncements] = useState<AdminAnnouncement[]>([]);
  const [draft, setDraft] = useState<EditorDraft>(emptyDraft);
  const [activeLocale, setActiveLocale] = useState<AnnouncementLocale>("en");
  const [previewPage, setPreviewPage] = useState(0);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [auditLoader] = useState(() => createLatestAuditLoader(
    async (id) => {
      const body = await api<{ events: AuditEvent[] }>(
        `/api/operator/announcements/${encodeURIComponent(id)}/audit`,
      );
      return body.events;
    },
    setAudit,
  ));
  const copy = announcementCatalog[uiLocale];

  const readonly = draft.status !== "draft" && draft.status !== "scheduled";
  const selectedContent = draft.content[activeLocale]
    ?? draft.content[draft.defaultLocale]
    ?? emptyContent();
  const validationError = useMemo(() => validateDraft(draft, copy), [copy, draft]);

  async function loadAnnouncements(preferredId?: string | null) {
    setLoading(true);
    try {
      const body = await api<{ announcements: AdminAnnouncement[] }>("/api/operator/announcements");
      setAnnouncements(body.announcements);
      const nextId = preferredId ?? draft.id ?? body.announcements[0]?.id ?? null;
      const selected = body.announcements.find((item) => item.id === nextId);
      if (selected) {
        setDraft(editorFromAnnouncement(selected));
        setActiveLocale(selected.defaultLocale);
        setPreviewPage(0);
      }
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : copy.loadFailed });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadAnnouncements();
  }, []);

  useEffect(() => {
    void auditLoader.load(draft.id);
    return auditLoader.invalidate;
  }, [auditLoader, draft.id]);

  function selectAnnouncement(announcement: AdminAnnouncement) {
    setDraft(editorFromAnnouncement(announcement));
    setActiveLocale(announcement.defaultLocale);
    setPreviewPage(0);
    setMessage(null);
  }

  function startNew() {
    setDraft(emptyDraft());
    setActiveLocale("en");
    setPreviewPage(0);
    setAudit([]);
    setMessage(null);
  }

  function setLocaleEnabled(locale: AnnouncementLocale, enabled: boolean) {
    if (readonly) return;
    setDraft((current) => {
      const content = { ...current.content };
      if (enabled) {
        content[locale] ??= emptyContent(samePageCount(content));
      } else {
        if (Object.keys(content).length === 1) return current;
        delete content[locale];
      }
      const defaultLocale = content[current.defaultLocale]
        ? current.defaultLocale
        : (Object.keys(content)[0] as AnnouncementLocale);
      return { ...current, content, defaultLocale };
    });
    if (enabled) setActiveLocale(locale);
  }

  function updateLocaleContent(
    locale: AnnouncementLocale,
    update: (content: AnnouncementContent) => AnnouncementContent,
  ) {
    if (readonly) return;
    setDraft((current) => ({
      ...current,
      content: {
        ...current.content,
        [locale]: update(current.content[locale] ?? emptyContent(samePageCount(current.content))),
      },
    }));
  }

  function addPage() {
    if (readonly || samePageCount(draft.content) >= 20) return;
    setDraft((current) => ({
      ...current,
      content: Object.fromEntries(
        Object.entries(current.content).map(([locale, content]) => [
          locale,
          { ...content, pages: [...content.pages, { title: "", body: "" }] },
        ]),
      ) as AnnouncementContentByLocale,
    }));
  }

  function removePage(index: number) {
    if (readonly || samePageCount(draft.content) <= 1) return;
    setDraft((current) => ({
      ...current,
      content: Object.fromEntries(
        Object.entries(current.content).map(([locale, content]) => [
          locale,
          { ...content, pages: content.pages.filter((_, pageIndex) => pageIndex !== index) },
        ]),
      ) as AnnouncementContentByLocale,
    }));
    setPreviewPage((current) => Math.max(0, Math.min(current, samePageCount(draft.content) - 2)));
  }

  async function saveDraft() {
    const error = validateDraft(draft, copy);
    if (error) {
      setMessage({ tone: "error", text: error });
      return;
    }
    setBusy("save");
    setMessage(null);
    try {
      const payload = {
        defaultLocale: draft.defaultLocale,
        content: draft.content,
        startsAt: toIso(draft.startsAt),
        endsAt: toIso(draft.endsAt),
      };
      const path = draft.id
        ? `/api/operator/announcements/${encodeURIComponent(draft.id)}`
        : "/api/operator/announcements";
      const body = await api<{ announcement: AdminAnnouncement }>(path, {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setMessage({
        tone: "ok",
        text: draft.status === "scheduled"
          ? copy.scheduleUpdated
          : draft.id
            ? copy.draftSaved
            : copy.draftCreated,
      });
      await loadAnnouncements(body.announcement.id);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : copy.saveFailed });
    } finally {
      setBusy(null);
    }
  }

  async function lifecycle(action: "publish" | "expire" | "cancel") {
    if (!draft.id) return;
    const prompt = action === "publish"
      ? copy.confirmPublish
      : action === "cancel"
        ? copy.confirmCancel
        : copy.confirmExpire;
    if (!window.confirm(prompt)) return;
    setBusy(action);
    setMessage(null);
    try {
      const body = await api<{ announcement: AdminAnnouncement }>(
        `/api/operator/announcements/${encodeURIComponent(draft.id)}/${action}`,
        { method: "POST" },
      );
      setMessage({
        tone: "ok",
        text: action === "publish"
          ? copy.publishSucceeded
          : action === "cancel"
            ? copy.cancelSucceeded
            : copy.expireSucceeded,
      });
      await loadAnnouncements(body.announcement.id);
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : copy.actionFailed(action) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto grid max-w-[1440px] gap-5 px-4 py-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      <aside className="self-start border-2 border-black bg-white shadow-brutal">
        <div className="flex items-center justify-between border-b-2 border-black bg-brutal-yellow px-4 py-3">
          <h2 className="text-sm font-black uppercase">{copy.announcements}</h2>
          <button className="btn-brutal-sm bg-white p-2" onClick={startNew} title={copy.newDraft}>
            <FilePlus2 size={15} />
          </button>
        </div>
        <div className="max-h-[calc(100vh-180px)] divide-y-2 divide-black overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 px-4 py-5 text-sm font-bold"><Loader2 className="animate-spin" size={16} /> {copy.loading}</div>
          ) : announcements.length ? announcements.map((announcement) => {
            const content = announcement.content[announcement.defaultLocale];
            return (
              <button
                key={announcement.id}
                className={`grid w-full gap-2 px-4 py-4 text-left ${draft.id === announcement.id ? "bg-brutal-lavender" : "bg-white"}`}
                onClick={() => selectAnnouncement(announcement)}
              >
                <div className="line-clamp-2 text-sm font-black">{content?.title ?? copy.untitled}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`border-2 border-black px-2 py-0.5 text-[10px] font-black uppercase ${statusTone(announcement.effectiveStatus)}`}>
                    {copy.status[announcement.effectiveStatus]}
                  </span>
                  <span className="font-mono text-[10px] text-black/45">{Object.keys(announcement.content).join(" · ")}</span>
                </div>
                <div className="font-mono text-[10px] text-black/45">{formatWhen(announcement.startsAt)}</div>
              </button>
            );
          }) : <div className="px-4 py-6 text-sm font-bold text-black/50">{copy.noAnnouncements}</div>}
        </div>
      </aside>

      <section className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-xl font-black">
              <Megaphone size={22} /> {draft.id ? copy.announcementDetail : copy.newAnnouncement}
            </div>
            <p className="mt-1 text-xs font-semibold text-black/55">
              {copy.authorityNote}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-2 border-2 border-black bg-white px-2 py-1 text-xs font-black shadow-brutal-sm">
              {copy.language}
              <select
                className="bg-transparent font-black"
                value={uiLocale}
                onChange={(event) => setUiLocale(event.target.value as AnnouncementUiLocale)}
              >
                <option value="en">English</option>
                <option value="zh-cn">简体中文</option>
              </select>
            </label>
            {draft.status === "draft" || draft.status === "scheduled" ? (
              <>
                <button
                  className="btn-brutal-sm bg-white px-3 py-2 text-xs"
                  onClick={saveDraft}
                  disabled={busy !== null || !!validationError}
                  title={validationError ?? undefined}
                >
                  {busy === "save" ? <Loader2 className="animate-spin" size={15} /> : <Save size={15} />}
                  {draft.status === "scheduled" ? copy.updateSchedule : draft.id ? copy.saveDraft : copy.createDraft}
                </button>
                {draft.id && draft.status === "draft" ? (
                  <button
                    className="btn-brutal-sm bg-brutal-lime px-3 py-2 text-xs"
                    onClick={() => void lifecycle("publish")}
                    disabled={busy !== null || !!validationError}
                  >
                    <Megaphone size={15} /> {copy.publish}
                  </button>
                ) : null}
                {draft.id && draft.status === "scheduled" ? (
                  <button
                    className="btn-brutal-sm bg-brutal-red px-3 py-2 text-xs"
                    onClick={() => void lifecycle("cancel")}
                    disabled={busy !== null}
                  >
                    <Archive size={15} /> {copy.cancelSchedule}
                  </button>
                ) : null}
              </>
            ) : draft.status === "published" ? (
              <button
                className="btn-brutal-sm bg-brutal-red px-3 py-2 text-xs"
                onClick={() => void lifecycle("expire")}
                disabled={busy !== null}
              >
                <Archive size={15} /> {copy.expireNow}
              </button>
            ) : null}
          </div>
        </div>

        {message ? (
          <div className={`border-2 border-black px-4 py-3 text-sm font-bold shadow-brutal-sm ${message.tone === "ok" ? "bg-brutal-lime" : "bg-brutal-red"}`}>
            {message.text}
          </div>
        ) : null}

        <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.8fr)]">
          <div className="space-y-5">
            <div className="border-2 border-black bg-white p-4 shadow-brutal">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-black uppercase">{copy.locales}</h3>
                  <p className="text-xs font-semibold text-black/50">{copy.localeHelp}</p>
                </div>
                <label className="flex items-center gap-2 text-xs font-bold">
                  {copy.defaultLocale}
                  <select
                    className="control min-w-32"
                    value={draft.defaultLocale}
                    disabled={readonly}
                    onChange={(event) => {
                      const locale = event.target.value as AnnouncementLocale;
                      setDraft((current) => ({ ...current, defaultLocale: locale }));
                      setActiveLocale(locale);
                    }}
                  >
                    {LOCALES.filter(({ value }) => draft.content[value]).map(({ value, label }) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                {LOCALES.map(({ value, label }) => {
                  const enabled = !!draft.content[value];
                  return (
                    <label
                      key={value}
                      className={`flex cursor-pointer items-center gap-2 border-2 border-black px-3 py-2 text-xs font-black ${activeLocale === value ? "bg-brutal-lavender" : "bg-white"}`}
                    >
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={readonly || (enabled && Object.keys(draft.content).length === 1)}
                        onChange={(event) => setLocaleEnabled(value, event.target.checked)}
                      />
                      <button
                        type="button"
                        className="font-black"
                        disabled={!enabled}
                        onClick={(event) => {
                          event.preventDefault();
                          if (enabled) {
                            setActiveLocale(value);
                            setPreviewPage(0);
                          }
                        }}
                      >
                        {label}
                      </button>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="border-2 border-black bg-white p-4 shadow-brutal">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-black uppercase">{copy.content(activeLocale)}</h3>
                  <p className="text-xs font-semibold text-black/50">{copy.markdownHelp}</p>
                </div>
                <button className="btn-brutal-sm bg-white px-3 py-2 text-xs" onClick={addPage} disabled={readonly || selectedContent.pages.length >= 20}>
                  <Plus size={14} /> {copy.addPage}
                </button>
              </div>
              <label className="grid gap-1 text-xs font-black uppercase">
                {copy.announcementTitle}
                <input
                  className="control"
                  value={selectedContent.title}
                  disabled={readonly}
                  maxLength={200}
                  onChange={(event) => updateLocaleContent(activeLocale, (content) => ({ ...content, title: event.target.value }))}
                />
              </label>
              <div className="mt-4 space-y-4">
                {selectedContent.pages.map((page, index) => (
                  <div key={index} className="border-2 border-black bg-brutal-cream p-3">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-xs font-black uppercase">{copy.page(index + 1)}</span>
                      <button
                        className="btn-brutal-sm bg-white p-1.5"
                        disabled={readonly || selectedContent.pages.length === 1}
                        onClick={() => removePage(index)}
                        title={copy.removePage}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <input
                      className="control mb-2"
                      placeholder={copy.optionalPageTitle}
                      value={page.title ?? ""}
                      disabled={readonly}
                      maxLength={200}
                      onFocus={() => setPreviewPage(index)}
                      onChange={(event) => updateLocaleContent(activeLocale, (content) => ({
                        ...content,
                        pages: content.pages.map((item, pageIndex) => pageIndex === index
                          ? { ...item, title: event.target.value }
                          : item),
                      }))}
                    />
                    <textarea
                      className="control min-h-40 resize-y font-mono text-xs"
                      placeholder={copy.markdownBody}
                      value={page.body}
                      disabled={readonly}
                      maxLength={20_000}
                      onFocus={() => setPreviewPage(index)}
                      onChange={(event) => updateLocaleContent(activeLocale, (content) => ({
                        ...content,
                        pages: content.pages.map((item, pageIndex) => pageIndex === index
                          ? { ...item, body: event.target.value }
                          : item),
                      }))}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="border-2 border-black bg-white p-4 shadow-brutal">
              <div className="mb-3 flex items-center gap-2"><Clock size={17} /><h3 className="text-sm font-black uppercase">{copy.visibilityWindow}</h3></div>
              <div className="grid gap-3 md:grid-cols-2">
                <label className="grid gap-1 text-xs font-black uppercase">
                  {copy.startTime}
                  <input
                    type="datetime-local"
                    className="control"
                    value={draft.startsAt}
                    disabled={readonly}
                    onChange={(event) => setDraft((current) => ({ ...current, startsAt: event.target.value }))}
                  />
                </label>
                <label className="grid gap-1 text-xs font-black uppercase">
                  {copy.endTime}
                  <input
                    type="datetime-local"
                    className="control"
                    value={draft.endsAt}
                    disabled={readonly}
                    onChange={(event) => setDraft((current) => ({ ...current, endsAt: event.target.value }))}
                  />
                </label>
              </div>
              <p className="mt-3 text-xs font-semibold text-black/50">
                {copy.windowHelp}
              </p>
            </div>
          </div>

          <div className="space-y-5 self-start 2xl:sticky 2xl:top-5">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs font-black uppercase"><Eye size={15} /> {copy.livePreview(activeLocale)}</div>
              <Preview content={selectedContent} pageIndex={Math.min(previewPage, selectedContent.pages.length - 1)} onPageIndex={setPreviewPage} copy={copy} />
            </div>
            {draft.id ? (
              <div className="border-2 border-black bg-white p-4 shadow-brutal">
                <h3 className="mb-3 text-sm font-black uppercase">{copy.auditTimeline}</h3>
                <div className="space-y-2">
                  {audit.length ? audit.map((event) => (
                    <div key={event.id} className="border-2 border-black bg-brutal-cream px-3 py-2">
                      <div className="text-xs font-black uppercase">{copy.auditAction[event.action]}</div>
                      <div className="mt-1 font-mono text-[10px] text-black/55">{formatWhen(event.createdAt)}</div>
                      <div className="mt-1 break-all font-mono text-[10px] text-black/45">{event.actorUserId ?? copy.system}</div>
                    </div>
                  )) : <div className="text-xs font-bold text-black/50">{copy.noAudit}</div>}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
