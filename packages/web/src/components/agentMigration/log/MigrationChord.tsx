import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { select } from "d3-selection";
import { zoom, zoomIdentity, zoomTransform } from "d3-zoom";
import type { ZoomBehavior } from "d3-zoom";
import { ZoomOut } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import type { FocusEvent, KeyboardEvent, MouseEvent, PointerEvent, TouchEvent } from "react";
import { wheelDeltaToZoomFactor } from "../../ImageZoom";
import type { LogNode, NodeId, RouteCell } from "./model";

/**
 * The server's migrations as a directed chord diagram. Each computer is an arc
 * on the ring, sized by its traffic and split into the moves out (solid) and in
 * (outline); each route is a ribbon, wide where it leaves and narrowing to an
 * arrow where it arrives. Three outer rings: out / in, the arrival success rate,
 * and how many agents live there now.
 *
 * The ring is laid out from every move on the server, so a filter only changes
 * which ribbons are lit; the computers never move. With a filter on, the rest
 * stays as a blurred haze behind.
 *
 * Zoom is a pinch (a trackpad's comes as Ctrl + wheel, Safari's as gesture
 * events), Ctrl/⌘ + wheel, or + / − / 0 on the keyboard. A plain wheel or
 * two-finger scroll belongs to the page at 1× (a hint says how to zoom) and pans
 * once zoomed in; a scroll that started on the page keeps scrolling the page when
 * the chart slides under the pointer, until it pauses. A mouse drag pans
 * (d3-zoom). At 1× a single finger is left to the page, so it scrolls past the
 * chart (touch-action: pan-y) and a press and hold on a target opens its menu;
 * once zoomed in, a finger drag pans. Every frame of a gesture only rewrites the
 * view group's transform and a CSS variable that keeps text and strokes at their
 * size (no React render); blur filters are off while a gesture runs and labels
 * re-space and fade once it has settled.
 *
 * Hover is held back a little: a card shows once the pointer rests on a target,
 * moves straight to the next one once showing, and outlives a short trip across
 * a gap, so a sweep over dense ribbons doesn't flash through each of them. A
 * gesture drops it until the pointer moves again.
 *
 * The chart is one tab stop, a listbox of its computers and routes: arrow keys
 * walk the computers in ring order, then the routes, and the item is announced
 * through aria-activedescendant. Enter opens its details, the ContextMenu key
 * or Shift+F10 its menu.
 *
 * Hand-built SVG: raft-ui has no chart part (named in the PR).
 */

export type ChordView = { k: number; x: number; y: number; moving: boolean };

export type ChordTarget = { kind: "computer"; id: NodeId } | { kind: "route"; src: NodeId; dst: NodeId };

/**
 * hover: the pointer (or the keyboard's active item) is over a target (null: empty space or gone);
 * press: a click, tap, Enter or Space (null: on empty space);
 * down: a pointer went down, so a right-click acts on this target (null: on empty space);
 * menu: a right-click on a target;
 * actions: press and hold on a touch screen, or the ContextMenu key / Shift+F10: open the target's
 *   menu at (clientX, clientY).
 * x and y are relative to the chart.
 */
export type ChordEvent = {
  type: "hover" | "press" | "down" | "menu" | "actions";
  x: number;
  y: number;
  clientX?: number;
  clientY?: number;
  keyboard?: boolean;
  pointerType?: string;
};

type Pt = [number, number];
const pointerAt = (e: MouseEvent | PointerEvent) => {
  const box = (e.currentTarget as Element).closest("svg")!.getBoundingClientRect();
  return { x: e.clientX - box.left, y: e.clientY - box.top, clientX: e.clientX, clientY: e.clientY };
};
const GAP = 0.016;
const GROUP_GAP = 0.07;
/** Press and hold: how long, and how far the finger may wander meanwhile. */
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP = 8;
const MAX_ZOOM = 4;
/** Hover intent: rest this long before a card shows; a card outlives a gap this long. */
const HOVER_SHOW_MS = 80;
const HOVER_HIDE_MS = 120;
/** A wheel sequence (a scroll and its momentum) ends after this much quiet. */
const WHEEL_QUIET_MS = 300;
/** A gesture settles (labels re-space, blur returns) after this much quiet. */
const SETTLE_MS = 180;
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
/** A wheel delta in pixels, whatever unit the device reports it in. */
const wheelPx = (d: number, mode: number, page: number) => (mode === 1 ? d * 16 : mode === 2 ? d * page : d);
const vol = (c: RouteCell) => c.ok + c.failed;
const key = (c: { src: string; dst: string }) => `${c.src}>${c.dst}`;
const itemKey = (t: ChordTarget) => (t.kind === "computer" ? `c:${t.id}` : `r:${key(t)}`);

