import { buildMermaidSrcDoc, parseSvgAspect } from "./mermaidFrame";

export type MermaidRenderTheme = "light";

export interface MermaidRenderResult {
  svg: string;
  srcDoc: string;
  width: number;
  height: number;
  theme: MermaidRenderTheme;
}

type MermaidModule = typeof import("mermaid");
type MermaidApi = MermaidModule["default"];

const MAX_RENDER_CACHE_ENTRIES = 48;
const renderCache = new Map<string, Promise<MermaidRenderResult>>();
let mermaidModulePromise: Promise<MermaidApi> | null = null;
let nextDiagramId = 0;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          suppressErrorRendering: true,
          securityLevel: "strict",
          theme: "base",
          // Pure SVG labels remain portable through the explicit SVG → PNG
          // export path. HTML labels introduce <foreignObject>, which browser
          // image decoders (especially WebKit) reject when rasterizing a blob.
          // Mermaid converts recognized source line breaks into SVG <tspan>
          // rows, so strict mode never needs an HTML escape hatch.
          htmlLabels: false,
          // The SVG renders in an opaque srcDoc iframe, so app CSS variables
          // cannot cross that document boundary. Literal light-theme colors
          // are intentional until Raft exposes a real theme signal.
          themeVariables: {
            background: "#ffffff",
            primaryColor: "#ffffff",
            primaryTextColor: "#141111",
            primaryBorderColor: "#141111",
            lineColor: "#141111",
            secondaryColor: "#f5f0e8",
            tertiaryColor: "#ffffff",
          },
        });
        return mermaid;
      })
      .catch((error) => {
        mermaidModulePromise = null;
        throw error;
      });
  }
  return mermaidModulePromise;
}

function renderCacheKey(code: string, theme: MermaidRenderTheme): string {
  return `${theme}\u0000${code}`;
}

function touchCacheEntry(key: string, value: Promise<MermaidRenderResult>) {
  renderCache.delete(key);
  renderCache.set(key, value);
  while (renderCache.size > MAX_RENDER_CACHE_ENTRIES) {
    const oldestKey = renderCache.keys().next().value;
    if (oldestKey === undefined) break;
    renderCache.delete(oldestKey);
  }
}

/**
 * Parse + asynchronously render one diagram after the official Mermaid lazy
 * chunk is requested.
 * The promise cache coalesces duplicate diagrams and includes the resolved
 * light/dark mode in its key, so a theme switch never reuses stale SVG ink.
 */
export function renderMermaidDiagram(
  code: string,
  theme: MermaidRenderTheme,
): Promise<MermaidRenderResult> {
  const key = renderCacheKey(code, theme);
  const cached = renderCache.get(key);
  if (cached) {
    touchCacheEntry(key, cached);
    return cached;
  }

  const rendered = loadMermaid().then(async (mermaid) => {
    // Validate independently so syntax failures never reach Mermaid's DOM
    // renderer. suppressErrorRendering prevents the renderer from inserting
    // its own error diagram; our component owns the visible error state.
    // `parse` is serialized by Mermaid's global queue. Run its synchronous
    // detector first so an obviously unknown diagram type cannot wait behind
    // unrelated valid diagrams that are already rendering. This keeps the
    // consumer's generic error state timely without duplicating Mermaid's
    // grammar or weakening the async render path for recognized types.
    mermaid.detectType(code);
    await mermaid.parse(code);
    const diagramId = `raft-mermaid-${++nextDiagramId}`;
    const { svg } = await mermaid.render(diagramId, code);
    const { w, h } = parseSvgAspect(svg);
    return {
      svg,
      srcDoc: buildMermaidSrcDoc(svg),
      width: w,
      height: h,
      theme,
    };
  });

  const guarded = rendered.catch((error) => {
    // A syntax error must not poison future attempts after the source changes,
    // and a transient chunk failure must remain retryable.
    if (renderCache.get(key) === guarded) renderCache.delete(key);
    throw error;
  });
  touchCacheEntry(key, guarded);
  return guarded;
}
