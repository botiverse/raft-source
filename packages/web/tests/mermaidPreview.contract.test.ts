import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

test("official mermaid replaces the limited beautiful-mermaid dependency", () => {
  const pkg = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.ok(pkg.dependencies.mermaid, "official mermaid must be a dependency");
  assert.ok(!pkg.dependencies["beautiful-mermaid"], "beautiful-mermaid must be removed, not kept in parallel");
  assert.ok(!pkg.dependencies["better-mermaid"], "better-mermaid must NOT be a dependency");
  // Isolation is via sandboxed iframe, not a second app-owned sanitizer dep.
  // Mermaid may keep DOMPurify internally as its own strict-rendering detail.
  const all = { ...pkg.dependencies, ...pkg.devDependencies };
  assert.ok(!all["isomorphic-dompurify"] && !all.dompurify, "no extra direct DOMPurify dependency");
});

test("Mermaid renderer lazy-loads official mermaid and owns a bounded result cache", () => {
  const src = read("src/components/markdown/mermaid/mermaidRenderer.ts");
  // Dynamic import only — a static `from "beautiful-mermaid"` would pull the
  // layout engine into the main chunk.
  assert.match(src, /import\("mermaid"\)/);
  assert.doesNotMatch(src, /from\s+["']mermaid["']/);
  assert.doesNotMatch(src, /beautiful-mermaid/);
  // Official parse + async render run only after the lazy module resolves.
  assert.match(src, /await mermaid\.parse\(code\)/);
  assert.match(src, /await mermaid\.render\(diagramId, code\)/);
  assert.match(src, /renderCacheKey\(code, theme\)/);
  assert.match(src, /MAX_RENDER_CACHE_ENTRIES/);
  assert.match(src, /renderCache\.delete\(key\)/);
  assert.match(src, /startOnLoad: false/);
  assert.match(src, /suppressErrorRendering: true/);
  assert.match(src, /securityLevel: "strict"/);
  assert.match(src, /htmlLabels: false/);
  assert.doesNotMatch(src, /securityLevel: "(?:loose|antiscript)"/);
  assert.match(src, /const diagramId = `raft-mermaid-\$\{\+\+nextDiagramId\}`/);
});

test("①+② attacker-controlled SVG renders in an EMPTY-sandbox iframe, never main DOM", () => {
  const src = read("src/components/markdown/mermaid/MermaidDiagramViewer.tsx");
  // No string ever reaches the main document — the only safe sink is the
  // sandboxed iframe. dangerouslySetInnerHTML must not exist here at all.
  assert.doesNotMatch(src, /dangerouslySetInnerHTML/);
  // SVG goes into the shared isolation primitive via srcDoc with an EMPTY
  // sandbox (no allow-scripts, no allow-same-origin) → opaque origin, zero
  // script execution, so script/onload/foreignObject/javascript: are inert.
  assert.match(src, /import SandboxedPreviewFrame from "\.\.\/\.\.\/ui\/SandboxedPreviewFrame"/);
  assert.match(src, /<SandboxedPreviewFrame\b[\s\S]*?srcDoc=\{result\.srcDoc\}[\s\S]*?sandbox=""/);
  assert.doesNotMatch(src, /sandbox="[^"]*allow-(scripts|same-origin)[^"]*"/);
  const renderer = read("src/components/markdown/mermaid/mermaidRenderer.ts");
  assert.match(renderer, /buildMermaidSrcDoc\(svg\)/);

  // srcDoc carries a strict CSP as defense-in-depth on top of the empty sandbox.
  const frame = read("src/components/markdown/mermaid/mermaidFrame.ts");
  assert.match(frame, /Content-Security-Policy/);
  assert.match(frame, /default-src 'none'/);
  assert.match(frame, /export function buildMermaidSrcDoc\(svg: string\): string/);
  assert.match(frame, /export function parseSvgAspect\(svg: string\)/);
});

test("Share image consumes a generic static-capture boundary while Mermaid supplies raster ink", () => {
  const screenshot = read("src/utils/selectScreenshot.ts");
  const boundary = read("src/utils/domCaptureSnapshot.ts");
  const diagram = read("src/components/markdown/mermaid/MermaidDiagram.tsx");
  assert.match(screenshot, /import \{ materializeDomCaptureSnapshots \} from "\.\/domCaptureSnapshot"/);
  assert.match(screenshot, /await materializeDomCaptureSnapshots\(node, clone\)/);
  assert.doesNotMatch(screenshot, /mermaid/i,
    "the Share-image pipeline must not know which component supplies a snapshot");
  assert.match(boundary, /const providers = new WeakMap<HTMLElement, DomCaptureSnapshotProvider>\(\)/);
  assert.match(diagram, /registerDomCaptureSnapshot\(root, async \(\) =>/);
  assert.match(diagram, /svgToPngBlob\(result,/);
  assert.match(diagram, /URL\.createObjectURL\(blob\)/);
  assert.match(diagram, /image\.className = "r-mermaid-capture-snapshot__image"/);
  assert.doesNotMatch(diagram, /dangerouslySetInnerHTML/);
  assert.doesNotMatch(diagram, /data:image\/svg\+xml|image\.src\s*=\s*result\.svg/,
    "the main document receives only a PNG object URL, never attacker-controlled SVG");
});

test("interactive Mermaid chrome keeps SVG outside React state and main DOM", () => {
  const diagramSrc = read("src/components/markdown/mermaid/MermaidDiagram.tsx");
  const toolbarSrc = read("src/components/markdown/mermaid/MermaidToolbar.tsx");
  const viewerSrc = read("src/components/markdown/mermaid/MermaidDiagramViewer.tsx");
  const mermaidCss = read("src/components/markdown/mermaid/mermaid.css");
  const indexCss = read("src/index.css");
  const src = [diagramSrc, toolbarSrc, viewerSrc].join("\n");
  const zoom = read("src/components/ImageZoom.ts");
  assert.match(diagramSrc, /type MermaidRenderState =[\s\S]*status: "loading"[\s\S]*status: "valid"[\s\S]*status: "error"/);
  assert.match(diagramSrc, /renderCounterRef/);
  assert.match(viewerSrc, /ImageZoomController,[\s\S]*ImageZoomLayoutSettleRequest,[\s\S]*from "\.\.\/\.\.\/ImageZoom"/);
  assert.match(diagramSrc, /wheelRequiresModifier: true/);
  assert.match(diagramSrc, /wheelRequiresModifier: false/);
  assert.match(viewerSrc, /ref=\{zoom\.wheelTargetRef\}/);
  assert.match(viewerSrc, /ref=\{zoom\.imageRef\}/);
  assert.doesNotMatch(viewerSrc, /\bonWheel=/);
  assert.match(zoom, /addEventListener\("wheel", wheelListenerRef\.current, \{ passive: false \}\)/);
  assert.match(zoom, /if \(wheelRequiresModifier && !event\.ctrlKey && !event\.metaKey\) return/);
  assert.match(zoom, /if \(current\.scale <= 1\.001\) return/);
  // Scale=1 is a CSS contain-fit baseline on both Mermaid surfaces. Both may
  // intentionally shrink below fit to the same hard floor, while the generic
  // ImageLightbox retains the classic minimum of 1.
  assert.match(zoom, /minScale\?: number/);
  assert.match(zoom, /if \(minScale === undefined \|\| !Number\.isFinite\(minScale\)\) return MIN_SCALE/);
  assert.match(diagramSrc, /const MERMAID_MIN_SCALE = 0\.05/);
  assert.equal((diagramSrc.match(/minScale: MERMAID_MIN_SCALE/g) ?? []).length, 2);
  assert.equal((diagramSrc.match(/scaleMode: "layout"/g) ?? []).length, 2);
  assert.match(zoom, /scaleMode\?: "transform" \| "layout"/);
  assert.match(zoom, /const settledScaleRef = useRef\(1\)/);
  assert.match(zoom, /el\.style\.width = `\$\{settledScaleRef\.current \* 100\}%`/);
  assert.match(zoom, /el\.style\.height = `\$\{settledScaleRef\.current \* 100\}%`/);
  assert.match(zoom, /const transientScale = next\.scale \/ settledScaleRef\.current/);
  assert.match(zoom, /settledScaleRef\.current = next\.scale/);
  assert.match(zoom, /const commitLiveTransform = useCallback\(\(\) => \{\s*commitTransform\(liveTransformRef\.current\)/);
  assert.match(zoom, /layoutSettleRef: \(settler: ImageZoomLayoutSettler \| null\) => void/);
  assert.match(zoom, /settler\(\{[\s\S]*fromScale,[\s\S]*toScale: next\.scale,[\s\S]*complete:/);
  assert.match(zoom, /scaleMode === "layout"[\s\S]*?translate\(-50%, -50%\)/);
  assert.doesNotMatch(viewerSrc, /INLINE_INITIAL_FIT_THRESHOLD|initialFitThreshold|240px/);
  assert.match(viewerSrc, /data-testid="mermaid-zoom-anchor"/);
  assert.match(viewerSrc, /data-testid="mermaid-zoom-media"/);
  assert.match(viewerSrc, /transformOrigin: "center center"/);
  assert.match(viewerSrc, /function BufferedMermaidFrame\(/);
  assert.match(viewerSrc, /const MERMAID_RETIRE_PAINT_FRAMES = 6/);
  assert.match(viewerSrc, /const layers = transition[\s\S]*activeFrameId[\s\S]*transition\.id[\s\S]*retiringFrame/);
  assert.match(viewerSrc, /requestAnimationFrame\(\(\) => \{[\s\S]*requestAnimationFrame\(\(\) => \{/);
  assert.match(viewerSrc, /width: `\$\{layer\.ratio \* 100\}%`[\s\S]*transform: `translate\(-50%, -50%\) scale\(\$\{1 \/ layer\.ratio\}\)`[\s\S]*opacity: 1,[\s\S]*zIndex: 0/);
  assert.match(viewerSrc, /width: `\$\{100 \/ layer\.ratio\}%`[\s\S]*transform: `translate\(-50%, -50%\) scale\(\$\{layer\.ratio\}\)`[\s\S]*opacity: 1,[\s\S]*zIndex: 2/);
  assert.match(viewerSrc, /ariaHidden=\{layer\.kind === "active" \? undefined : true\}/);
  assert.match(viewerSrc, /tabIndex=\{layer\.kind === "active" \? undefined : -1\}/);
  assert.match(viewerSrc, /onLoad=\{layer\.kind === "prepared" \? \(\) => finishPreparedFrame\(layer\.id\) : undefined\}/);
  assert.match(viewerSrc, /<BufferedMermaidFrame[\s\S]*result=\{result\}[\s\S]*zoom=\{zoom\}/);
  assert.match(viewerSrc, /data-testid="mermaid-pan-zoom-viewport"/);
  assert.match(viewerSrc, /onTouchStart=\{zoom\.onTouchStart\}/);
  assert.match(viewerSrc, /onTouchMove=\{zoom\.onTouchMove\}/);
  assert.match(viewerSrc, /onTouchEnd=\{zoom\.onTouchEnd\}/);
  assert.match(viewerSrc, /touchAction: fullscreen \? "none" : "pan-y"/);
  assert.match(toolbarSrc, /data-testid="mermaid-toolbar"/);
  assert.match(indexCss, /@import "\.\/components\/markdown\/mermaid\/mermaid\.css";/);
  assert.match(toolbarSrc, /className="r-mermaid-toolbar"/);
  assert.match(toolbarSrc, /className="r-mermaid-toolbar__zoom"/);
  assert.match(toolbarSrc, /MERMAID_TOOLTIP_CONTENT_CLASS = "r-mermaid-tooltip"/);
  assert.match(toolbarSrc, /MERMAID_MOBILE_TOUCH_TARGET_CLASS = "r-mermaid-toolbar__touch-target"/);
  assert.match(mermaidCss, /\.r-mermaid-toolbar\s*\{[^}]*position: sticky;[^}]*top: 0;/s);
  assert.match(mermaidCss, /\.r-mermaid-toolbar__touch-target::before\s*\{[^}]*inset: -4px;/s);
  const semanticHostClasses = [...mermaidCss.matchAll(/\.([A-Za-z_][\w-]*)/g)]
    .map((match) => match[1]);
  assert.ok(semanticHostClasses.length > 0);
  assert.deepEqual(
    semanticHostClasses.filter((className) => !className.startsWith("r-mermaid-")),
    [],
    "host UI selectors stay inside the r- product namespace, including portal classes",
  );
  assert.doesNotMatch(mermaidCss, /(^|[\s,{])\.mermaid-/m);
  const classLiterals = [...src.matchAll(
    /(?:className|backdropClass|wrapperClassName)=(?:"([^"]*)"|\{`([^`]*)`\})/g,
  )].map((match) => match[1] ?? match[2] ?? "");
  assert.deepEqual(
    classLiterals.filter((value) => /\b(?:sm|md|lg|before|after):|\[[^\]]+\]/.test(value)),
    [],
    "Mermaid TSX keeps responsive, pseudo-element, and arbitrary styling in semantic CSS",
  );
  assert.match(toolbarSrc, /<Tooltip\b/);
  assert.doesNotMatch(toolbarSrc, /<Button[^>]*\btitle=/);
  assert.doesNotMatch(toolbarSrc, /RotateCcw|resetAria/);
  assert.match(toolbarSrc, /<CopyButton[\s\S]*?text=\{code\}[\s\S]*?resetKey=\{code\}/);
  assert.match(toolbarSrc, /useBlobDownload\(\)/);
  assert.doesNotMatch(toolbarSrc, /setTimeout\(/);
  assert.match(toolbarSrc, /DropdownMenuTrigger/);
  assert.match(toolbarSrc, /message\.mermaid\.downloadSource/);
  assert.match(toolbarSrc, /message\.mermaid\.diagram/);
  assert.match(toolbarSrc, /message\.mermaid\.code/);
  assert.match(toolbarSrc, /diagramFilename\(code, "mmd"\)/);
  assert.match(diagramSrc, /data-testid="mermaid-fullscreen"/);
  const fullscreenMarkup = diagramSrc.match(/\{fullscreen && result \? \([\s\S]*?\n      \) : null\}/);
  assert.ok(fullscreenMarkup, "fullscreen markup must remain an explicit render-only branch");
  assert.doesNotMatch(fullscreenMarkup[0], /<MermaidToolbar/, "fullscreen must not expose the inline action toolbar");
  assert.match(fullscreenMarkup[0], /message\.mermaid\.closeFullscreenAria/);
  assert.match(fullscreenMarkup[0], /<MermaidDiagramViewer result=\{result\} zoom=\{fullscreenZoom\} fullscreen \/>/);
  assert.match(viewerSrc, /className=\{`r-mermaid-viewport /);
  assert.match(mermaidCss, /\.r-mermaid-viewport\s*\{[^}]*container-type: size;/s);
  // Both surfaces open with the COMPLETE diagram contain-fitted via container
  // queries (option A). Inline never upscales above natural size; fullscreen
  // explicitly fixes both axes so no h-fit/max-height interaction can crop an
  // extreme ratio. Backdrop click must stay dismissable.
  assert.match(src, /`min\(100cqw, calc\(100cqh \* \$\{result\.width \/ result\.height\}\)\)`/);
  assert.match(src, /`min\(100cqh, calc\(100cqw \* \$\{result\.height \/ result\.width\}\)\)`/);
  assert.match(src, /`min\(100cqw, calc\(100cqh \* \$\{result\.width \/ result\.height\}\), \$\{result\.width\}px\)`/);
  assert.doesNotMatch(viewerSrc, /`max\(min\(100cqw/);
  // Pointer-capture-safe double-click ownership and directional cursor state
  // are shared by inline/fullscreen Mermaid and the image lightbox.
  assert.match(src, /onDoubleClick=\{zoom\.onDoubleClick\}/);
  assert.match(src, /cursor: zoom\.style\.stageCursor/);
  assert.match(zoom, /nextIsZoomed \? "zoom-out" : "zoom-in"/);
  assert.match(zoom, /stageCursor = isDragging \? "grabbing" : isZoomed \? "grab" : "default"/);
  // The diagram viewport and loading placeholder share the uniform
  // responsive height; the code view is natural content height, and the tab
  // switch keeps the card's top pinned via a scroll anchor instead.
  assert.match(
    mermaidCss,
    /\.r-mermaid-diagram__loading,\s*\.r-mermaid-render-error\s*\{[^}]*height: clamp\(320px, 50vh, 560px\);/s,
  );
  assert.match(
    mermaidCss,
    /\.r-mermaid-viewport--inline\s*\{[^}]*height: clamp\(320px, 50vh, 560px\);/s,
  );
  // Tab switches arm the timeline's own preserve-viewport intent (the same
  // mechanism message expand/collapse uses) instead of racing its anchoring.
  assert.match(src, /MessageTimelinePreserveViewportContext/);
  assert.match(src, /preserveTimelineViewport\?\.\(\);/);
  const frameSrc = read("src/components/markdown/mermaid/mermaidFrame.ts");
  assert.match(frameSrc, /overflow:hidden/, "srcdoc must suppress the sub-pixel internal scrollbar");
  assert.match(frameSrc, /max-width:none!important/,
    "settled vector zoom must override Mermaid's inline natural-width clamp");
  assert.doesNotMatch(diagramSrc, /dismissOnBackdrop=\{false\}/);
  assert.match(diagramSrc, /function MermaidRenderError\(\)/);
  assert.match(diagramSrc, /<ImageOff size=\{32\}/);
  assert.match(diagramSrc, /console\.error\("\[Mermaid\] render failed", error\)/);
  assert.doesNotMatch(diagramSrc, /trimMermaidDiagnostic|state\.message|effectiveView/);
  assert.match(diagramSrc, /message\.mermaid\.renderErrorTitle/);
});

test("③ HTML preview body uses the shared primitive — behavior preserved", () => {
  const item = read("src/components/message/attachmentPreviewSurfaces.tsx") + read("src/components/message/MessageItem.tsx");
  assert.match(item, /card-brutal max-w-full overflow-x-clip/, "Markdown attachment preview must not trap sticky toolbars");
  // The frame moved from HtmlAttachmentPreviewModal into HtmlPreviewBody when
  // the comment-mode overlay/bridge wrapped it (task #16, reviewed 702694c8);
  // the pinned isolation contract is unchanged and now lives there.
  const modal = item.match(/function HtmlPreviewBody\([\s\S]*?\n\}\n/);
  assert.ok(modal, "HtmlPreviewBody not found");
  const m = modal[0];
  // Uses the shared primitive, NOT a bare iframe.
  assert.doesNotMatch(m, /<iframe\b/);
  assert.match(m, /<SandboxedPreviewFrame\b/);
  // Every iframe attribute pinned. The appended bridge is now also the
  // hostile-document external-link inventory reporter, so every HTML preview gets its
  // instance/source isolation params; without the appended script they remain
  // inert (reviewed under the #wg-comment:ba106cab security contract):
  assert.match(m, /src=\{buildSrc\(url\)\}/);
  assert.match(m, /sandbox="allow-scripts"/); // exactly — not tightened/loosened
  assert.doesNotMatch(m, /allow-popups(?:-to-escape-sandbox)?/);
  assert.match(m, /referrerPolicy="no-referrer"/);
  assert.match(m, /className=\{`h-full w-full border-0 bg-white\$\{externalLinksReady \? "" : " pointer-events-none"\}`\}/);
  assert.match(m, /title=\{formatMessage\(\{ id: "message\.messageItem\.htmlPreviewTitle" \}, \{ filename \}\)\}/);
  // Threat-model comment retained.
  assert.match(m, /Threat model: any human or agent can upload hostile HTML/);

  // The two sandbox configs are pinned independently so a shared default
  // can't silently drift either callsite (Bugen re-review guard).
  const prim = read("src/components/ui/SandboxedPreviewFrame.tsx");
  assert.match(prim, /sandbox = ""/); // primitive defaults to maximally locked
});

test("④ PDF attachment preview uses the shared primitive — opaque origin, no allow-same-origin", () => {
  const item = read("src/components/message/attachmentPreviewSurfaces.tsx") + read("src/components/message/MessageItem.tsx");
  // The PDF branch must not be a bare iframe — that was the pre-fix shape
  // flagged by react-doctor `iframe-missing-sandbox` (Ark security review,
  // #proj-frontend:8b1098b4).
  const pdfBranch = item.match(/preview\.kind === "pdf" \? \([\s\S]*?\) : null/);
  assert.ok(pdfBranch, "PDF preview branch not found in DocumentAttachmentPreviewModal");
  const m = pdfBranch[0];
  assert.doesNotMatch(m, /<iframe\b/, "PDF preview must not render a bare iframe");
  assert.match(m, /<SandboxedPreviewFrame\b/);
  // allow-scripts only — native PDF viewers need scripts. allow-same-origin
  // would dissolve the origin boundary and is forbidden for attacker-uploaded
  // content (PDF bytes come from any human or agent).
  assert.match(m, /sandbox="allow-scripts"/);
  assert.doesNotMatch(m, /sandbox="[^"]*allow-same-origin[^"]*"/);
  assert.match(m, /referrerPolicy="no-referrer"/);
  assert.match(m, /title=\{formatMessage\(\{ id: "message\.messageItem\.pdfPreviewTitle" \}, \{ filename \}\)\}/);
});

test("shared mermaid renderer is explicitly enabled on message and document surfaces", () => {
  const md = read("src/components/markdown/MarkdownContent.tsx");
  assert.match(md, /enableMermaid\?: boolean/);
  assert.match(md, /getMarkdownComponents\(\s*density: MarkdownDensity,\s*enableMermaid = false,?\s*\)/);
  assert.match(md, /MERMAID_MARKDOWN_COMPONENTS/);
  // pre-slot interception (keeps SVG out of the dark code wrapper).
  assert.match(md, /readMermaidSource\(children\)/);

  const item = read("src/components/message/attachmentPreviewSurfaces.tsx") + read("src/components/message/MessageItem.tsx");
  // Markdown attachment preview opts in.
  assert.match(
    item,
    /<MarkdownContent[\s\S]*source=\{markdown\}[\s\S]*density="document"[\s\S]*enableMermaid[\s\S]*components=\{headingComponents\}[\s\S]*\/>/,
  );
  // Chat message bodies use the same component without opening an inline-SVG
  // escape hatch in the message-specific markdown component overrides.
  const chatBody = item.match(/return \(\s*<MarkdownContent[\s\S]*?rehypePlugins=/);
  assert.ok(chatBody, "chat MarkdownContent callsite not found");
  assert.match(chatBody[0], /density="compact"[\s\S]*enableMermaid/);

  const wiki = read("src/components/wiki/WikiPanel.tsx");
  assert.match(wiki, /<MarkdownContent source=\{markdown\} density="document" enableMermaid/);
  const forwarded = read("src/components/message/ForwardedBundleCard.tsx");
  assert.match(forwarded, /<MarkdownContent source=\{content\} density="compact" enableMermaid/);
  assert.match(forwarded, /max-h-\[144px\] overflow-clip/, "collapsed forwards must clip without becoming a sticky scroll root");
  const comments = read("src/components/message/AttachmentCommentsPanel.tsx");
  assert.match(comments, /<MarkdownContent source=\{c\.content\} density="compact" enableMermaid/);
  const collapsible = read("src/components/message/CollapsibleMessageContent.tsx");
  assert.match(collapsible, /collapsed \? "relative overflow-clip"/, "collapsed messages must clip without trapping sticky toolbars");
});

test("readMermaidSource lives in a standalone pure module (cheap unit guard)", () => {
  const src = read("src/components/markdown/mermaid/mermaidSource.ts");
  assert.match(src, /export function readMermaidSource\(children: ReactNode\): string \| null/);
  // Pure: must not import the renderer or react-markdown (only `react`).
  assert.doesNotMatch(src, /from\s+["'](?:beautiful-mermaid|mermaid)["']/);
  assert.doesNotMatch(src, /import\(["'](?:beautiful-mermaid|mermaid)["']\)/);
  assert.doesNotMatch(src, /from\s+["']react-markdown["']/);
});
