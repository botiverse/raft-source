import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, RefObject } from "react";
import { useIntl } from "react-intl";
import { Link, Search, TriangleAlert, X } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Banner,
  BannerDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogHeader,
  DialogSheetContent,
  DialogTitle,
  DialogTrigger,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  Text,
  toast,
} from "@botiverse/raft-ui";
import { ListRowSkeleton } from "@botiverse/raft-ui/wip";
import { useAuthStore } from "../../store/authStore";
import { linkPreviewViewerKey, useLinkPreviewConsentStore } from "../../store/linkPreviewConsentStore";
import type { LinkPreviewApp } from "../../store/linkPreviewConsentStore";
import { findLinkPreviewChoice, linkPreviewChoiceRows, useLinkPreviewChoicesStore } from "../../store/linkPreviewChoicesStore";
import type { LinkPreviewChoice, LinkPreviewChoices } from "../../store/linkPreviewChoicesStore";
import { useServerStore } from "../../store/serverStore";
import { LinkPreviewAppLogo } from "../message/LinkPreviewConsentPrompt";
import EmptyState from "../ui/EmptyState";
import SectionEyebrow from "../ui/SectionEyebrow";
import { focusLost } from "../../utils/focusGuard";

// Settings › Applications › Link Previews: the viewer's own answers to the
// first-view prompt on this Server (docs/development/app-link-previews.md
// #first-view-prompt). One row at the bottom of Applications counts them and
// opens Manage, a dialog listing them: allowed Apps can be revoked, which is
// the same as declining; declined ones can be allowed. An installed App's
// details show that App's answer as a section with the same row. All three
// read one list (linkPreviewChoicesStore). Guests see the row alone.

/** Past this many Apps the Manage dialog gets a search field. */
const SEARCH_ABOVE = 8;

function useLinkPreviewViewer() {
  const viewer = useAuthStore((s) => s.user?.id);
  const serverId = useServerStore((s) => s.current?.id);
  return { viewerKey: linkPreviewViewerKey(viewer, serverId), known: Boolean(viewer && serverId) };
}

function useLinkPreviewChoicesLoad(viewerKey: string) {
  return useLinkPreviewChoicesStore((s) => s.byViewer[viewerKey]);
}

/**
 * One App's answer: when, and the one thing to do about it (Revoke an allowed
 * App, Allow a declined one). The Manage dialog's rows and the line in the
 * App's details are this row, so both read and act alike. In the dialog the
 * App's name is the title and the date is under it; in the App's own details,
 * which already name it, the date is the row's one line.
 */
function LinkPreviewChoiceRow({ choice, title, logo = false, allowing, disabled, onAllow, onRevoke }: {
  choice: LinkPreviewChoice;
  title?: string;
  logo?: boolean;
  allowing: boolean;
  disabled: boolean;
  onAllow: (app: LinkPreviewApp) => Promise<void>;
  onRevoke: (app: LinkPreviewApp) => void;
}) {
  const { formatMessage, formatDate } = useIntl();
  const { app, kind } = choice;
  const date = formatDate(new Date(choice.at), { dateStyle: "medium" });
  const when = formatMessage({ id: kind === "allowed" ? "settings.linkPreviews.allowedOn" : "settings.linkPreviews.declinedOn" }, { date });
  const act = useCallback(() => {
    if (kind === "allowed") onRevoke(app);
    else void onAllow(app);
  }, [app, kind, onAllow, onRevoke]);
  return (
    <ListRow variant="plain" interactive={false} data-link-preview-app={app.id} data-link-preview-choice={kind}>
      {logo ? <LinkPreviewAppLogo app={app} /> : null}
      <ListRowBody>
        {title ? (
          <>
            <ListRowTitle>{title}</ListRowTitle>
            <ListRowDescription>{when}</ListRowDescription>
          </>
        ) : <ListRowDescription>{when}</ListRowDescription>}
      </ListRowBody>
      {kind === "allowed" ? (
        <Button variant="default" aria-label={formatMessage({ id: "settings.linkPreviews.revokeApp" }, { app: app.name })} onClick={act}>
          {formatMessage({ id: "settings.linkPreviews.revoke" })}
        </Button>
      ) : (
        <Button
          variant="default"
          aria-label={formatMessage({ id: "settings.linkPreviews.allowApp" }, { app: app.name })}
          loading={allowing}
          loadingLabel={formatMessage({ id: "settings.linkPreviews.allowing" })}
          disabled={disabled}
          onClick={act}
        >
          {formatMessage({ id: "settings.linkPreviews.allow" })}
        </Button>
      )}
    </ListRow>
  );
}

