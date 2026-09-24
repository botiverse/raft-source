import { memo, useCallback, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { shouldHighlightCode } from "./codeBlockLanguages";
import type { CodeTokenLine } from "./shikiHighlighter";

export const MAX_SHIKI_HIGHLIGHT_LINES = 500;
export const MAX_SHIKI_HIGHLIGHT_CHARS = 50 * 1024;

type HighlightState =
  | { status: "plain" }
  | { status: "ready"; lines: CodeTokenLine[] };

type HighlightRecord = {
  state: HighlightState;
  listeners: Set<() => void>;
  loading: boolean;
};

type ShikiHighlighterModule = typeof import("./shikiHighlighter");

const PLAIN_HIGHLIGHT: HighlightState = { status: "plain" };
const highlightRecords = new Map<string, HighlightRecord>();
let shikiHighlighterModule: ShikiHighlighterModule | null = null;
let shikiHighlighterModulePromise: Promise<ShikiHighlighterModule> | null = null;
let didScheduleCommonLanguagePrefetch = false;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
};

function scheduleCommonLanguagePrefetch() {
  if (didScheduleCommonLanguagePrefetch || typeof window === "undefined") return;
  didScheduleCommonLanguagePrefetch = true;

  const idleWindow = window as IdleWindow;
  const prefetch = () => {
    void loadShikiHighlighterModule().then(
      ({ prefetchCommonCodeLanguages }) => prefetchCommonCodeLanguages(),
      () => undefined,
    );
  };

  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(prefetch, { timeout: 4_000 });
    return;
  }

  window.setTimeout(prefetch, 3_000);
}

function highlightKey(code: string, language: string | null | undefined): string | null {
  if (!shouldHighlightCode(language)) return null;
  if (isTooLargeForInlineHighlight(code)) return null;
  return `${language ?? ""}\u0000${code}`;
}

export function isTooLargeForInlineHighlight(code: string): boolean {
  if (code.length > MAX_SHIKI_HIGHLIGHT_CHARS) return true;
  return code.split("\n", MAX_SHIKI_HIGHLIGHT_LINES + 1).length > MAX_SHIKI_HIGHLIGHT_LINES;
}

function loadShikiHighlighterModule(): Promise<ShikiHighlighterModule> {
  if (shikiHighlighterModule) return Promise.resolve(shikiHighlighterModule);
  if (!shikiHighlighterModulePromise) {
    shikiHighlighterModulePromise = import("./shikiHighlighter").then((module) => {
      shikiHighlighterModule = module;
      return module;
    });
  }
  return shikiHighlighterModulePromise;
}

function getWarmHighlightState(
  code: string,
  language: string | null | undefined,
): HighlightState | null {
  const lines = shikiHighlighterModule?.tryHighlightCodeSync(code, language) ?? null;
  return lines ? { status: "ready", lines } : null;
}

function getRecord(
  key: string,
  code: string,
  language: string | null | undefined,
): HighlightRecord {
  const existing = highlightRecords.get(key);
  if (existing) return existing;

  const record: HighlightRecord = {
    state: getWarmHighlightState(code, language) ?? PLAIN_HIGHLIGHT,
    listeners: new Set(),
    loading: false,
  };
  highlightRecords.set(key, record);
  return record;
}

function notify(record: HighlightRecord) {
  for (const listener of record.listeners) listener();
}

function startHighlightLoad(record: HighlightRecord, code: string, language: string | null | undefined) {
  if (record.loading || record.state.status === "ready") return;

  const warmHighlight = getWarmHighlightState(code, language);
  if (warmHighlight) {
    record.state = warmHighlight;
    notify(record);
    return;
  }

  record.loading = true;
  scheduleCommonLanguagePrefetch();

  loadShikiHighlighterModule().then(
    ({ highlightCode }) => highlightCode(code, language).then(
      (lines) => {
        record.state = { status: "ready", lines };
        notify(record);
      },
      () => {
        record.state = PLAIN_HIGHLIGHT;
        notify(record);
      },
    ),
    () => {
      record.state = PLAIN_HIGHLIGHT;
      notify(record);
    },
  );
}

function releaseRecord(key: string, record: HighlightRecord) {
  if (record.listeners.size === 0) highlightRecords.delete(key);
}

function getHighlightSnapshot(
  key: string | null,
  code: string,
  language: string | null | undefined,
): HighlightState {
  return key ? getRecord(key, code, language).state : PLAIN_HIGHLIGHT;
}

function tokenStyle(token: CodeTokenLine[number]): CSSProperties | undefined {
  return token.color ? { color: token.color } : undefined;
}

function PlainCode({ code }: { code: string }) {
  return <>{code}</>;
}

function ShikiHighlightedCodeImpl({
  code,
  language,
}: {
  code: string;
  language?: string | null;
}) {
  const key = highlightKey(code, language);
  const subscribe = useCallback((listener: () => void) => {
    if (!key) return () => {};

    const record = getRecord(key, code, language);
    record.listeners.add(listener);
    startHighlightLoad(record, code, language);
    return () => {
      record.listeners.delete(listener);
      releaseRecord(key, record);
    };
  }, [code, key, language]);
  const getSnapshot = useCallback(() => getHighlightSnapshot(key, code, language), [code, key, language]);
  const highlight = useSyncExternalStore(subscribe, getSnapshot, () => PLAIN_HIGHLIGHT);

  if (highlight.status !== "ready") {
    return <PlainCode code={code} />;
  }

  return (
    <>
      {highlight.lines.map((line, lineIndex) => (
        <span className="line" key={lineIndex}>
          {line.map((token, tokenIndex) => (
            <span key={tokenIndex} style={tokenStyle(token)}>
              {token.content}
            </span>
          ))}
          {lineIndex < highlight.lines.length - 1 ? "\n" : null}
        </span>
      ))}
    </>
  );
}

const ShikiHighlightedCode = memo(ShikiHighlightedCodeImpl);
export default ShikiHighlightedCode;

export function __getShikiHighlightRecordCountForTests(): number {
  return highlightRecords.size;
}

export function __resetShikiHighlightRecordsForTests(): void {
  highlightRecords.clear();
}
