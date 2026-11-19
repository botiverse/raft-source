import { createElement, useMemo, useRef } from "react";
import type { ComponentType, ReactNode } from "react";
import type { Components } from "react-markdown";

type Props = Record<string, unknown>;

/**
 * One component identity per element for a Markdown component table that is
 * rebuilt as its inputs change.
 *
 * react-markdown draws each element with the table's component for it, and
 * React remounts a subtree whose component type changes. The chat table is
 * rebuilt whenever members, channels, agents or a setting load, a few times
 * right after a channel opens, and each rebuild tore down and rebuilt every
 * link, mention chip and preview card in every message (raft-perf on
 * `#wa-main`: Artifact reference chips built 15 times per switch instead of 3,
 * #proj-frontend:#57).
 *
 * Each stable component draws the table's latest renderer for its element, so
 * what is drawn still follows the latest inputs: a new table returns a new
 * object with the same component values, so MarkdownContent re-renders the
 * tree without remounting it. A function renderer is called as a plain render
 * function inside the stable component, so it must be a function component
 * whose hooks (if any) are the same on every rebuild, never a class; any other
 * renderer (a tag name, a memo or forwardRef object) is drawn as an element.
 */
export function useStableMarkdownComponents(table: Components): Components {
  const latest = useRef(table);
  latest.current = table;
  const cache = useRef(new Map<string, ComponentType<Props>>());
  // A new object for each new table, with the same component per element: MarkdownContent re-renders with the
  // latest renderers and nothing under it remounts.
  return useMemo(() => {
    const stable: Record<string, ComponentType<Props>> = {};
    for (const key of Object.keys(table)) {
      let component = cache.current.get(key);
      if (!component) {
        component = function StableMarkdownElement(props: Props): ReactNode {
          const renderer = (latest.current as Record<string, unknown>)[key];
          if (!renderer) return null;
          if (typeof renderer === "function") return (renderer as (props: Props) => ReactNode)(props);
          return createElement(renderer as Parameters<typeof createElement>[0], props);
        };
        component.displayName = `StableMarkdown(${key})`;
        cache.current.set(key, component);
      }
      stable[key] = component;
    }
    return stable as Components;
  }, [table]);
}
