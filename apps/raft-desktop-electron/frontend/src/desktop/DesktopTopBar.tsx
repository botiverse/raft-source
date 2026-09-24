// The desktop's unified top toolbar — a real macOS titlebar strip.
//
// Layout follows the reference (traffic lights + avatar on the left, a centered
// search/command bar, workspace on the right) but the STYLE is our own
// neo-brutalist system (hard black bottom rule, square inputs, our palette).
//
// Only rendered when signed in (the login page keeps its own brand bar). The
// whole strip is the window drag region via `data-raft-titlebar`, which also
// reserves the left inset for the traffic lights and opts interactive children
// back out of dragging. Every control maps to a real action — no dead buttons.

import { useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { useServerStore } from "@web/store/serverStore";
import { useAuthStore } from "@web/store/authStore";
import { useAppNavigate } from "@web/hooks/useAppNavigate";
import { AvatarImageWithFallback } from "@web/components/ui/AvatarSlot";
import ServerSwitcherMenu from "@web/components/ui/ServerSwitcherMenu";
import { SKINS, currentSkinId, setSkin, skinById, subscribeSkin } from "./skins";
import { DesktopUpdatePill } from "./appUpdate";

const MOD_KEY = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘" : "Ctrl";

// Shared chrome-control style for the bar's interactive items (personal avatar,
// skin switcher, workspace). One fixed height (h-8) matches the center search
// bar so the whole control row shares a baseline; symmetric px keeps left/right
// padding equal; a reserved transparent border becomes a black frame + white
// fill on hover (a "ghost" control — the resting bar stays clean, no layout
// shift). Per-button `gap-*` is added at the callsite.
const CHROME_CONTROL =
  "inline-flex h-8 items-center border-2 border-transparent px-1.5 transition-colors hover:border-black hover:bg-white";

// Inline icon (no icon-library dependency in the desktop bootstrap).
function SearchIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.5" y2="16.5" />
    </svg>
  );
}

// A recognizable artist's-palette icon (so it reads as a theme/colours control),
// drawn in bold brutal strokes and FILLED with the current skin colour — the
// shape says "change the look", the fill says "this is the current skin".
function PaletteIcon({ fill }: { fill: string }) {
  return (
    <svg width={19} height={19} viewBox="0 0 24 24" aria-hidden
      fill="none" stroke="black" strokeWidth={2} strokeLinejoin="round">
      <path
        d="M12 3C6.5 3 2 6.9 2 11.7c0 3.4 2.8 5.3 5.5 5.3 1.4 0 2-.8 2-1.7 0-.5-.2-.8-.2-1.2 0-.9.7-1.6 1.7-1.6H13c3.9 0 7-2.7 7-6C20 5.4 16.4 3 12 3Z"
        fill={fill}
      />
      <circle cx="7" cy="10" r="1.15" fill="black" stroke="none" />
      <circle cx="11" cy="7.4" r="1.15" fill="black" stroke="none" />
      <circle cx="15.5" cy="9" r="1.15" fill="black" stroke="none" />
    </svg>
  );
}

