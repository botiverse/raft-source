import {
  Children,
  Component,
  isValidElement,
  memo,
  useMemo,
} from "react";
import type {
  ErrorInfo,
  ReactNode,
  ComponentPropsWithoutRef,
  ComponentType,
} from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components, Options } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import rehypeSanitize from "rehype-sanitize";
import { InlineCode, Separator, MarkdownLink as RaftMarkdownLink } from "@botiverse/raft-ui";
import { remarkAutolinkBareUrls } from "../../utils/markdownAutolink";
import {
  EXTERNAL_TRANSLATION_GUARD_TRANSLATE,
  withExternalTranslationGuardClass,
} from "../../utils/externalTranslationGuard";

type PluggableList = NonNullable<Options["remarkPlugins"]>;
import { transparentImageBackgroundClass } from "../../utils/imagePreviewStyles";
import CodeBlock, { extractCodeBlockText } from "./CodeBlock";
import { markdownSanitizeSchema, MARKDOWN_EXTRA_HREF_PROTOCOLS } from "./markdownSanitizeSchema";
import { CustomProtocolLink, isCustomProtocolHref } from "./CustomProtocolLink";
import { MermaidDiagram } from "../mermaid/MermaidDiagram";
import { readMermaidSource } from "../mermaid/mermaidSource";
import { remarkDisableIndentedCode } from "./remarkDisableIndentedCode";
import { remarkRaftMath } from "./remarkRaftMath";
import { InlineMath } from "./InlineMath";
import { DisplayMath } from "./DisplayMath";
import { isMathClassName, readMathSource } from "./mathFormula";

interface MarkdownContentErrorBoundaryProps {
  source: string;
  children: ReactNode;
}

interface MarkdownContentErrorBoundaryState {
  source: string;
  error: Error | null;
}

class MarkdownContentErrorBoundary extends Component<
  MarkdownContentErrorBoundaryProps,
  MarkdownContentErrorBoundaryState
> {
  state: MarkdownContentErrorBoundaryState = {
    source: this.props.source,
    error: null,
  };

  static getDerivedStateFromProps(
    props: MarkdownContentErrorBoundaryProps,
    state: MarkdownContentErrorBoundaryState,
  ): Partial<MarkdownContentErrorBoundaryState> | null {
    if (props.source !== state.source) {
      return { source: props.source, error: null };
    }
    return null;
  }

  static getDerivedStateFromError(error: Error): Partial<MarkdownContentErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.warn(
      "[MarkdownContent] render failed; falling back to raw markdown",
      error,
      info.componentStack,
    );
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <pre
          data-markdown-dom-fallback=""
          translate={EXTERNAL_TRANSLATION_GUARD_TRANSLATE}
          className={withExternalTranslationGuardClass(
            "whitespace-pre-wrap break-words font-mono text-[0.875em] leading-relaxed text-foreground",
          )}
          data-immersive-translate-ignore=""
        >
          {this.props.source}
        </pre>
      );
    }
    return this.props.children;
  }
}

/** Shared code-block wrapper (DS code block: the `code` layer, a hairline,
 *  container radius, Space Mono) — the canonical look for every fenced block
 *  across chat body + attachment preview. Extracted so the mermaid-aware
 *  `pre` can reuse it verbatim for the non-mermaid path, and a card's
 *  Markdown (which draws every fence as code, never a formula) can too. */
export function BaseCodePre({ children }: { children?: ReactNode }) {
  const codeText = extractCodeBlockText(children);
  const language = extractCodeBlockLanguage(children);
  return (
    <CodeBlock
      // The body follows the message's font-size preference and line height,
      // like the rest of the rich text, instead of raft-ui's fixed code size.
      bodyClassName="[font-size:inherit]! [line-height:inherit]!"
      className="text-code-foreground [font-size:inherit] font-mono [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0"
      code={codeText}
      language={language}
    >
      {children}
    </CodeBlock>
  );
}

