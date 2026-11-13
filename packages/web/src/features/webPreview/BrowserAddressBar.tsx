import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { ArrowLeft, ArrowRight, ArrowUpRight, RefreshCw } from "lucide-react";
import { Badge, InputGroup, InputGroupInput, PanelAction } from "@botiverse/raft-ui";
import type { DesktopWebPreviewTabsBridge } from "@botiverse/raft-shared";

import Tooltip from "../../components/ui/Tooltip";
import { useRaftPermalinkHostnames } from "../../store/raftAppHosts";
import { useBrowserTabsStore } from "./browserTabsStore";
import type { BrowserTab } from "./browserTabsStore";
import { typedWebAddress, webPreviewUrl } from "./webPreviewAddress";
import { openWebPreviewInNewTab, webPreviewTarget } from "./webPreviewStore";

/**
 * The built-in browser's address row, for the tab in front: Back, Forward,
 * Reload, the address, Open in browser (the system browser).
 *
 * The address reads as before (host bold, the rest muted; a plain-http page
 * marked Not secure). Pressing it, or an empty tab, turns it into a field:
 * Enter loads what was typed in this tab (typedWebAddress; only what the
 * view may show: http(s), not Raft's own hosts, no credentials), Escape or
 * leaving the field puts the address back. Mounted per tab (keyed by the
 * panel), so an empty tab opens with the field focused.
 */
export function BrowserAddressBar({ bridge, conversationId, tab }: { bridge: DesktopWebPreviewTabsBridge; conversationId: string; tab: BrowserTab }) {
  const { formatMessage } = useIntl();
  const navigate = useBrowserTabsStore((s) => s.navigate);
  const raftHostnames = useRaftPermalinkHostnames();
  const empty = tab.url === null;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const field = empty || editing;
  // An empty tab starts in its address field; a pressed address takes the focus as it becomes one.
  useEffect(() => {
    if (!field) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [field]);
  const { host, rest } = useMemo(() => {
    const parsed = webPreviewUrl(tab.url);
    if (!parsed) return { host: tab.url ?? "", rest: "" };
    return { host: parsed.host, rest: `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}` };
  }, [tab.url]);
  const edit = useCallback(() => {
    setText(tab.url ?? "");
    setInvalid(false);
    setEditing(true);
  }, [tab.url]);
  const leave = useCallback(() => {
    setEditing(false);
    setInvalid(false);
  }, []);
  const submit = useCallback((event: FormEvent) => {
    event.preventDefault();
    const typed = typedWebAddress(text);
    const target = typed ? webPreviewTarget(typed.href, raftHostnames) : null;
    if (!target) {
      setInvalid(true);
      return;
    }
    setEditing(false);
    navigate(conversationId, tab.id, target.href);
  }, [conversationId, navigate, raftHostnames, tab.id, text]);
  const type = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setText(event.target.value);
    setInvalid(false);
  }, []);
  const handleFieldKey = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    // The field's own Escape: the panel's (which closes the browser) doesn't run.
    event.preventDefault();
    leave();
  }, [leave]);
  const handleAddressKey = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    edit();
  }, [edit]);
  const back = useCallback(() => bridge.back(tab.id), [bridge, tab.id]);
  const forward = useCallback(() => bridge.forward(tab.id), [bridge, tab.id]);
  const reload = useCallback(() => bridge.reload(tab.id), [bridge, tab.id]);
  const openInBrowser = useCallback(() => {
    if (tab.url) openWebPreviewInNewTab(tab.url);
  }, [tab.url]);
  const backLabel = formatMessage({ id: "webPreview.back" });
  const forwardLabel = formatMessage({ id: "webPreview.forward" });
  const refreshLabel = formatMessage({ id: "webPreview.refresh" });
  const openLabel = formatMessage({ id: "webPreview.openInBrowser" });
  const addressLabel = formatMessage({ id: "webPreview.address" });
  return (
    <div
      className="flex h-(--shell-header-height,var(--header-height)) shrink-0 items-center gap-1 border-b border-line-seam bg-layer-canvas px-(--column-margin)"
      data-testid="web-preview-address-bar"
    >
      <Tooltip content={backLabel}>
        <PanelAction aria-label={backLabel} onClick={back} disabled={!tab.canGoBack} data-testid="web-preview-history-back">
          <ArrowLeft />
        </PanelAction>
      </Tooltip>
      <Tooltip content={forwardLabel}>
        <PanelAction aria-label={forwardLabel} onClick={forward} disabled={!tab.canGoForward} data-testid="web-preview-history-forward">
          <ArrowRight />
        </PanelAction>
      </Tooltip>
      <Tooltip content={refreshLabel}>
        <PanelAction aria-label={refreshLabel} onClick={reload} disabled={empty} data-testid="web-preview-refresh">
          <RefreshCw />
        </PanelAction>
      </Tooltip>
      <form className="mx-1 flex min-w-0 flex-1" onSubmit={submit} noValidate>
        <InputGroup size="md" className="min-w-0 flex-1">
          {field ? (
            <InputGroupInput
              ref={inputRef}
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label={addressLabel}
              data-invalid={invalid || undefined}
              placeholder={formatMessage({ id: "webPreview.addressPlaceholder" })}
              value={text}
              onChange={type}
              onKeyDown={handleFieldKey}
              onBlur={leave}
              data-testid="web-preview-address-input"
            />
          ) : (
            <>
              {tab.url?.startsWith("http:") ? (
                <Badge appearance="soft" variant="warning" className="ml-2 shrink-0 self-center" data-testid="web-preview-not-secure">
                  {formatMessage({ id: "webPreview.notSecure" })}
                </Badge>
              ) : null}
              {/* The address as text, host bold (raft-ui has no read-only address field); pressing it makes it the field. */}
              <div
                role="button"
                tabIndex={0}
                aria-label={addressLabel}
                title={tab.url ?? undefined}
                onClick={edit}
                onKeyDown={handleAddressKey}
                className="min-w-0 flex-1 cursor-text truncate px-3 font-sans text-callout outline-none keyboard:focus-visible:shadow-focus"
                data-testid="web-preview-address"
              >
                <span className="font-bold text-foreground" data-testid="web-preview-host">{host}</span>
                <span className="text-foreground-muted" data-testid="web-preview-path">{rest}</span>
              </div>
            </>
          )}
        </InputGroup>
      </form>
      <Tooltip content={openLabel}>
        <PanelAction aria-label={openLabel} onClick={openInBrowser} disabled={empty} data-testid="web-preview-open-tab">
          <ArrowUpRight />
        </PanelAction>
      </Tooltip>
    </div>
  );
}