type RevokeDialogProps = {
  target: LinkPreviewApp | null;
  open: boolean;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
  finalFocus: () => HTMLElement | true;
};

/**
 * Allow and Revoke for the rows inside `container`: the answer goes through
 * linkPreviewConsentStore (so open conversations hear about it), then the
 * shared list is read again, which updates every place that shows it. An
 * answer can move a row (to the other group of the dialog), and the focused
 * button goes with the old row: focus then follows to the row's new button.
 */
function useLinkPreviewAnswers(container: RefObject<HTMLElement | null>) {
  const { formatMessage } = useIntl();
  const { viewerKey } = useLinkPreviewViewer();
  const load = useLinkPreviewChoicesLoad(viewerKey);
  const [allowingId, setAllowingId] = useState<string | null>(null);
  // The App the revoke dialog is about; it stays set while the dialog closes,
  // so the closing dialog keeps its title.
  const [revokeTarget, setRevokeTarget] = useState<LinkPreviewApp | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const revokedId = useRef<string | null>(null);
  const allowedId = useRef<string | null>(null);

  /** The button of an App's row, wherever it is now. */
  const rowButton = useCallback((appId: string): HTMLElement | null => {
    const rows = container.current?.querySelectorAll<HTMLElement>("[data-link-preview-app]") ?? [];
    const row = Array.from(rows).find((element) => element.dataset.linkPreviewApp === appId);
    return row?.querySelector<HTMLElement>("button") ?? null;
  }, [container]);
  const readAgain = useCallback(() => useLinkPreviewChoicesStore.getState().read(viewerKey, { quiet: true }), [viewerKey]);

  const allow = useCallback(async (app: LinkPreviewApp) => {
    setAllowingId(app.id);
    const result = await useLinkPreviewConsentStore.getState().allow(viewerKey, app);
    if (result === "failed") toast.error(formatMessage({ id: "settings.linkPreviews.allowFailed" }, { app: app.name }));
    if (result === "unavailable") toast.info(formatMessage({ id: "settings.linkPreviews.unavailable" }, { app: app.name }));
    if (result !== "failed") {
      await readAgain();
      allowedId.current = app.id;
    }
    setAllowingId(null);
  }, [formatMessage, readAgain, viewerKey]);
  // After the list has moved the allowed row: if its Allow button took focus
  // with it (to the page, or to the dialog holding the list), focus the row's
  // Revoke button now.
  useEffect(() => {
    const appId = allowedId.current;
    if (!appId || allowingId !== null) return;
    allowedId.current = null;
    // Focus on a dialog's popup counts as lost when the list is in it (a row is there); not for another dialog.
    const rowInFocused = document.activeElement?.querySelector("[data-link-preview-app]");
    if (focusLost(rowInFocused)) rowButton(appId)?.focus();
  }, [allowingId, load, rowButton]);

  const openRevoke = useCallback((app: LinkPreviewApp) => {
    setRevokeTarget(app);
    setRevokeError(null);
    setRevokeOpen(true);
  }, []);
  const confirmRevoke = useCallback(async () => {
    if (!revokeTarget || revoking) return;
    setRevoking(true);
    setRevokeError(null);
    // Revoking is declining: the server keeps the Login with Raft consent row
    // and records a decline, so a later login doesn't bring previews back.
    const result = await useLinkPreviewConsentStore.getState().decline(viewerKey, revokeTarget);
    if (result === "failed") {
      // The dialog stays open with what went wrong; nothing changed.
      setRevokeError(formatMessage({ id: "settings.linkPreviews.revokeFailed" }, { app: revokeTarget.name }));
      setRevoking(false);
      return;
    }
    await readAgain();
    revokedId.current = revokeTarget.id;
    setRevoking(false);
    setRevokeOpen(false);
  }, [formatMessage, readAgain, revokeTarget, revoking, viewerKey]);
  const revokeOpenChange = useCallback((open: boolean) => {
    if (!open && !revoking) setRevokeOpen(false);
  }, [revoking]);
  // Keep Allowed or Esc: back to the Revoke button that opened it (the
  // default). After a revoke that row now offers Allow: its Allow button.
  const revokeFinalFocus = useCallback((): HTMLElement | true => {
    const appId = revokedId.current;
    revokedId.current = null;
    return (appId && rowButton(appId)) || true;
  }, [rowButton]);

  const revokeDialog: RevokeDialogProps = {
    target: revokeTarget,
    open: revokeOpen,
    busy: revoking,
    error: revokeError,
    onOpenChange: revokeOpenChange,
    onConfirm: confirmRevoke,
    finalFocus: revokeFinalFocus,
  };
  return { allowingId, allow, openRevoke, revokeDialog };
}