export function extractCodeBlockLanguage(node: ReactNode): string | null {
  let language: string | null = null;

  Children.forEach(node, (child) => {
    if (language) return;
    if (Array.isArray(child)) {
      language = extractCodeBlockLanguage(child);
      return;
    }
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return;
    const className = child.props.className;
    const match = typeof className === "string" ? className.match(/\blanguage-([^\s]+)/) : null;
    if (match) {
      language = match[1];
      return;
    }
    language = extractCodeBlockLanguage(child.props.children);
  });

  return language;
}

/**
 * Single source of truth for the visual styling of every markdown surface in
 * the app — chat message body, markdown attachment preview, anywhere else
 * we'd otherwise hand-roll a `<ReactMarkdown components={...}>` setup.
 *
 * Surfaces that need extra behavior (chat-body @mentions, channel refs, task
 * refs, slock permalinks, reminder receipts) spread this object and override
 * the elements they care about.
 *
 * stdrc 2026-05-08 #proj-uiux:6110c1ce (task #137):
 *   "markdown 或相关文件 attachment 的预览，需要和消息正文用同样的样式预览，
 *    这需要复用组件"
 *
 * Before this consolidation, MarkdownPreviewPane (modal) and renderContent()
 * (chat body) had two diverged components maps. Notable drifts:
 *   - code blocks: chat body uses `bg-gray-900` dark; preview used `bg-palette-cream`
 *   - inline code: chat body uses `bg-palette-yellow/40`; preview used `bg-palette-cream`
 *   - lists / headings / table-th bg / blockquote: each diverged independently
 *
 * Chat body's styling is canonical (it's what users see most of the time);
 * preview adopts it.
 */

/** Shared blockquote base (DS quote: a 2px seam bar, ink-2 text) shared
 *  across every markdown render surface (chat body, attachment preview,
 *  AgentWorkspace .md preview). Per-callsite vertical margin is appended
 *  by the caller (`my-1` for chat density, `my-2` for document density).
 *  Centralizing this keeps tuning like #proj-uiux task #299 single-source
 *  — stdrc 2026-05-24 audit follow-up. */
export const MARKDOWN_BLOCKQUOTE_BASE_CLASS =
  "border-l-2 border-line-seam pl-2.5 text-foreground-muted";

type ExternalTranslationGuardProps = {
  translate: typeof EXTERNAL_TRANSLATION_GUARD_TRANSLATE;
  className: string;
};

function externalTranslationGuardProps(className: string): ExternalTranslationGuardProps {
  return {
    translate: EXTERNAL_TRANSLATION_GUARD_TRANSLATE,
    className: withExternalTranslationGuardClass(className),
  };
}

function mergeClassName(className: string | undefined, fallback: string): string {
  return [className, fallback].filter(Boolean).join(" ");
}

export function MarkdownCode({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  // A formula (task #775). Block formulas are taken in the `pre` slot, so
  // math reaching here is inline.
  if (isMathClassName(className)) return <InlineMath>{children}</InlineMath>;
  // Inline code (no language class)
  if (!className) {
    return (
      // raft-ui owns the in-message treatment (borderless, 0.875em, on the
      // baseline, long tokens break) since 0.5.16 — no local restyling.
      <InlineCode appearance="message">
        {children}
      </InlineCode>
    );
  }
  // Code inside <pre> (block) — render plain so the parent <pre> styling wins
  return <code className={className}>{children}</code>;
}

/**
 * Canonical markdown link renderer. Custom-protocol hrefs (obsidian:// and
 * friends — the sanitize allowlist extension in `markdownSanitizeSchema.ts`
 * decides which schemes can reach this point) route through a confirmation
 * dialog before handing off to the OS (task #734); ordinary links open in a
 * new tab. The chat surface's anchor override delegates to this for
 * custom-protocol hrefs, so the confirm decision lives in exactly one place
 * for every surface that renders untrusted markdown.
 */
export function MarkdownLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  if (isCustomProtocolHref(href)) {
    return <CustomProtocolLink href={href}>{children}</CustomProtocolLink>;
  }
  return (
    <RaftMarkdownLink
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      {...externalTranslationGuardProps("")}
    >
      {children}
    </RaftMarkdownLink>
  );
}