// Skin switcher: a palette button that opens a swatch menu. Reads/writes the one
// shared skin source (skins.ts) and stays in sync with Settings → Appearance.
// The trigger is a palette icon filled with the current chrome — clearly a
// "theme" control, and it shows the active skin at a glance.
function SkinSwitcher() {
  const [open, setOpen] = useState(false);
  const [skinId, setSkinId] = useState(() => currentSkinId());

  // Stay in sync when the skin is changed elsewhere (e.g. Settings).
  useEffect(() => subscribeSkin(setSkinId), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest("[data-skin-switcher]")) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div data-skin-switcher className="relative w-fit">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={formatMessageSafe("Theme")}
        title={formatMessageSafe("Theme")}
        className={`${CHROME_CONTROL} gap-1`}
      >
        <PaletteIcon fill={skinById(skinId).chrome} />
        <ChevronDown open={open} />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-48 border-2 border-black bg-white p-1.5 shadow-brutal">
          <div className="px-1.5 pb-1.5 pt-0.5 font-display text-[11px] font-bold uppercase tracking-wide text-neutral-500">
            Skin
          </div>
          {SKINS.map((skin) => (
            <button
              key={skin.id}
              type="button"
              onClick={() => {
                setSkin(skin.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 border-2 px-2 py-1.5 text-left text-sm font-medium transition-colors ${
                skin.id === skinId ? "border-black bg-soft-signal" : "border-transparent hover:border-black hover:bg-white"
              }`}
            >
              <span className="size-4 shrink-0 border-2 border-black" style={{ backgroundColor: skin.chrome }} />
              <span className="flex-1 truncate">{skin.name}</span>
              {skin.id === skinId ? <span aria-hidden className="shrink-0 font-bold">✓</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ChevronDown({ open }: { open: boolean }) {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden
      className={`text-black transition-transform ${open ? "rotate-180" : ""}`}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// The desktop switcher label is fixed English for now (no i18n key yet).
function formatMessageSafe(fallback: string): string {
  return fallback;
}

export function DesktopTopBar() {
  const { formatMessage } = useIntl();
  const server = useServerStore((s) => s.current);
  const user = useAuthStore((s) => s.user);
  const nav = useAppNavigate();
  const [serverMenuOpen, setServerMenuOpen] = useState(false);

  const serverName = server?.name ?? "";
  const serverInitial = serverName.slice(0, 1).toUpperCase() || "R";
  const userName = user?.displayName || user?.name || "";
  const userInitial = userName.slice(0, 1).toUpperCase() || "?";

  return (
    <div
      data-raft-titlebar
      className="relative flex h-12 shrink-0 items-center border-b-2 border-black bg-soft-signal"
    >
      {/* Left region (flex-1, mirrors the right region so the center search stays
          centered). The traffic-light inset is reserved by the data-raft-titlebar
          padding. */}
      <div className="flex min-w-0 flex-1 items-center">
        <button
          type="button"
          onClick={() => user && nav.toHuman(user.id)}
          aria-label={userName}
          className={`${CHROME_CONTROL} min-w-0 gap-2`}
        >
          <div className="relative inline-flex size-6 items-center justify-center overflow-hidden border-2 border-black bg-white font-display text-[11px] font-bold text-black">
            <AvatarImageWithFallback src={user?.avatarUrl} fallback={userInitial} />
          </div>
          {userName ? (
            <span className="max-w-[160px] truncate font-display text-sm font-bold text-black">
              {userName}
            </span>
          ) : null}
        </button>
      </div>

      {/* Center: search / command bar. In normal flow between two flex-1 side
          regions so it stays centered AND nothing (e.g. the update pill) can slide
          under it — it used to be absolutely positioned, which let the right
          cluster underlap and clip it on narrower windows. */}
      <button
        type="button"
        onClick={() => nav.toSearch(undefined, { flushSync: true })}
        className="flex h-8 w-[min(520px,42vw)] shrink-0 items-center gap-2 border-2 border-black bg-white px-3 text-neutral-500 shadow-brutal-sm transition-all hover:shadow-brutal focus-visible:shadow-brutal"
      >
        <span className="shrink-0 text-black"><SearchIcon size={15} /></span>
        <span className="truncate text-sm">
          {formatMessage({ id: "layout.sidebar.searchPlaceholder", defaultMessage: "Search" })}
        </span>
        <kbd className="ml-auto shrink-0 border border-black bg-soft-signal px-1 text-[11px] font-medium text-black">
          {MOD_KEY}K
        </kbd>
      </button>

      {/* Right region (flex-1, justify-end): the update pill, skin switcher, then
          the current workspace (avatar then name) → server switcher. Each relative
          wrapper hugs its button (w-fit) so its dropdown right-aligns to the
          button, not the window edge. */}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1 pr-3">
      {/* Non-intrusive "restart to update" pill — only when an app update is
          downloaded and ready. */}
      <DesktopUpdatePill />
      <SkinSwitcher />
      <div className="relative w-fit">
        <button
          type="button"
          onClick={() => setServerMenuOpen((open) => !open)}
          aria-label={serverName}
          className={`${CHROME_CONTROL} gap-2`}
        >
          <div className="relative inline-flex size-6 items-center justify-center overflow-hidden border-2 border-black bg-black font-display text-[11px] font-bold text-soft-signal">
            <AvatarImageWithFallback src={server?.avatarUrl} fallback={serverInitial} />
          </div>
          {serverName ? (
            <span className="max-w-[160px] truncate font-display text-sm font-bold text-black">
              {serverName}
            </span>
          ) : null}
        </button>
        <ServerSwitcherMenu
          open={serverMenuOpen}
          onClose={() => setServerMenuOpen(false)}
          serverUnreadCounts={{}}
          className="absolute right-0 top-full mt-2 w-64 max-h-[calc(100dvh-16px)]"
        />
      </div>
      </div>
    </div>
  );
}
