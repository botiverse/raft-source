// An object window's document is drawn by the main window's code with the
// main window's CSS: its stylesheets (<link rel="stylesheet">, <style>, Vite's
// and the libraries' injected ones) are copied into the child's <head> and
// kept in step as the main document adds, changes or removes them, and the
// <html> attributes the CSS keys off (the theme's class and data-*, lang, dir,
// the custom properties in style) and <body>'s classes are mirrored. Only what
// the main document sets is mirrored, and only what was mirrored is removed:
// an attribute or a style property the object window sets on its own <html>
// stays. What is each window's own is never mirrored: the input modality
// (raft-ui's data-input-modality; the store tracks it on the child document,
// installInputModality) and the window's frame, its title bar and the corners
// its window controls take (data-title-bar*, data-fullscreen, the frame insets
// --raft-frame-inset-* and the steady traffic-light corner) and whether a layer
// is open in it (data-raft-layer-open, layerGuard.ts; Kirby on #337 PR3:
// the shell draws each window's controls on that window, so the main window's
// corners are not the object window's; objectWindowChrome.ts sets its own).

/** Placed in the target <head>: the copied stylesheets follow it, in the source's order. */
const STYLES_MARKER = "raft-object-window-styles";
const STYLESHEET_SELECTOR = 'link[rel~="stylesheet"], style';

/**
 * Each window's own: where its own pointer and keyboard went (raft-ui's focus-ring gate), its frame (titleBar.css
 * keys the window controls' corners off these; objectWindowChrome.ts sets them from the object window's own overlay),
 * and whether a layer is open in it (layerGuard's data-raft-layer-open: its title bar stops being a drag region so a
 * press there reaches the layer's outside press; the store runs a guard on each object window's own document).
 */
const OWN_HTML_ATTRIBUTES = new Set(["data-input-modality", "data-title-bar", "data-title-bar-start", "data-title-bar-steady", "data-fullscreen", "data-raft-layer-open"]);

/**
 * Each window's own <html> style properties: the frame insets raft-ui reads (--raft-frame-inset-start / -end / -top)
 * and the traffic lights' steady corner (windowControlsOverlayGeometry STEADY_TITLE_BAR_START_VAR).
 */
export function isOwnHtmlStyleProperty(name: string): boolean {
  return name.startsWith("--raft-frame-inset-") || name === "--raft-desktop-titlebar-start";
}

/** The <html> attributes mirrored: what themes and locales set (style, property by property: mirrorStyle). */
function isMirroredHtmlAttribute(name: string): boolean {
  if (OWN_HTML_ATTRIBUTES.has(name)) return false;
  return name === "class" || name === "lang" || name === "dir" || name.startsWith("data-");
}

/** The properties an inline style declares, with their values and priorities. */
function declarationsOf(style: CSSStyleDeclaration): Map<string, { value: string; priority: string }> {
  const declarations = new Map<string, { value: string; priority: string }>();
  for (let index = 0; index < style.length; index++) {
    const name = style.item(index);
    if (name) declarations.set(name, { value: style.getPropertyValue(name), priority: style.getPropertyPriority(name) });
  }
  return declarations;
}

/**
 * Mirror `source`'s inline style onto `target` property by property, but for the window's own (isOwnHtmlStyleProperty):
 * set what the source declares, remove only what an earlier call mirrored and the source no longer declares, so a
 * property the object window set itself (its own frame insets) stays. Returns the names mirrored now.
 */
function mirrorStyle(source: HTMLElement, target: HTMLElement, mirrored: ReadonlySet<string>): Set<string> {
  const now = new Set<string>();
  for (const [name, { value, priority }] of declarationsOf(source.style)) {
    if (isOwnHtmlStyleProperty(name)) continue;
    now.add(name);
    if (target.style.getPropertyValue(name) !== value || target.style.getPropertyPriority(name) !== priority) target.style.setProperty(name, value, priority);
  }
  for (const name of mirrored) {
    if (!now.has(name)) target.style.removeProperty(name);
  }
  if (target.getAttribute("style") === "") target.removeAttribute("style");
  return now;
}

/**
 * Mirror `source`'s attributes that `keep` selects onto `target`: set what
 * the source has, remove only what an earlier call mirrored and the source no
 * longer has. Returns the names mirrored now, for the next call.
 */