export const BASE_MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => {
    const mathSource = readMathSource(children);
    if (mathSource !== null) return <DisplayMath source={mathSource} />;
    return <BaseCodePre>{children}</BaseCodePre>;
  },
  code: (props) => <MarkdownCode {...props} />,
  p: ({ children }) => (
    <p {...externalTranslationGuardProps("mb-1 last:mb-0")}>
      {children}
    </p>
  ),
  ul: ({ node: _node, children, className, ...props }) => (
    <ul {...props} {...externalTranslationGuardProps(mergeClassName(className, "mb-1 pl-5 list-disc"))}>
      {children}
    </ul>
  ),
  ol: ({ node: _node, children, className, ...props }) => (
    <ol {...props} {...externalTranslationGuardProps(mergeClassName(className, "mb-1 pl-5 list-decimal"))}>
      {children}
    </ol>
  ),
  li: ({ node: _node, children, className, ...props }) => (
    <li {...props} {...externalTranslationGuardProps(mergeClassName(className, "mb-0.5"))}>
      {children}
    </li>
  ),
  blockquote: ({ children }) => (
    // Keep the no-fill blockquote shape restored after PR #1834, but use a
    // lighter left accent per #proj-uiux task #299.
    <blockquote {...externalTranslationGuardProps(`${MARKDOWN_BLOCKQUOTE_BASE_CLASS} my-1`)}>
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div data-md-table="" {...externalTranslationGuardProps("my-2 overflow-x-auto")}>
    <table className="border-collapse border border-line-hairline [font-size:inherit]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th
      {...externalTranslationGuardProps(
        "border border-line-hairline bg-fill-muted px-2 py-1 text-left font-bold whitespace-nowrap text-foreground",
      )}
    >
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td {...externalTranslationGuardProps("border border-line-hairline px-2 py-1")}>
      {children}
    </td>
  ),
  h1: ({ children }) => (
    <h1 {...externalTranslationGuardProps("text-[1.286em] font-bold mt-3 mb-1 leading-tight")}>
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 {...externalTranslationGuardProps("text-[1.143em] font-bold mt-2 mb-1 leading-tight")}>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 {...externalTranslationGuardProps("text-[1.071em] font-bold mt-2 mb-1 leading-tight")}>
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 {...externalTranslationGuardProps("text-[1em] font-bold mt-1 mb-0.5 leading-tight")}>
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 {...externalTranslationGuardProps("text-[1em] font-bold mt-1 mb-0.5 leading-tight")}>
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 {...externalTranslationGuardProps("text-[1em] font-bold mt-1 mb-0.5 leading-tight text-foreground-muted")}>
      {children}
    </h6>
  ),
  hr: () => <Separator className="my-2" />,
  img: ({ src, alt }) => (
    <img src={src} alt={alt || ""} className={`my-2 max-w-full rounded-container border border-line-hairline ${transparentImageBackgroundClass}`} />
  ),
  // Default link renderer — opens ordinary links in a new tab, custom
  // protocols (obsidian://) through the confirm dialog (task #734). Chat
  // surface overrides this to handle @mention / #channel / task / thread /
  // slock permalink markup, and delegates back to MarkdownLink for
  // custom-protocol hrefs.
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
};

