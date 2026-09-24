import { isValidElement } from "react";
import type { ReactNode } from "react";

/**
 * react-markdown renders fenced blocks as `<pre><code class="language-x">`.
 * Pull the language + raw text off the `<code>` child so a ```mermaid block
 * can be intercepted in the `pre` slot (keeps the rendered SVG out of the
 * dark code wrapper entirely).
 *
 * Returns the trimmed mermaid source, or null when the child isn't a mermaid
 * code node (so the caller falls back to the normal code block).
 */
export function readMermaidSource(children: ReactNode): string | null {
  if (!isValidElement(children)) return null;
  const props = children.props as { className?: string; children?: ReactNode };
  if (!props.className || !/(^|\s)language-mermaid(\s|$)/.test(props.className)) {
    return null;
  }
  const raw = props.children;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join("") : "";
  return text.replace(/\n$/, "");
}