function mirrorAttributes(source: Element, target: Element, mirrored: ReadonlySet<string>, keep: (name: string) => boolean): Set<string> {
  const now = new Set<string>();
  for (const { name, value } of Array.from(source.attributes)) {
    if (!keep(name)) continue;
    now.add(name);
    if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  }
  for (const name of mirrored) {
    if (!now.has(name)) target.removeAttribute(name);
  }
  return now;
}

/** Make a copied stylesheet's attributes its source's. */
function copyAttributes(source: Element, target: Element): void {
  for (const { name } of Array.from(target.attributes)) {
    if (!source.hasAttribute(name)) target.removeAttribute(name);
  }
  for (const { name, value } of Array.from(source.attributes)) {
    if (target.getAttribute(name) !== value) target.setAttribute(name, value);
  }
}

/**
 * Copy `fromDoc`'s stylesheets and the <html> / <body> attributes the CSS
 * reads into `toDoc`, and keep them in step (a MutationObserver on
 * `fromDoc`). Returns the stop.
 */
export function syncStyles(fromDoc: Document, toDoc: Document): () => void {
  const clones = new Map<Element, Element>();
  const marker = toDoc.createComment(STYLES_MARKER);
  toDoc.head.append(marker);
  const adopted = new WeakMap<CSSStyleSheet, CSSStyleSheet>();

  const syncSheets = () => {
    const sources = Array.from(fromDoc.head.querySelectorAll(STYLESHEET_SELECTOR));
    const live = new Set(sources);
    for (const [source, clone] of clones) {
      if (live.has(source)) continue;
      clone.remove();
      clones.delete(source);
    }
    let previous: Node = marker;
    for (const source of sources) {
      let clone = clones.get(source);
      if (!clone) {
        clone = toDoc.importNode(source, true);
        clones.set(source, clone);
      } else {
        copyAttributes(source, clone);
        if (source.localName === "style" && clone.textContent !== source.textContent) clone.textContent = source.textContent;
      }
      // Only a sheet out of place moves (moving a <link> loads it again).
      if (previous.nextSibling !== clone) toDoc.head.insertBefore(clone, previous.nextSibling);
      previous = clone;
    }
    syncAdoptedSheets();
  };

  // Constructed sheets belong to their own document's window: rebuilt from their rules (they change unobserved;
  // each sync rebuilds the list).
  const syncAdoptedSheets = () => {
    const sources = (fromDoc as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets;
    const target = toDoc as Document & { adoptedStyleSheets?: CSSStyleSheet[] };
    const Sheet = (toDoc.defaultView as (Window & { CSSStyleSheet?: typeof CSSStyleSheet }) | null)?.CSSStyleSheet;
    if (!sources || !target.adoptedStyleSheets || !Sheet) return;
    if (sources.length === 0 && target.adoptedStyleSheets.length === 0) return;
    target.adoptedStyleSheets = sources.map((source) => {
      let copy = adopted.get(source);
      if (!copy) {
        copy = new Sheet();
        adopted.set(source, copy);
      }
      try {
        copy.replaceSync(Array.from(source.cssRules, (rule) => rule.cssText).join("\n"));
      } catch {
        // A sheet whose rules cannot be read: left as it was.
      }
      return copy;
    });
  };

  let mirroredHtml = new Set<string>();
  let mirroredStyle = new Set<string>();
  let mirroredBody = new Set<string>();
  const syncHtml = () => {
    mirroredHtml = mirrorAttributes(fromDoc.documentElement, toDoc.documentElement, mirroredHtml, isMirroredHtmlAttribute);
    mirroredStyle = mirrorStyle(fromDoc.documentElement as HTMLElement, toDoc.documentElement as HTMLElement, mirroredStyle);
  };
  const syncBody = () => {
    if (!fromDoc.body || !toDoc.body) return;
    mirroredBody = mirrorAttributes(fromDoc.body, toDoc.body, mirroredBody, (name) => name === "class");
  };

  syncSheets();
  syncHtml();
  syncBody();

  const Observer = fromDoc.defaultView?.MutationObserver ?? MutationObserver;
  const headObserver = new Observer(syncSheets);
  headObserver.observe(fromDoc.head, { childList: true, subtree: true, characterData: true, attributes: true });
  const htmlObserver = new Observer(syncHtml);
  htmlObserver.observe(fromDoc.documentElement, { attributes: true });
  const bodyObserver = new Observer(syncBody);
  if (fromDoc.body) bodyObserver.observe(fromDoc.body, { attributes: true, attributeFilter: ["class"] });

  return () => {
    headObserver.disconnect();
    htmlObserver.disconnect();
    bodyObserver.disconnect();
  };
}