const DOCUMENT_MARKDOWN_COMPONENTS: Components = {
  p: ({ children }) => (
    <p {...externalTranslationGuardProps("mb-3 last:mb-0")}>
      {children}
    </p>
  ),
  ul: ({ node: _node, children, className, ...props }) => (
    <ul {...props} {...externalTranslationGuardProps(mergeClassName(className, "mb-3 pl-6 list-disc"))}>
      {children}
    </ul>
  ),
  ol: ({ node: _node, children, className, ...props }) => (
    <ol {...props} {...externalTranslationGuardProps(mergeClassName(className, "mb-3 pl-6 list-decimal"))}>
      {children}
    </ol>
  ),
  li: ({ node: _node, children, className, ...props }) => (
    <li {...props} {...externalTranslationGuardProps(mergeClassName(className, "mb-1"))}>
      {children}
    </li>
  ),
  // Document density follows mainstream markdown reader hierarchy: with a
  // 16px body, h1/h2/h3 need a visible 2em-ish / 1.5em / 1.25em scale. Inline code,
  // blockquote, tables, and code blocks intentionally stay in the BASE map so
  // document preview keeps Slock markdown tokens instead of inventing another
  // prose skin.
  h1: ({ children }) => (
    <h1 {...externalTranslationGuardProps("text-3xl font-bold mt-6 mb-3 leading-tight")}>
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 {...externalTranslationGuardProps("text-2xl font-bold mt-5 mb-2.5 leading-tight")}>
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 {...externalTranslationGuardProps("text-xl font-bold mt-4 mb-2 leading-tight")}>
      {children}
    </h3>
  ),
};

// Mermaid remains explicit per surface so ordinary markdown never loads its
// renderer by accident. Chat bodies, forwarded/comment bodies, Markdown
// and attachments opt in. Intercepting in `pre` (not `code`)
// keeps the isolated diagram frame out of the dark code wrapper entirely;
// non-mermaid blocks fall back to the identical BaseCodePre.
const MERMAID_MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => {
    const mermaidSource = readMermaidSource(children);
    if (mermaidSource !== null) {
      return <MermaidDiagram code={mermaidSource} />;
    }
    const mathSource = readMathSource(children);
    if (mathSource !== null) return <DisplayMath source={mathSource} />;
    return <BaseCodePre>{children}</BaseCodePre>;
  },
};

export type MarkdownDensity = "compact" | "document";

// The (density, enableMermaid) input space is tiny and the component maps are
// module constants, so cache the merged result per key. This returns a STABLE
// object reference across renders — critical because react-markdown re-parses
// its entire tree whenever the `components` prop identity changes, and this map
// was previously rebuilt on every <MarkdownContent> render (a top hot-path cost
// in the message list — #wg-frontend-perf 2026-06-06 prod CPU trace).
const _markdownComponentsCache = new Map<string, Components>();
export function getMarkdownComponents(
  density: MarkdownDensity,
  enableMermaid = false,
): Components {
  const key = `${density}:${enableMermaid}`;
  const cached = _markdownComponentsCache.get(key);
  if (cached) return cached;
  let components: Components =
    density === "document"
      ? { ...BASE_MARKDOWN_COMPONENTS, ...DOCUMENT_MARKDOWN_COMPONENTS }
      : BASE_MARKDOWN_COMPONENTS;
  if (enableMermaid) {
    components = { ...components, ...MERMAID_MARKDOWN_COMPONENTS };
  }
  _markdownComponentsCache.set(key, components);
  return components;
}

// Module-level stable defaults — passing fresh arrays as default param values
// gave react-markdown a new `remarkPlugins`/`rehypePlugins` identity every
// render, forcing a full re-parse even when the source was unchanged.
const DOCUMENT_REMARK_PLUGINS: PluggableList = [
  remarkGfm,
  remarkCjkFriendly,
  remarkRaftMath,
  remarkAutolinkBareUrls,
  remarkBreaks,
];
const COMPACT_REMARK_PLUGINS: PluggableList = [
  remarkDisableIndentedCode,
  ...DOCUMENT_REMARK_PLUGINS,
];
const DEFAULT_REHYPE_PLUGINS: PluggableList = [[rehypeSanitize, markdownSanitizeSchema]];

