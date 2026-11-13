import { isValidElement, useEffect, useState } from "react";
import type { ReactNode } from "react";

// Task #775: a formula is rendered with KaTeX, which is loaded the first time
// a formula is on screen (as Mermaid is) and never otherwise, so pages
// without math download nothing more. Until it arrives the formula shows as
// its source, in the code style it already parsed as.

type Katex = typeof import("katex").default;

let katexPromise: Promise<Katex> | null = null;

function loadKatex(): Promise<Katex> {
  katexPromise ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]).then(([module]) => module.default);
  // A failed load (offline, a stale deploy) may succeed on the next formula.
  katexPromise.catch(() => {
    katexPromise = null;
  });
  return katexPromise;
}

// Rendered HTML per (mode, source), so a formula that scrolls back into view
// or re-renders shows at once.
const rendered = new Map<string, string>();
const RENDERED_LIMIT = 500;

function renderKey(source: string, display: boolean) {
  return `${display ? "d" : "i"}:${source}`;
}

function renderFormula(katex: Katex, source: string, display: boolean): string {
  return katex.renderToString(source, {
    displayMode: display,
    // A typo shows KaTeX's red error text instead of breaking the message.
    throwOnError: false,
    // No \href, \url, \includegraphics or HTML extensions from a message.
    trust: false,
    strict: "ignore",
    // Bound what one message can make the browser do.
    maxSize: 50,
    maxExpand: 1000,
  });
}

export function useRenderedFormula(source: string, display: boolean): string | null {
  const key = renderKey(source, display);
  // Only the async render result lives in state; a cached formula is read
  // straight from the cache, and a formula that changed shows its source
  // until its own render arrives (the key no longer matches).
  const [loaded, setLoaded] = useState<{ key: string; html: string } | null>(null);
  useEffect(() => {
    if (rendered.has(key)) return;
    let current = true;
    loadKatex()
      .then((katex) => {
        const out = renderFormula(katex, source, display);
        if (rendered.size >= RENDERED_LIMIT) rendered.clear();
        rendered.set(key, out);
        if (current) setLoaded({ key, html: out });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [display, key, source]);
  return rendered.get(key) ?? (loaded?.key === key ? loaded.html : null);
}

export function textOf(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map(textOf).join("");
  return "";
}

/** True for the `<code>` react-markdown makes from a formula. */
export function isMathClassName(className: string | undefined): boolean {
  return !!className && /(^|\s)language-math(\s|$)/.test(className);
}

/**
 * The source of a block formula, read off the `<code>` child of the `<pre>`
 * react-markdown renders for `$$` on its own lines; null for any other block.
 */
export function readMathSource(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const props = children.props as { className?: string; children?: ReactNode };
  if (!isMathClassName(props.className)) return null;
  return textOf(props.children).replace(/\n$/, "");
}

