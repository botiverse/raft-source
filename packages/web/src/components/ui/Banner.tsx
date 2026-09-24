import { AlertTriangle, CircleAlert, Info, CheckCircle2 } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

/**
 * Canonical inline banner / callout / alert primitive.
 *
 * Replaces the dominant inline pattern across the app:
 *
 *     <div className="border-2 border-black bg-brutal-orange/20 p-3">
 *       <AlertTriangle size={18} ... />
 *       <p>...</p>
 *     </div>
 *
 * which appears 40+ times across SettingsPanel, ConfirmDialog,
 * SOSDialog, ResetAgentDialog, MachineDetailPanel, auth pages,
 * dialogs, etc. — frequently with the *wrong* color (e.g. orange
 * for a destructive irreversible op, or red for a generic form
 * validation failure).
 *
 * stdrc 2026-05-10 #wg-theme:6ea9dbee assigned this to @Wug as
 * Tier 1 follow-up after PanelHeader (PR #1535) / AvatarSlot
 * (PR #1544). Same pattern: shared component, intent-driven
 * tokens, kill the inline className drift.
 *
 * **Intent → token** mapping locks in CLAUDE.md color semantics
 * (see "Color Semantics & Brutal Palette" section):
 *
 *   destructive  → bg-brutal-red/20    (irreversible delete / stop)
 *   warning      → bg-brutal-orange/20 (validation / form error / non-destructive)
 *   info         → bg-soft-signal/30 (notice / plan limit / waiting state)
 *   success      → bg-brutal-lime/20   (positive confirmation, e.g. saved)
 *
 * Callsites pass `intent`; the component picks the right surface
 * color. By default banners render WITHOUT an icon — this matches
 * the dominant inline pattern (auth errors, settings form errors,
 * orphaned-workspace notice, ~25 of the audited 42 callsites). For
 * the heavier "warning panel" surfaces (ConfirmDialog, SOSDialog,
 * MachineDetailPanel cannot-delete, ResetAgentDialog full-reset)
 * pass `icon` explicitly.
 *
 * **Why intent (not raw color)?**
 *   - CLAUDE.md repeatedly emphasizes that destructive vs.
 *     warning vs. busy must NOT drift. Hardcoded `bg-brutal-red`
 *     in callsites makes it trivial to grab the wrong color.
 *   - When the design tokens shift (Plan A v1.2 → v2 etc.), the
 *     map updates here once and every callsite follows.
 *   - Mirrors the API direction of `<PanelHeader iconBg>` taking
 *     a className token (Joy 2026-05-10 design API note) — but
 *     here we go one step further and lock the token to a
 *     semantic intent.
 *
 * **Density**: defaults to `"md"` (`p-3`) which matches the
 * dominant existing pattern. `"sm"` (`p-2`) covers the SettingsPanel
 * inline form errors that are tighter. `"lg"` (`p-4 shadow-brutal-sm`)
 * covers the heavier plan-grace banners.
 */

export type BannerIntent = "destructive" | "warning" | "info" | "success";
export type BannerDensity = "sm" | "md" | "lg";

const INTENT_SURFACE: Record<BannerIntent, string> = {
  destructive: "bg-brutal-red/20",
  warning: "bg-brutal-orange/20",
  info: "bg-soft-signal/30",
  success: "bg-brutal-lime/20",
};

// Default icon per intent. NOT auto-rendered — the dominant
// inline pattern is iconless, so we render an icon only when the
// caller explicitly passes one. To get the conventional intent
// icon, callers can either pass `withIcon` (boolean) or any
// ReactNode via `icon`. The map exists so `withIcon` has a
// predictable lookup.
const INTENT_DEFAULT_ICON: Record<BannerIntent, ReactNode> = {
  destructive: <AlertTriangle size={18} className="shrink-0 mt-0.5 text-black" />,
  warning: <CircleAlert size={18} className="shrink-0 mt-0.5 text-black" />,
  info: <Info size={18} className="shrink-0 mt-0.5 text-black" />,
  success: <CheckCircle2 size={18} className="shrink-0 mt-0.5 text-black" />,
};

const DENSITY_PADDING: Record<BannerDensity, string> = {
  sm: "p-2",
  md: "p-3",
  lg: "p-4 shadow-brutal-sm",
};

const DENSITY_TEXT: Record<BannerDensity, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-sm",
};

const DENSITY_GAP: Record<BannerDensity, string> = {
  sm: "gap-2",
  md: "gap-3",
  lg: "gap-3",
};

export interface BannerProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Semantic intent — drives surface color + default icon. */
  intent: BannerIntent;
  /** Density — `"md"` matches the dominant inline pattern (p-3 + text-sm).
   *  `"sm"` is the tighter SettingsPanel form-error variant (p-2 + text-xs).
   *  `"lg"` adds shadow-brutal-sm for prominent surface banners. */
  density?: BannerDensity;
  /** Optional bold heading rendered above the body. */
  title?: ReactNode;
  /** Banner body. Most callsites pass a `<p>`-worthy string but any
   *  ReactNode (links, button rows) is fine. */
  children?: ReactNode;
  /** Convenience flag — render the conventional intent icon
   *  (AlertTriangle / CircleAlert / Info / CheckCircle2). When
   *  `false` (default), banner renders without an icon — matching
   *  the dominant inline pattern. */
  withIcon?: boolean;
  /** Override the icon entirely with a custom node. Takes
   *  precedence over `withIcon`. Useful for waiting indicators
   *  (pulsing dot) or task-specific icons. */
  icon?: ReactNode;
  /** Optional right-aligned action slot (e.g. a button or link). */
  actions?: ReactNode;
}

export default function Banner({
  intent,
  density = "md",
  title,
  children,
  icon,
  withIcon = false,
  actions,
  className = "",
  ...rest
}: BannerProps) {
  const resolvedIcon = icon !== undefined ? icon : (withIcon ? INTENT_DEFAULT_ICON[intent] : null);
  return (
    <div
      {...rest}
      className={`flex items-start ${DENSITY_GAP[density]} border-2 border-black ${INTENT_SURFACE[intent]} ${DENSITY_PADDING[density]} ${className}`}
    >
      {resolvedIcon}
      <div className={`min-w-0 flex-1 ${DENSITY_TEXT[density]} text-black`}>
        {title && <div className="font-bold mb-0.5">{title}</div>}
        {children}
      </div>
      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  );
}