export function MigrationChord({
  size,
  nodes,
  allCells,
  cells,
  filtered,
  residents,
  highlight,
  numbered,
  labels,
  onTarget,
  onView,
}: {
  size: number;
  nodes: LogNode[];
  /** Every route on the server: lays out the ring and draws the haze behind a filter. */
  allCells: RouteCell[];
  /** The routes that pass the filters. */
  cells: RouteCell[];
  filtered: boolean;
  residents: Map<NodeId, number>;
  /** Keep only these routes lit (hover, a tapped item, a selected agent); null: all. */
  highlight: Set<string> | null;
  /** One agent's completed moves in order, numbered at their arrows. */
  numbered: Array<{ src: NodeId; dst: NodeId }>;
  labels: { chart: string; computer: (node: LogNode, out: number, inn: number) => string; route: (src: LogNode, dst: LogNode, cell: RouteCell) => string };
  onTarget: (target: ChordTarget | null, event: ChordEvent) => void;
  /** The zoom: when a gesture starts (moving) and once it has settled. x and y translate, k scales. */
  onView?: (view: ChordView) => void;
}) {
  const uid = useId(), blurId = `${uid}blur`, blurSmId = `${uid}blursm`;
  const compact = size < 520;
  const C: Pt = [size / 2, size / 2];
  const R = size / 2 - (compact ? 70 : 118);
  const R2 = R - 6;
  // The three rings outside the arcs: thickness and gap, and the outermost edge.
  const t = compact ? 12 : 18, g = compact ? 4 : 6;
  const ringOuter = R + 10 + 2 * g + 2 * t;
  const labelSize = compact ? 9 : 12;
  // Labels clear the outermost ring by a gap; at the top and bottom of the ring a
  // centred label is pushed out by half its height as well.
  const labelGap = compact ? 6 : 10;
  const polar = (a: number, r: number): Pt => [C[0] + Math.cos(a) * r, C[1] + Math.sin(a) * r];
  const arcPath = (a0: number, a1: number, r0: number, r1: number) => {
    const [p0, p1, p2, p3] = [polar(a0, r1), polar(a1, r1), polar(a1, r0), polar(a0, r0)], big = a1 - a0 > Math.PI ? 1 : 0;
    return `M${p0} A${r1},${r1} 0 ${big} 1 ${p1} L${p2} A${r0},${r0} 0 ${big} 0 ${p3} Z`;
  };

  // Only computers with a drawn move take a place on the ring: one that never
  // moved an agent would be a sliver whose label collides with its neighbours.
  const [zoomK, setZoomK] = useState(1);
  const zoomKRef = useRef(1);
  const ringNodes = useMemo(() => {
    const busy = new Set(allCells.flatMap((c) => [c.src, c.dst]));
    return nodes.filter((n) => busy.has(n.id));
  }, [nodes, allCells]);
  const layout = useMemo(() => {
    const out = new Map<NodeId, number>(), inn = new Map<NodeId, number>();
    for (const c of allCells) { out.set(c.src, (out.get(c.src) ?? 0) + vol(c)); inn.set(c.dst, (inn.get(c.dst) ?? 0) + vol(c)); }
    const groups = [...new Set(ringNodes.map((n) => n.group))];
    // A computer with no drawn route still gets a sliver so it keeps its place.
    const weight = (n: LogNode) => Math.max(0.5, (out.get(n.id) ?? 0) + (inn.get(n.id) ?? 0));
    const total = ringNodes.reduce((a, n) => a + weight(n), 0) || 1;
    const k = (Math.PI * 2 - GAP * ringNodes.length - GROUP_GAP * groups.length) / total;
    const span = new Map<NodeId, { a0: number; split: number; a1: number }>();
    let a = -Math.PI / 2;
    for (const gr of groups) {
      for (const n of ringNodes.filter((x) => x.group === gr)) {
        const w = weight(n) * k, o = ((out.get(n.id) ?? 0) / weight(n)) * w;
        span.set(n.id, { a0: a, split: a + o, a1: a + w });
        a += w + GAP;
      }
      a += GROUP_GAP;
    }
    return { span, k, out, inn };
  }, [allCells, ringNodes]);

  // Ribbon ends: outgoing ribbons share the computer's "out" part, incoming its "in" part.
  const geometry = (list: RouteCell[]) => {
    const order = new Map(ringNodes.map((n, i) => [n.id, i]));
    const outCur = new Map(ringNodes.map((n) => [n.id, layout.span.get(n.id)!.a0]));
    const inCur = new Map(ringNodes.map((n) => [n.id, layout.span.get(n.id)!.split]));
    const geo = new Map<string, { s: [number, number]; d: [number, number] }>();
    for (const c of [...list].sort((x, y) => order.get(x.dst)! - order.get(y.dst)!)) {
      const s = outCur.get(c.src)!; outCur.set(c.src, s + vol(c) * layout.k); geo.set(key(c), { s: [s, s + vol(c) * layout.k], d: [0, 0] });
    }
    for (const c of [...list].sort((x, y) => order.get(x.src)! - order.get(y.src)!)) {
      const s = inCur.get(c.dst)!; inCur.set(c.dst, s + vol(c) * layout.k); geo.get(key(c))!.d = [s, s + vol(c) * layout.k];
    }
    return geo;
  };
  const geo = useMemo(() => geometry(cells), [cells, layout]); // eslint-disable-line react-hooks/exhaustive-deps
  const bgGeo = useMemo(() => (filtered ? geometry(allCells) : null), [filtered, allCells, layout]); // eslint-disable-line react-hooks/exhaustive-deps

  const ribbonPath = (gm: { s: [number, number]; d: [number, number] }) => {
    const [s0, s1] = gm.s, [d0, d1] = gm.d, dm = (d0 + d1) / 2, half = Math.min((d1 - d0) / 2, 0.02);
    return `M${polar(s0, R2)} A${R2},${R2} 0 0 1 ${polar(s1, R2)} Q${C} ${polar(dm - half, R2 - 16)} L${polar(dm, R2 - 2)} L${polar(dm + half, R2 - 16)} Q${C} ${polar(s0, R2)} Z`;
  };
  const labelAt = (mid: number): { x: number; y: number; anchor: "start" | "middle" | "end" } => {
    const cs = Math.cos(mid), sn = Math.sin(mid);
    const anchor = Math.abs(cs) < 0.3 ? "middle" : cs > 0 ? "start" : "end";
    const r = ringOuter + labelGap + (anchor === "middle" ? labelSize * 0.5 : Math.abs(sn) * labelSize * 0.35);
    const [x, y] = polar(mid, r);
    // Vertically centred on the point (a cap height is about 0.7em).
    return { x, y: y + labelSize * 0.35, anchor };
  };
  const touched = useMemo(() => new Set(cells.flatMap((c) => [c.src, c.dst])), [cells]);
  // Labels give way when computers sit close on the ring: busier ones are drawn
  // first, and a label closer than one label width to a drawn one is left out
  // (its arc still carries the name in its accessible label and its card).
  const labelled = useMemo(() => {
    const labelR = (ringOuter + labelGap) * zoomK, minGap = compact ? 26 : 34;
    const drawn: number[] = [];
    const keep = new Set<NodeId>();
    const traffic = (id: NodeId) => (layout.out.get(id) ?? 0) + (layout.inn.get(id) ?? 0);
    for (const n of [...ringNodes].sort((a, b) => traffic(b.id) - traffic(a.id))) {
      const { a0, a1 } = layout.span.get(n.id)!, mid = (a0 + a1) / 2;
      const near = drawn.some((m) => { let d = Math.abs(m - mid) % (Math.PI * 2); if (d > Math.PI) d = Math.PI * 2 - d; return d * labelR < minGap; });
      if (!near) { drawn.push(mid); keep.add(n.id); }
    }
    return keep;
  }, [ringNodes, layout, ringOuter, labelGap, compact, zoomK]);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const maxResidents = Math.max(1, ...residents.values());

  // The keyboard walks the lit computers in ring order, then the drawn routes.
  const items = useMemo<ChordTarget[]>(() => {
    const order = new Map(ringNodes.map((n, i) => [n.id, i]));
    return [
      ...ringNodes.filter((n) => !filtered || touched.has(n.id)).map((n): ChordTarget => ({ kind: "computer", id: n.id })),
      ...[...cells].sort((a, b) => order.get(a.src)! - order.get(b.src)! || order.get(a.dst)! - order.get(b.dst)!)
        .map((c): ChordTarget => ({ kind: "route", src: c.src, dst: c.dst })),
    ];
  }, [ringNodes, cells, filtered, touched]);
  const elementId = useCallback((target: ChordTarget) => `${uid}${itemKey(target).replace(/[^\w-]/g, "_")}`, [uid]);
  const [active, setActive] = useState<string | null>(null);
  const activeItem = items.find((x) => itemKey(x) === active) ?? null;

  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef<SVGGElement>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const placeOf = useCallback((target: ChordTarget) => {
    const el = document.getElementById(elementId(target)), svg = svgRef.current;
    if (!el || !svg) return { x: 0, y: 0, clientX: 0, clientY: 0 };
    const box = el.getBoundingClientRect(), frame = svg.getBoundingClientRect();
    const clientX = box.left + box.width / 2, clientY = box.top + box.height / 2;
    return { x: clientX - frame.left, y: clientY - frame.top, clientX, clientY };
  }, [elementId]);

  // Press and hold on a touch screen. The browser keeps a vertical drag for
  // scrolling (pointercancel) and a moved finger cancels; the click that
  // follows a hold is swallowed so it doesn't also open the details.
  const hold = useRef<{ timer: number; x: number; y: number; target: ChordTarget } | null>(null);
  const swallowClick = useRef(false);
  const lastPointer = useRef("");
  const menuKeyAt = useRef(0);
  const cancelHold = useCallback(() => {
    if (hold.current) window.clearTimeout(hold.current.timer);
    hold.current = null;
  }, []);
  useEffect(() => cancelHold, [cancelHold]);
  const openActionsFromHold = useCallback(() => {
    const h = hold.current;
    if (!h) return;
    cancelHold();
    swallowClick.current = true;
    const frame = svgRef.current?.getBoundingClientRect();
    onTarget(h.target, { type: "actions", x: h.x - (frame?.left ?? 0), y: h.y - (frame?.top ?? 0), clientX: h.x, clientY: h.y, pointerType: "touch" });
  }, [cancelHold, onTarget]);

  // Hover intent (see the top): one pending show or hide at a time, and at most one update a frame.
  const hoverIntent = useRef({ shown: false, timer: 0, frame: 0, suppressed: false });
  const settleHover = useCallback(() => {
    const h = hoverIntent.current;
    window.clearTimeout(h.timer);
    window.cancelAnimationFrame(h.frame);
  }, []);
  useEffect(() => settleHover, [settleHover]);
  const emitHover = useCallback((target: ChordTarget | null, at: Omit<ChordEvent, "type">) => {
    hoverIntent.current.shown = Boolean(target);
    onTarget(target, { type: "hover", ...at });
  }, [onTarget]);
  const intendHover = useCallback((target: ChordTarget | null, at: Omit<ChordEvent, "type">) => {
    const h = hoverIntent.current;
    if (h.suppressed) return;
    settleHover();
    if (target && h.shown) h.frame = window.requestAnimationFrame(() => emitHover(target, at));
    else if (target) h.timer = window.setTimeout(() => emitHover(target, at), HOVER_SHOW_MS);
    else if (h.shown) h.timer = window.setTimeout(() => emitHover(null, at), HOVER_HIDE_MS);
  }, [emitHover, settleHover]);
  // A gesture drops the hover (the card would no longer sit by what it describes) until the pointer moves again.
  const suppressHover = useCallback(() => {
    const h = hoverIntent.current;
    settleHover();
    h.suppressed = true;
    if (h.shown) emitHover(null, { x: 0, y: 0 });
  }, [emitHover, settleHover]);
  const targetByKey = useMemo(() => new Map<string, ChordTarget>([
    ...ringNodes.map((n): [string, ChordTarget] => [itemKey({ kind: "computer", id: n.id }), { kind: "computer", id: n.id }]),
    ...cells.map((c): [string, ChordTarget] => [itemKey({ kind: "route", src: c.src, dst: c.dst }), { kind: "route", src: c.src, dst: c.dst }]),
  ]), [ringNodes, cells]);

  const fire = (target: ChordTarget | null, type: ChordEvent["type"]) => (e: MouseEvent | PointerEvent) => {
    if (type === "hover") { intendHover(target, pointerAt(e)); return; }
    if (type === "press" && swallowClick.current) {
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (type === "press" && target) setActive(itemKey(target));
    const pointerType = (e.nativeEvent as globalThis.PointerEvent).pointerType;
    onTarget(target, { type, ...pointerAt(e), pointerType });
  };
  const onTargetDown = (target: ChordTarget) => (e: PointerEvent) => {
    fire(target, "down")(e);
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    cancelHold();
    hold.current = { x: e.clientX, y: e.clientY, target, timer: window.setTimeout(openActionsFromHold, LONG_PRESS_MS) };
  };
  const onSvgPointerDown = useCallback((e: PointerEvent) => {
    lastPointer.current = e.pointerType;
    swallowClick.current = false;
    if (!e.isPrimary) cancelHold(); // a second finger: a pinch, not a hold
  }, [cancelHold]);
  const onSvgPointerMove = useCallback((e: PointerEvent) => {
    const h = hold.current;
    if (h && Math.hypot(e.clientX - h.x, e.clientY - h.y) > LONG_PRESS_SLOP) cancelHold();
    // The first move after a gesture brings the hover back, on whatever is under the pointer now
    // (no pointerenter fires for it: the pointer never left).
    if (hoverIntent.current.suppressed && e.pointerType === "mouse" && !e.buttons) {
      hoverIntent.current.suppressed = false;
      const under = (e.target as Element).closest("[data-target]")?.getAttribute("data-target");
      intendHover((under ? targetByKey.get(under) : null) ?? null, pointerAt(e));
    }
  }, [cancelHold, intendHover, targetByKey]);
  // The ContextMenu (right-click) around the chart listens for touches too; on a
  // touch screen the hold above opens the menu, so the touch stops here.
  const stopTouch = useCallback((e: TouchEvent) => e.stopPropagation(), []);
  // The finger lifting after a hold: no emulated mousedown and click follow, so
  // the menu that just opened isn't closed as an outside press.
  const endTouch = useCallback((e: TouchEvent) => {
    e.stopPropagation();
    if (swallowClick.current && e.cancelable) e.preventDefault();
  }, []);
  const onSvgContextMenu = useCallback((e: MouseEvent) => {
    const fromKeyboard = (e.nativeEvent as globalThis.PointerEvent).pointerType === "" || Date.now() - menuKeyAt.current < 400;
    // A browser that turns a hold into a contextmenu (Chrome on Android) opens our menu, once.
    if (lastPointer.current === "touch" || fromKeyboard) {
      e.preventDefault();
      e.stopPropagation();
      if (!fromKeyboard) openActionsFromHold();
    }
  }, [openActionsFromHold]);

  // Empty space: hovering it clears the hover, pressing it closes what is open and drops a stale menu target.
  const onEmptyHover = useCallback((e: PointerEvent) => intendHover(null, pointerAt(e)), [intendHover]);
  const onEmptyDown = useCallback((e: PointerEvent) => onTarget(null, { type: "down", ...pointerAt(e), pointerType: e.pointerType }), [onTarget]);
  const onEmptyPress = useCallback((e: MouseEvent) => {
    if (swallowClick.current) { swallowClick.current = false; return; }
    onTarget(null, { type: "press", ...pointerAt(e) });
  }, [onTarget]);
  const onLeave = useCallback(() => { cancelHold(); intendHover(null, { x: 0, y: 0 }); }, [intendHover, cancelHold]);

  // One tab stop: the chart holds focus and the arrow keys move the active item.
  const keyboardHover = useRef(false);
  const showActive = (target: ChordTarget) => {
    setActive(itemKey(target));
    keyboardHover.current = true;
    settleHover();
    emitHover(target, { keyboard: true, ...placeOf(target) });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const svg = svgRef.current, behavior = zoomRef.current;
    if (svg && behavior && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const by = e.key === "+" || e.key === "=" ? 1.5 : e.key === "-" || e.key === "_" ? 1 / 1.5 : null;
      if (by) { e.preventDefault(); behavior.scaleBy(select(svg), by); return; }
      if (e.key === "0") { e.preventDefault(); resetZoom(); return; }
    }
    if (!items.length) return;
    const i = activeItem ? items.indexOf(activeItem) : -1;
    const step = (j: number) => { e.preventDefault(); showActive(items[(j + items.length) % items.length]); };
    switch (e.key) {
      case "ArrowRight": case "ArrowDown": step(i + 1); return;
      case "ArrowLeft": case "ArrowUp": step(i < 0 ? items.length - 1 : i - 1); return;
      case "Home": step(0); return;
      case "End": step(items.length - 1); return;
    }
    const target = activeItem ?? items[0];
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setActive(itemKey(target));
      onTarget(target, { type: "press", keyboard: true, ...placeOf(target) });
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      menuKeyAt.current = Date.now();
      setActive(itemKey(target));
      onTarget(target, { type: "actions", keyboard: true, ...placeOf(target) });
    } else if (e.key === "Escape" && keyboardHover.current) {
      keyboardHover.current = false;
      emitHover(null, { x: 0, y: 0 });
    }
  };
  const onFocus = useCallback((e: FocusEvent) => {
    if (e.target === e.currentTarget && !activeItem && items.length) setActive(itemKey(items[0]));
  }, [activeItem, items]);
  const onBlur = useCallback(() => {
    if (!keyboardHover.current) return;
    keyboardHover.current = false;
    emitHover(null, { x: 0, y: 0 });
  }, [emitHover]);

  const { formatMessage } = useIntl();
  // At 1×, a plain wheel over the chart scrolls the page; a hint says how to zoom (shown straight on the DOM).
  const hintRef = useRef<HTMLDivElement>(null);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  useEffect(() => {
    const svg = svgRef.current, view = viewRef.current;
    if (!svg || !view) return;
    const selection = select(svg);
    let moving = false, settleTimer = 0, hintTimer = 0;
    const settle = () => {
      moving = false;
      delete svg.dataset.zooming;
      const t = zoomTransform(svg), k = Math.round(t.k * 100) / 100;
      zoomKRef.current = k;
      // touch-action follows the zoom at once: pan-y at 1×, none when zoomed in.
      if (k > 1) svg.dataset.zoomed = ""; else delete svg.dataset.zoomed;
      setZoomK(k);
      onViewRef.current?.({ k: t.k, x: t.x, y: t.y, moving: false });
    };
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, MAX_ZOOM])
      .extent([[0, 0], [size, size]])
      .translateExtent([[0, 0], [size, size]])
      .clickDistance(4)
      // At 1× one finger belongs to the page (scroll, tap, press and hold); two
      // fingers pinch. Zoomed in, one finger pans. A mouse drags to pan; the
      // wheel is handled below, not by d3.
      .filter((event: globalThis.Event) => {
        if (event.type === "wheel") return false;
        if (event.type.startsWith("touch")) return (event as globalThis.TouchEvent).touches.length >= 2 || zoomKRef.current > 1;
        const m = event as globalThis.MouseEvent;
        return !m.ctrlKey && !m.button;
      })
      .on("start", (event) => {
        if (event.sourceEvent?.type === "mousedown" && zoomKRef.current > 1) svg.dataset.dragging = "";
      })
      .on("zoom", (event) => {
        // The first frame that moves anything (a press that never moves is a click, not a gesture).
        if (!moving) {
          moving = true;
          svg.dataset.zooming = "";
          cancelHold();
          suppressHover();
          const t = event.transform;
          onViewRef.current?.({ k: t.k, x: t.x, y: t.y, moving: true });
        }
        window.clearTimeout(settleTimer);
        view.setAttribute("transform", event.transform.toString());
        svg.style.setProperty("--chord-k", String(event.transform.k));
      })
      .on("end", () => {
        delete svg.dataset.dragging;
        if (moving) { window.clearTimeout(settleTimer); settleTimer = window.setTimeout(settle, SETTLE_MS); }
      });
    zoomRef.current = behavior;
    selection.call(behavior).on("dblclick.zoom", null);

    // Which surface a wheel sequence (a scroll and its momentum) belongs to, decided when it
    // starts: a scroll that began on the page keeps the page when the chart slides under the pointer.
    let wheelOwner: "chart" | "page" = "page", lastWheel = 0;
    const onAnyWheel = (e: globalThis.WheelEvent) => {
      if (e.timeStamp - lastWheel > WHEEL_QUIET_MS) wheelOwner = e.target instanceof Node && svg.contains(e.target) ? "chart" : "page";
      lastWheel = e.timeStamp;
    };
    let gestureK: number | null = null;
    const onWheel = (e: globalThis.WheelEvent) => {
      if (wheelOwner === "page") return;
      const frame = svg.getBoundingClientRect(), p: [number, number] = [e.clientX - frame.left, e.clientY - frame.top];
      const t = zoomTransform(svg);
      if (e.ctrlKey || e.metaKey) {
        // A pinch (Chrome, Edge and Firefox send a trackpad pinch as Ctrl + wheel) or Ctrl/⌘ + a mouse wheel.
        // Never left to the browser, which would zoom the whole page, even at the zoom limit.
        e.preventDefault();
        if (gestureK !== null) return;
        // The same step as image and diagram zoom.
        behavior.scaleTo(selection, t.k * wheelDeltaToZoomFactor(e.deltaY, e.deltaMode, true), p);
        return;
      }
      if (t.k > 1) {
        // Zoomed in: a two-finger scroll or a wheel pans, both ways (Shift + wheel goes sideways).
        e.preventDefault();
        const dx = wheelPx(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX, e.deltaMode, size);
        const dy = e.shiftKey && !e.deltaX ? 0 : wheelPx(e.deltaY, e.deltaMode, size);
        behavior.translateBy(selection, -dx / t.k, -dy / t.k);
        return;
      }
      // At 1× the page scrolls on; say how to zoom instead.
      if (!e.deltaY && !e.deltaX) return;
      const hint = hintRef.current;
      if (!hint) return;
      hint.dataset.shown = "";
      window.clearTimeout(hintTimer);
      hintTimer = window.setTimeout(() => delete hint.dataset.shown, 1600);
    };
    // Safari sends a trackpad pinch as gesture events (no Ctrl + wheel).
    type GestureEvent = globalThis.UIEvent & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: globalThis.Event) => { e.preventDefault(); gestureK = zoomTransform(svg).k; };
    const onGestureChange = (e: globalThis.Event) => {
      e.preventDefault();
      if (gestureK === null) return;
      const g = e as GestureEvent, frame = svg.getBoundingClientRect();
      behavior.scaleTo(selection, gestureK * g.scale, [g.clientX - frame.left, g.clientY - frame.top]);
    };
    const onGestureEnd = (e: globalThis.Event) => { e.preventDefault(); gestureK = null; };
    // Zoomed in, d3 takes the touches and stops them before React's endTouch sees the finger lift
    // after a hold, so the emulated click that would close the menu is stopped here, ahead of d3.
    const onTouchEndCapture = (e: globalThis.TouchEvent) => { if (swallowClick.current && e.cancelable) e.preventDefault(); };
    // oxlint-disable-next-line react-doctor/client-passive-event-listeners -- it cancels the emulated click; a finger lifting doesn't scroll
    svg.addEventListener("touchend", onTouchEndCapture, { capture: true, passive: false });
    window.addEventListener("wheel", onAnyWheel, { capture: true, passive: true });
    // oxlint-disable-next-line react-doctor/client-passive-event-listeners -- a pinch must be kept from zooming the whole page, and a zoomed-in scroll pans
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("gesturestart", onGestureStart);
    svg.addEventListener("gesturechange", onGestureChange);
    svg.addEventListener("gestureend", onGestureEnd);
    return () => {
      selection.on(".zoom", null);
      svg.removeEventListener("touchend", onTouchEndCapture, { capture: true });
      window.removeEventListener("wheel", onAnyWheel, { capture: true });
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("gesturestart", onGestureStart);
      svg.removeEventListener("gesturechange", onGestureChange);
      svg.removeEventListener("gestureend", onGestureEnd);
      window.clearTimeout(settleTimer);
      window.clearTimeout(hintTimer);
    };
  }, [size, cancelHold, suppressHover]);
  const resetZoom = useCallback(() => {
    const svg = svgRef.current;
    if (svg && zoomRef.current) select(svg).call(zoomRef.current.transform, zoomIdentity);
  }, []);

  const focusClass = (target: ChordTarget) => (activeItem && itemKey(activeItem) === itemKey(target) ? "" : undefined);

  return (
    <div className="relative">
    {zoomK > 1 ? (
      <Button variant="ghost" size="icon-md" className="absolute right-0 top-0 z-control" aria-label={formatMessage({ id: "agent.migrationLog.resetZoom" })} onClick={resetZoom} data-testid="migration-log-reset-zoom">
        <ZoomOut />
      </Button>
    ) : null}
    <div ref={hintRef} className="migration-chord-hint pointer-events-none absolute inset-x-0 top-3 z-float flex justify-center" aria-hidden data-testid="migration-log-zoom-hint">
      <div className="rounded-lg bg-layer-popover px-3 py-1.5 text-footnote text-foreground shadow-float">
        {formatMessage({ id: "agent.migrationLog.zoomHint" }, { key: IS_MAC ? "⌘" : "Ctrl" })}
      </div>
    </div>
    <svg
      ref={svgRef}
      width={size}
      height={size}
      role="listbox"
      aria-label={labels.chart}
      aria-activedescendant={activeItem ? elementId(activeItem) : undefined}
      tabIndex={0}
      className="migration-chord block select-none"
      data-zoomed={zoomK > 1 ? "" : undefined}
      onPointerLeave={onLeave}
      onPointerDownCapture={onSvgPointerDown}
      onPointerMove={onSvgPointerMove}
      onPointerUp={cancelHold}
      onPointerCancel={cancelHold}
      onTouchStart={stopTouch}
      onTouchEnd={endTouch}
      onContextMenu={onSvgContextMenu}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      data-testid="migration-log-chart"
    >
      <defs>
        <filter id={blurId} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation={compact ? 2.5 : 3.5} /></filter>
        <filter id={blurSmId} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation={1.2} /></filter>
      </defs>
      <g ref={viewRef}>
      {/* Empty space, under everything else. */}
      <rect width={size} height={size} className="fill-transparent" aria-hidden onPointerEnter={onEmptyHover} onPointerDown={onEmptyDown} onClick={onEmptyPress} />
      {bgGeo ? (
        <g filter={`url(#${blurId})`} opacity={0.28} aria-hidden>
          {allCells.map((c) => <path key={`bg${key(c)}`} d={ribbonPath(bgGeo.get(key(c))!)} className="fill-foreground" />)}
        </g>
      ) : null}
      {[...cells].sort((a, b) => vol(a) - vol(b)).map((c) => {
        const lit = !highlight || highlight.has(key(c));
        const failing = c.failed / vol(c) >= 0.5;
        const target: ChordTarget = { kind: "route", src: c.src, dst: c.dst };
        return (
          <path
            key={key(c)}
            id={elementId(target)}
            data-target={itemKey(target)}
            d={ribbonPath(geo.get(key(c))!)}
            className={`migration-chord-ribbon ${failing ? "migration-chord-fail" : "fill-foreground"}`}
            data-selected={highlight && lit ? "" : undefined}
            data-active={focusClass(target)}
            opacity={!lit ? 0.12 : highlight ? 0.95 : filtered ? 0.8 : 0.6 * (0.4 + 0.6 * Math.min(1, vol(c) / 4))}
            role="option"
            aria-selected={focusClass(target) != null}
            aria-label={labels.route(byId.get(c.src)!, byId.get(c.dst)!, c)}
            onPointerEnter={fire(target, "hover")}
            onPointerDown={onTargetDown(target)}
            onClick={fire(target, "press")}
            onContextMenu={fire(target, "menu")}
          />
        );
      })}
      {numbered.map((leg, i) => {
        const gm = geo.get(key(leg)); if (!gm) return null;
        const prior = numbered.slice(0, i).filter((x) => x.dst === leg.dst).length;
        const [x, y] = polar((gm.d[0] + gm.d[1]) / 2 - prior * 0.13, R2 - 30 - prior * 26);
        return (
          <g key={`n${i}`} className="migration-chord-fixed" aria-hidden>
            <circle cx={x} cy={y} r={9} className="fill-layer-card stroke-foreground" />
            <text x={x} y={y + 4} textAnchor="middle" className="fill-foreground font-mono" style={{ fontSize: 11 }}>{i + 1}</text>
          </g>
        );
      })}
      {ringNodes.map((n) => {
        const { a0, split, a1 } = layout.span.get(n.id)!, mid = (a0 + a1) / 2;
        const on = touched.has(n.id) || !filtered;
        const ins = cells.filter((c) => c.dst === n.id), inTotal = ins.reduce((x, c) => x + vol(c), 0);
        const rate = inTotal ? ins.reduce((x, c) => x + c.ok, 0) / inTotal : null;
        const res = residents.get(n.id) ?? 0;
        const label = labelAt(mid);
        const target: ChordTarget = { kind: "computer", id: n.id };
        return (
          <g
            key={n.id}
            id={elementId(target)}
            data-target={itemKey(target)}
            opacity={on ? 1 : 0.4}
            filter={on ? undefined : `url(#${blurSmId})`}
            role="option"
            aria-selected={focusClass(target) != null}
            aria-label={labels.computer(n, layout.out.get(n.id) ?? 0, layout.inn.get(n.id) ?? 0)}
            data-active={focusClass(target)}
            className="migration-chord-computer"
            onPointerEnter={fire(target, "hover")}
            onPointerDown={onTargetDown(target)}
            onClick={fire(target, "press")}
            onContextMenu={fire(target, "menu")}
          >
            {/* the whole arc band is the hit area */}
            <path d={arcPath(a0, a1, R, ringOuter)} className="migration-chord-hit fill-transparent" />
            {split > a0 ? <path d={arcPath(a0, split, R, R + 10)} className="fill-foreground" /> : null}
            {a1 > split ? <path d={arcPath(split, a1, R, R + 10)} className="fill-none stroke-foreground" strokeWidth={1.5} /> : null}
            <path d={arcPath(a0, a1, R + 10 + g, R + 10 + g + t)} className="fill-fill-muted" />
            {rate !== null ? <path d={arcPath(a0, a1, R + 10 + g, R + 10 + g + t * rate)} className={rate < 0.6 ? "migration-chord-fail" : "fill-success"} /> : null}
            {res ? <path d={arcPath(a0, a1, R + 10 + 2 * g + t, R + 10 + 2 * g + t + (res / maxResidents) * t)} className="fill-foreground" opacity={0.7} /> : null}
            {/* Always drawn, so a label that gives way or comes back fades. */}
            <text x={label.x} y={label.y} textAnchor={label.anchor} className="migration-chord-label migration-chord-fixed fill-foreground font-mono font-bold" style={{ fontSize: labelSize }} data-hidden={labelled.has(n.id) || touched.has(n.id) && filtered ? undefined : ""} aria-hidden>{n.code}</text>
          </g>
        );
      })}
      </g>
    </svg>
    </div>
  );
}

export const routeKey = key;
