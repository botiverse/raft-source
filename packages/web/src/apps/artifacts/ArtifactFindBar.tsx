import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ChangeEvent, FocusEvent, KeyboardEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Button, InputGroup, InputGroupAddon, InputGroupInput, PanelAction } from "@botiverse/raft-ui";

import Tooltip from "../../components/ui/Tooltip";
import { focusLost } from "../../utils/focusGuard";
import { ArtifactFindContext, ArtifactFindFrameContext, FIND_QUERY_MAX, useArtifactFind, useArtifactFindState } from "./artifactFind";
import { isInputMethodKey } from "./artifactInputMethodKey";
import { useDismissable } from "./useArtifactDismiss";

/**
 * Find in page's state for one opening (artifactFind): the bar, its header button and the keys read it
 * (useArtifactFind), and the frame inside offers its page to it (useArtifactFindFrame). The surface's
 * (ArtifactSurface) and the public page's (PublicArtifactPage).
 */
export function ArtifactFindProvider({ children }: { children: ReactNode }) {
  const { find, frame } = useArtifactFindState();
  return (
    <ArtifactFindFrameContext value={frame}>
      <ArtifactFindContext value={find}>{children}</ArtifactFindContext>
    </ArtifactFindFrameContext>
  );
}

/**
 * Find in page's header button (artifactFind): where a page that may be searched is shown, it
 * opens the bar and puts the cursor in its field. Where the header has no room, ⋯ holds it
 * instead (ArtifactSurfaceActions).
 */
export function ArtifactFindAction({ testId }: { testId: string }) {
  const { formatMessage } = useIntl();
  const find = useArtifactFind();
  if (!find?.offered) return null;
  const label = formatMessage({ id: "artifacts.find.open" });
  return (
    <Tooltip content={label}>
      <PanelAction aria-label={label} aria-expanded={find.open} onClick={find.openBar} data-testid={testId}>
        <Search />
      </PanelAction>
    </Tooltip>
  );
}

/**
 * The find bar, a strip under the header (as Search in this thread's, ThreadSearchBar): the query,
 * "3/12", Previous / Next and ×. Enter is Next, Shift+Enter Previous, Esc closes. Where find
 * isn't available, there is no bar (artifactFind `offered`): when the page says so with the bar
 * open, it goes, and focus that was in it moves to the surface, as × does (Kirby, #13758: not
 * to the page's body).
 */
export function ArtifactFindBar() {
  const { formatMessage } = useIntl();
  const find = useArtifactFind();
  const field = useRef<HTMLInputElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const focusInside = useRef(false);
  const open = find?.open ?? false;
  // The surface the bar is in, read while it is open; focus in the bar goes back to it when the bar
  // goes without its own close (the page said find isn't available, another version).
  useLayoutEffect(() => {
    if (open) {
      surfaceRef.current = barRef.current?.closest<HTMLElement>("[data-artifact-focus]") ?? null;
      return;
    }
    // A browser may blur the field as it is removed: focus that fell to nowhere counts as the bar's.
    if (!focusInside.current && !focusLost()) return;
    focusInside.current = false;
    surfaceRef.current?.focus({ preventScroll: true });
  }, [open]);
  const focused = useCallback(() => { focusInside.current = true; }, []);
  const blurred = useCallback((event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focusInside.current = false;
  }, []);
  const focusRequest = find?.focusRequest ?? 0;
  // Opened (the button, Cmd/Ctrl+F here or in the page, ⋯): the cursor goes to the field, its words selected.
  useEffect(() => {
    if (!open) return;
    field.current?.focus();
    field.current?.select();
  }, [open, focusRequest]);
  const type = find?.type;
  const onChange = useCallback((event: ChangeEvent<HTMLInputElement>) => type?.(event.target.value), [type]);
  const step = find?.step;
  const close = find?.close;
  // On the dismissal layer (artifactDismissLayer) for Esc in the Artifact's page, where the bar's
  // own key handler can't hear it: the bar goes, the focus staying in the page. Presses leave it,
  // as a browser's find bar. (Heard only where the page reports Esc: artifactPageSignals.)
  useDismissable(open, { presses: false, element: () => barRef.current, close: () => close?.() });
  const closeHere = useCallback(() => {
    // The field goes with the bar: focus stays in the surface, which takes its keys (Esc, Cmd/Ctrl+F).
    field.current?.closest<HTMLElement>("[data-artifact-focus]")?.focus();
    close?.();
  }, [close]);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (isInputMethodKey(event)) return;
    if (event.key === "Escape") {
      // The bar's: the surface's Esc would close the viewer.
      event.preventDefault();
      closeHere();
    } else if (event.key === "Enter") {
      event.preventDefault();
      step?.(event.shiftKey ? "prev" : "next");
    }
  }, [closeHere, step]);
  const previousMatch = useCallback(() => step?.("prev"), [step]);
  const clearQuery = useCallback(() => {
    type?.("");
    field.current?.focus();
  }, [type]);
  const nextMatch = useCallback(() => step?.("next"), [step]);
  if (!find || !open) return null;

  const { answer, query } = find;
  const found = answer !== null && query.trim() !== "" ? answer : null;
  const count = found ? formatMessage({ id: found.capped ? "artifacts.find.countCapped" : "artifacts.find.count" }, { active: found.active, total: found.total }) : "";
  const moves = found !== null && found.total > 0;
  const label = formatMessage({ id: "artifacts.find.open" });
  const previous = formatMessage({ id: "artifacts.find.previous" });
  const next = formatMessage({ id: "artifacts.find.next" });
  const closeLabel = formatMessage({ id: "artifacts.find.close" });
  const clearLabel = formatMessage({ id: "artifacts.find.clear" });
  return (
    <div ref={barRef} role="search" onFocusCapture={focused} onBlurCapture={blurred} className="flex shrink-0 flex-col gap-1 border-b border-line-seam bg-layer-canvas px-(--column-margin) py-2" data-testid="artifact-find-bar">
      <div className="flex items-center gap-1">
        <InputGroup className="min-w-0 flex-1">
          <InputGroupAddon>
            <Search aria-hidden size={14} />
          </InputGroupAddon>
          <InputGroupInput
            ref={field}
            value={query}
            onChange={onChange}
            onKeyDown={onKeyDown}
            maxLength={FIND_QUERY_MAX}
            placeholder={label}
            aria-label={label}
            suppressPasswordManager
            data-testid="artifact-find-input"
          />
          <InputGroupAddon.Text align="inline-end" role="status" className="ps-2" data-testid="artifact-find-count">{count}</InputGroupAddon.Text>
          {query !== "" ? (
            <InputGroupAddon align="inline-end">
              <Tooltip content={clearLabel}>
                <Button type="button" size="icon-md" variant="ghost" onClick={clearQuery} aria-label={clearLabel} data-testid="artifact-find-clear">
                  <X size={12} />
                </Button>
              </Tooltip>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        <Tooltip content={previous}>
          <Button type="button" size="icon-lg" variant="ghost" onClick={previousMatch} disabled={!moves} aria-label={previous} data-testid="artifact-find-previous">
            <ChevronUp size={14} />
          </Button>
        </Tooltip>
        <Tooltip content={next}>
          <Button type="button" size="icon-lg" variant="ghost" onClick={nextMatch} disabled={!moves} aria-label={next} data-testid="artifact-find-next">
            <ChevronDown size={14} />
          </Button>
        </Tooltip>
        <Tooltip content={closeLabel}>
          <Button type="button" size="icon-lg" variant="ghost" onClick={closeHere} aria-label={closeLabel} data-testid="artifact-find-close">
            <X size={14} />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}