// react-markdown applies its own urlTransform AFTER the rehype plugins, and
// its default blanks any href scheme outside http/https/mailto/… — that would
// re-strip the custom protocols the sanitize schema just allowed (task #734).
// Preserve exactly the schemes on the sanitize allowlist extension; defer to
// the default transform for everything else. Module-level so the prop keeps a
// stable identity (see the memoization note above).
function markdownUrlTransform(url: string): string {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)?.[1]?.toLowerCase();
  if (scheme && MARKDOWN_EXTRA_HREF_PROTOCOLS.includes(scheme)) return url;
  return defaultUrlTransform(url);
}

export interface MarkdownContentProps {
  /** The markdown source string. */
  source: string;
  /** `compact` matches chat density; `document` is for fullscreen reading surfaces. */
  density?: MarkdownDensity;
  /**
   * Overrides the shared remark plugins. Compact density still prepends its
   * parser policy that disables implicit indented code.
   */
  remarkPlugins?: PluggableList;
  /**
   * Defaults to `[rehypeSanitize]` with the shared schema. Raw HTML in the
   * source is never parsed into elements (no rehype-raw): chat marks its
   * mentions and refs on the syntax tree instead (remarkMessageTokens).
   */
  rehypePlugins?: PluggableList;
  /**
   * Per-element overrides spread on top of `BASE_MARKDOWN_COMPONENTS`. Use
   * this to keep the visual baseline shared while specializing chat-only
   * link / span / etc. behavior.
   */
  components?: Components;
  /**
   * Render ```mermaid fenced blocks through the shared isolated diagram
   * component. Opt-in keeps the renderer chunk lazy across surfaces that do
   * not support rich document blocks.
   */
  enableMermaid?: boolean;
}

function MarkdownContentImpl({
  source,
  density = "compact",
  remarkPlugins,
  rehypePlugins = DEFAULT_REHYPE_PLUGINS,
  components,
  enableMermaid = false,
}: MarkdownContentProps) {
  const baseComponents = getMarkdownComponents(density, enableMermaid);
  const resolvedRemarkPlugins = useMemo(() => {
    if (density === "document") return remarkPlugins ?? DOCUMENT_REMARK_PLUGINS;
    if (!remarkPlugins) return COMPACT_REMARK_PLUGINS;
    return [remarkDisableIndentedCode, ...remarkPlugins];
  }, [density, remarkPlugins]);
  const mergedComponents = useMemo(
    () => {
      if (!components) return baseComponents;

      const merged = { ...baseComponents, ...components };
      const AnchorOverride = components.a as
        | ComponentType<ComponentPropsWithoutRef<"a"> & { node?: unknown }>
        | undefined;
      if (AnchorOverride) {
        // Chat supplies a large custom anchor renderer for mentions, refs, and
        // ordinary URLs. Keep the external-translation guard even when that
        // override replaces BASE_MARKDOWN_COMPONENTS.a: every return path is
        // now enclosed by the closest possible translator-ignore boundary.
        merged.a = (props) => (
          <span
            translate={EXTERNAL_TRANSLATION_GUARD_TRANSLATE}
            className={withExternalTranslationGuardClass("contents")}
            data-immersive-translate-ignore=""
          >
            <AnchorOverride {...props} />
          </span>
        );
      }
      return merged;
    },
    [baseComponents, components],
  );
  return (
    <MarkdownContentErrorBoundary source={source}>
      <div
        data-raft-markdown-content=""
        translate={EXTERNAL_TRANSLATION_GUARD_TRANSLATE}
        className={withExternalTranslationGuardClass("contents")}
        data-immersive-translate-ignore=""
      >
        <ReactMarkdown
          remarkPlugins={resolvedRemarkPlugins}
          rehypePlugins={rehypePlugins}
          urlTransform={markdownUrlTransform}
          components={mergedComponents}
        >
          {source}
        </ReactMarkdown>
      </div>
    </MarkdownContentErrorBoundary>
  );
}

// Memoized: react-markdown parsing is a top message-list hot-path cost. With
// stable props (source + the module-level plugin/components defaults, and
// caller-memoized `components`), this skips re-parsing when the parent
// MessageItem re-renders for an unrelated reason.
const MarkdownContent = memo(MarkdownContentImpl);
export default MarkdownContent;