function LinkPreviewRevokeDialog({ target, open, busy, error, onOpenChange, onConfirm, finalFocus }: RevokeDialogProps) {
  const { formatMessage } = useIntl();
  const name = target?.name ?? "";
  return (
    // DS AlertDialog (400px): revoking interrupts, but can be undone right
    // here, so the confirm is orange, and Cancel says what stays.
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent finalFocus={finalFocus} aria-busy={busy} data-testid="link-preview-revoke-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{formatMessage({ id: "settings.linkPreviews.revokeTitle" }, { app: name })}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody>
          <AlertDialogDescription>{formatMessage({ id: "settings.linkPreviews.revokeBody" }, { app: name })}</AlertDialogDescription>
          {/* A problem is orange: red is for what can't be undone. */}
          {error && <Banner status="warning" size="sm" role="alert" className="mt-3"><TriangleAlert aria-hidden /><BannerDescription>{error}</BannerDescription></Banner>}
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel size="lg" disabled={busy}>{formatMessage({ id: "settings.linkPreviews.keepAllowed" })}</AlertDialogCancel>
          {/* focusableWhenDisabled: Revoke keeps focus while it runs, so a
              failure (the dialog stays open) leaves focus on it. */}
          <AlertDialogAction
            focusableWhenDisabled
            variant="warning"
            size="lg"
            loading={busy}
            loadingLabel={formatMessage({ id: "settings.linkPreviews.revoking" })}
            onClick={onConfirm}
            data-testid="link-preview-revoke-confirm"
          >
            {formatMessage({ id: "settings.linkPreviews.revoke" })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** "3 allowed · 1 declined"; a part that is zero is left out. */
function useChoiceCounts(choices: LinkPreviewChoices | null): string {
  const { formatMessage } = useIntl();
  if (!choices) return "";
  const allowed = choices.allowed.length
    ? formatMessage({ id: "settings.linkPreviews.allowedCount" }, { count: choices.allowed.length })
    : null;
  const declined = choices.declined.length
    ? formatMessage({ id: "settings.linkPreviews.declinedCount" }, { count: choices.declined.length })
    : null;
  if (allowed && declined) return formatMessage({ id: "settings.linkPreviews.counts" }, { allowed, declined });
  return allowed ?? declined ?? "";
}

function ManageDialogList({ searchRef }: { searchRef: RefObject<HTMLInputElement | null> }) {
  const { formatMessage } = useIntl();
  const { viewerKey } = useLinkPreviewViewer();
  const load = useLinkPreviewChoicesLoad(viewerKey);
  const listRef = useRef<HTMLDivElement>(null);
  const { allowingId, allow, openRevoke, revokeDialog } = useLinkPreviewAnswers(listRef);
  const allowedHeadingId = useId();
  const declinedHeadingId = useId();
  const [query, setQuery] = useState("");
  const changeQuery = useCallback((event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value), []);
  const clearQuery = useCallback(() => {
    setQuery("");
    searchRef.current?.focus();
  }, [searchRef]);
  const retry = useCallback(() => void useLinkPreviewChoicesStore.getState().read(viewerKey), [viewerKey]);

  let content;
  if (!load || load.kind === "loading") {
    content = (
      <ListRowGroup aria-busy="true" data-testid="link-preview-consents-loading">
        <ListRowSkeleton variant="plain" description />
        <ListRowSkeleton variant="plain" description />
      </ListRowGroup>
    );
  } else if (load.kind === "failed") {
    content = (
      <div className="flex items-center justify-between gap-3">
        <p role="alert" className="m-0 min-w-0 text-callout text-foreground-muted">{formatMessage({ id: "settings.linkPreviews.loadFailed" })}</p>
        <Button variant="default" onClick={retry}>{formatMessage({ id: "settings.linkPreviews.retry" })}</Button>
      </div>
    );
  } else if (!load.choices.allowed.length && !load.choices.declined.length) {
    // Every App went while the dialog was open (an uninstall): the dialog's
    // only content, so the DS empty state.
    content = <LinkPreviewConsentsEmpty className="py-8" />;
  } else {
    const { allowed, declined } = linkPreviewChoiceRows(load.choices);
    const searchable = allowed.length + declined.length > SEARCH_ABOVE;
    const needle = searchable ? query.trim().toLocaleLowerCase() : "";
    const matches = (app: LinkPreviewApp) => !needle || app.name.toLocaleLowerCase().includes(needle);
    const shownAllowed = allowed.filter((row) => matches(row.app));
    const shownDeclined = declined.filter((row) => matches(row.app));
    const searchLabel = formatMessage({ id: "settings.linkPreviews.search" });
    content = (
      <>
        {searchable && (
          // DS InputGroup › a search field: the search icon first, a clear
          // button at the end once there is text. A text input, as Search's
          // own field: `type="search"` would add the browser's second ×.
          <InputGroup>
            <InputGroupAddon>
              <Search aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              value={query}
              onChange={changeQuery}
              aria-label={searchLabel}
              placeholder={searchLabel}
              suppressPasswordManager
              data-testid="link-preview-consents-search"
            />
            {query ? (
              <InputGroupAddon align="inline-end">
                <Button type="button" variant="ghost" size="icon-md" onClick={clearQuery} aria-label={formatMessage({ id: "search.clearSearch" })}>
                  <X aria-hidden />
                </Button>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
        )}
        {shownAllowed.length > 0 && (
          <section aria-labelledby={allowedHeadingId} className="grid gap-1.5" data-testid="link-preview-consents-allowed">
            <Text.Sans size="group" render={<h3 id={allowedHeadingId}>{formatMessage({ id: "settings.linkPreviews.allowedGroup" })}</h3>} />
            <ListRowGroup>
              {shownAllowed.map((choice) => (
                <LinkPreviewChoiceRow
                  key={choice.app.id}
                  choice={choice}
                  title={choice.app.name}
                  logo
                  allowing={false}
                  disabled={false}
                  onAllow={allow}
                  onRevoke={openRevoke}
                />
              ))}
            </ListRowGroup>
          </section>
        )}
        {shownDeclined.length > 0 && (
          <section aria-labelledby={declinedHeadingId} className="grid gap-1.5" data-testid="link-preview-consents-declined">
            <Text.Sans size="group" render={<h3 id={declinedHeadingId}>{formatMessage({ id: "settings.linkPreviews.declinedGroup" })}</h3>} />
            <ListRowGroup>
              {shownDeclined.map((choice) => (
                <LinkPreviewChoiceRow
                  key={choice.app.id}
                  choice={choice}
                  title={choice.app.name}
                  logo
                  allowing={allowingId === choice.app.id}
                  disabled={allowingId !== null && allowingId !== choice.app.id}
                  onAllow={allow}
                  onRevoke={openRevoke}
                />
              ))}
            </ListRowGroup>
          </section>
        )}
        {!shownAllowed.length && !shownDeclined.length && (
          <p className="m-0 py-4 text-center text-callout text-foreground-hint" data-testid="link-preview-consents-no-match">
            {formatMessage({ id: "settings.linkPreviews.noMatch" })}
          </p>
        )}
      </>
    );
  }

  return (
    <div ref={listRef} className="grid gap-4">
      {content}
      <LinkPreviewRevokeDialog {...revokeDialog} />
    </div>
  );
}

/**
 * Manage (DS Dialog, `md`, 448px: a list of Apps with one button each; on a
 * phone the bottom sheet a long, searchable list takes). Each answer applies
 * at once, so there is nothing to commit: no footer, × closes it, and the
 * sheet's head is only × and the title.
 */
function ManageDialogContent() {
  const { formatMessage } = useIntl();
  const searchRef = useRef<HTMLInputElement>(null);
  // With a search field, typing is what people came for; on touch the dialog
  // itself takes focus, so the keyboard doesn't open by itself.
  const initialFocus = useCallback(
    (openType: string): HTMLElement | true => (openType !== "touch" && searchRef.current) || true,
    [],
  );
  return (
    <DialogSheetContent initialFocus={initialFocus} data-testid="link-preview-manage-dialog">
      <DialogHeader>
        <DialogTitle>{formatMessage({ id: "settings.linkPreviews.title" })}</DialogTitle>
        <DialogClose aria-label={formatMessage({ id: "settings.common.close" })} />
      </DialogHeader>
      <DialogBody className="grid gap-4">
        <DialogDescription>{formatMessage({ id: "settings.linkPreviews.description" })}</DialogDescription>
        <ManageDialogList searchRef={searchRef} />
      </DialogBody>
    </DialogSheetContent>
  );
}

/** The Manage dialog with no App left: the DS empty state, its icon and title (no sentence on how one comes: HelperText step 1). */
function LinkPreviewConsentsEmpty({ className }: { className: string }) {
  const { formatMessage } = useIntl();
  return (
    <EmptyState
      className={className}
      icon={<Link />}
      title={formatMessage({ id: "settings.linkPreviews.emptyTitle" })}
      data-testid="link-preview-consents-empty"
    />
  );
}

/**
 * The Link Previews row at the bottom of Settings › Applications: how many
 * Apps the viewer allowed and declined, and Manage. No answers, no row; a
 * guest, who sees nothing else there, gets the quiet empty card instead.
 */
export function LinkPreviewConsentsRow({ guest = false }: { guest?: boolean }) {
  const { formatMessage } = useIntl();
  const { viewerKey, known } = useLinkPreviewViewer();
  const load = useLinkPreviewChoicesLoad(viewerKey);
  const [manageOpen, setManageOpen] = useState(false);
  // The dialog's content (it asks the viewport whether to be a sheet) is
  // mounted only while it is up or closing, not on every Applications render.
  const [manageMounted, setManageMounted] = useState(false);
  const counts = useChoiceCounts(load?.kind === "ready" ? load.choices : null);
  const title = formatMessage({ id: "settings.linkPreviews.title" });

  // Read on every visit; a list from an earlier visit stays up meanwhile.
  useEffect(() => {
    if (!known) return;
    const store = useLinkPreviewChoicesStore.getState();
    void store.read(viewerKey, { quiet: store.byViewer[viewerKey]?.kind === "ready" });
  }, [known, viewerKey]);
  const retry = useCallback(() => void useLinkPreviewChoicesStore.getState().read(viewerKey), [viewerKey]);
  const changeManageOpen = useCallback((open: boolean) => {
    setManageOpen(open);
    if (open) setManageMounted(true);
  }, []);
  const manageOpenChangeComplete = useCallback((open: boolean) => {
    if (!open) setManageMounted(false);
  }, []);

  let row = null;
  if (!load || load.kind === "loading") {
    // Members have the Apps above; a guest's page would be blank meanwhile.
    if (guest) {
      row = (
        <ListRowGroup aria-busy="true" data-testid="link-preview-consents-loading">
          <ListRowSkeleton variant="plain" description />
        </ListRowGroup>
      );
    }
  } else if (load.kind === "failed") {
    row = (
      <ListRowGroup data-testid="link-preview-consents-row">
        <ListRow variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle>{title}</ListRowTitle>
            <ListRowDescription wrap role="alert">{formatMessage({ id: "settings.linkPreviews.loadFailed" })}</ListRowDescription>
          </ListRowBody>
          <Button variant="default" onClick={retry}>{formatMessage({ id: "settings.linkPreviews.retry" })}</Button>
        </ListRow>
      </ListRowGroup>
    );
  } else if (counts) {
    row = (
      <ListRowGroup data-testid="link-preview-consents-row">
        <ListRow variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle>{title}</ListRowTitle>
            <ListRowDescription>{counts}</ListRowDescription>
          </ListRowBody>
          <DialogTrigger
            render={<Button variant="default" />}
            aria-label={formatMessage({ id: "settings.linkPreviews.manageLabel" })}
            data-testid="link-preview-consents-manage"
          >
            {formatMessage({ id: "settings.linkPreviews.manage" })}
          </DialogTrigger>
        </ListRow>
      </ListRowGroup>
    );
  } else if (guest) {
    // What a guest with no answers has always seen: the card's quiet version,
    // its title, so the page isn't blank. Not EmptyState, which
    // is for a whole view (Raft DS: never inside a card).
    row = (
      <Card variant="inset" data-testid="link-preview-consents-card">
        <CardHeader>
          <CardTitle render={<h2>{title}</h2>} />
          <CardDescription>{formatMessage({ id: "settings.linkPreviews.description" })}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="px-4 py-4 text-center" data-testid="link-preview-consents-empty">
            <p className="m-0 text-callout font-semibold text-foreground">{formatMessage({ id: "settings.linkPreviews.emptyTitle" })}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // The dialog outlives the row: an answer that empties the list (an App
  // uninstalled meanwhile) takes the row away, not the open dialog.
  return (
    <Dialog open={manageOpen} onOpenChange={changeManageOpen} onOpenChangeComplete={manageOpenChangeComplete}>
      {row}
      {manageMounted ? <ManageDialogContent /> : null}
    </Dialog>
  );
}

/**
 * The viewer's answer for one installed App, in that App's details: a section
 * at the level of its neighbours (the same eyebrow as Login with Raft access),
 * holding the Manage dialog's row for it, with the same words and the same
 * button, on the same list. Nothing when the viewer hasn't answered for it.
 */
export function LinkPreviewAppChoice({ appId }: { appId: string }) {
  const { formatMessage } = useIntl();
  const labelId = useId();
  const { viewerKey, known } = useLinkPreviewViewer();
  const load = useLinkPreviewChoicesLoad(viewerKey);
  const lineRef = useRef<HTMLElement>(null);
  const { allowingId, allow, openRevoke, revokeDialog } = useLinkPreviewAnswers(lineRef);

  // Applications' row reads the list; read it here only if nobody has.
  useEffect(() => {
    if (!known) return;
    const store = useLinkPreviewChoicesStore.getState();
    if (!store.byViewer[viewerKey]) void store.read(viewerKey);
  }, [known, viewerKey]);

  const choice = load?.kind === "ready" ? findLinkPreviewChoice(load.choices, appId) : null;
  if (!choice && !revokeDialog.open) return null;
  return (
    <section ref={lineRef} aria-labelledby={labelId} className="stack-y-2" data-testid="link-preview-app-choice">
      <SectionEyebrow as="div" id={labelId}>{formatMessage({ id: "settings.linkPreviews.title" })}</SectionEyebrow>
      {choice ? (
        <ListRowGroup>
          <LinkPreviewChoiceRow
            choice={choice}
            allowing={allowingId === choice.app.id}
            disabled={false}
            onAllow={allow}
            onRevoke={openRevoke}
          />
        </ListRowGroup>
      ) : null}
      <LinkPreviewRevokeDialog {...revokeDialog} />
    </section>
  );
}
