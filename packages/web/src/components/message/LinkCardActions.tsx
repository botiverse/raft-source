import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { RefObject } from "react";
import { useIntl } from "react-intl";
import { Ellipsis, TriangleAlert } from "lucide-react";
import {
  Banner,
  BannerDescription,
  Button,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemLabel,
  DropdownMenuTrigger,
  Spinner,
  Text,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  messageCard,
} from "@botiverse/raft-ui";
import { AppLinkCardActions, DropdownMenuLinkItem, PreviewCardActions } from "@botiverse/raft-ui/wip";
import { publicPreviewUrl } from "@botiverse/raft-shared/src/appLinkPreview";
import type { LinkCardV2 } from "@botiverse/raft-shared/src/appLinkPreview";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import LeavingRaftMark, { opensInNewTabAriaLabel } from "../ui/LeavingRaftMark";
import { AppLinkIcon } from "./AppLinkIcon";
import { appLinkDomain, appLinkOpenHref } from "../../utils/appLinkAddress";
import {
  cancelLinkCardAction,
  confirmLinkCardAction,
  linkCardViewKey,
  pressLinkCardButton,
  READ_BUSY_KEY,
  useLinkCardActionsUnavailable,
  useLinkCardViewState,
} from "./linkCardExecute";
import type { LinkCardButton, LinkCardConfirm } from "./linkCardExecute";
import { linkCardFormInputs, linkCardFormProblems, linkCardFormSecrets } from "./linkCardForm";
import type { LinkCardFormProblem } from "./linkCardForm";
import { LinkCardFormFields } from "./LinkCardFormFields";
import { LINK_CARD_COARSE_POINTER_QUERY, LINK_CARD_HOVER_QUERY } from "./linkCardRead";
import type { AppLinkResult } from "./useAppLinkPreviews";
import { webLinkProps } from "../../features/webPreview/webLinkRouting";

// The buttons of an App link's card, in its hover card or its block card
// (AppLinkBlockCard.tsx), and Raft's confirm dialog (addendum 5 §3; protocol
// v3.2.3 §4.4, §5.2). The flows are linkCardExecute.tsx; this draws them.

type CardResult = Extract<AppLinkResult, { kind: "card" }>;

/**
 * A v2 card's buttons in tree order, by element id. The hover card draws them
 * together in its actions row (DS PreviewCard › Item card), not where they sit
 * in the App's tree. The shared schema already refused a card with an execute
 * button that has neither `confirm: "prepare"` nor `undoWindowMs`.
 */
function linkCardButtons(card: LinkCardV2): Array<[string, LinkCardButton]> {
  const buttons: Array<[string, LinkCardButton]> = [];
  const visit = (id: string, depth: number) => {
    const node = Object.hasOwn(card.elements, id) ? card.elements[id] : undefined;
    if (!node || depth > 4) return;
    if (node.type === "Button") buttons.push([id, node.props]);
    else if (node.type === "Stack") for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(card.root, 0);
  return buttons;
}

const hasHandle = (result: CardResult, actionId: string) => !!result.actions?.some((action) => action.action_id === actionId);

/**
 * How many buttons the actions row shows (DS PreviewCard: "up to two small
 * buttons"). Which ones, and in which order, is Raft's (artin, Kirby,
 * 2026-10-31: one row, the main action at its right end):
 * - the App's execute buttons, the first LINK_CARD_ROW_BUTTONS in tree order;
 *   a card with none shows its first navigate link instead;
 * - in the row, frameless (`ghost`) buttons come first and the App's
 *   bordered (`default`) one last, at the right end;
 * - everything else (read buttons such as Refresh, the other links, any
 *   further execute button) is in the More menu (⋯) left of them, in tree
 *   order: never wrapped onto another line, never dropped.
 * The ⋯ and the row's buttons are one group on one line, at the card's end
 * (raft-ui); long labels (up to 40 characters) are cut with an ellipsis (Remy).
 */
const LINK_CARD_ROW_BUTTONS = 2;

/** What `busy` names a button by (LinkCardViewState.actionId); a link is never busy. */
const busyKey = (button: LinkCardButton): string | null =>
  (button.action.kind === "execute" ? button.action.action_id : button.action.kind === "read" ? READ_BUSY_KEY : null);

/**
 * Whether a button is a link to the item the card is about, such as Stamp's
 * Open in Stamp: a navigate button to the link's own address.
 */
function opensItem(button: LinkCardButton, url: string): boolean {
  const item = publicPreviewUrl(url)?.href;
  return button.action.kind === "navigate" && !!item && publicPreviewUrl(button.action.url)?.href === item;
}

/**
 * The row's buttons and the More menu's. The hover card's as
 * LINK_CARD_ROW_BUTTONS says. A block card's (DS AppLinkCard › Content): the
 * App's first LINK_CARD_ROW_BUTTONS buttons in its order, whatever they do,
 * but never a link to the item itself, which goes in ⋯ since the card's title
 * already opens it.
 */
function linkCardRowLayout<T extends [string, LinkCardButton]>(buttons: T[], block: { url: string } | null): { row: T[]; more: T[] } {
  const executes = buttons.filter(([, button]) => button.action.kind === "execute");
  const picked = block ? buttons.filter(([, button]) => !opensItem(button, block.url)).slice(0, LINK_CARD_ROW_BUTTONS)
    : executes.length ? executes.slice(0, LINK_CARD_ROW_BUTTONS)
    : buttons.filter(([, button]) => button.action.kind === "navigate").slice(0, 1);
  // Stable: frameless first, the bordered one at the right end.
  const row = [...picked.filter(([, button]) => button.variant === "ghost"), ...picked.filter(([, button]) => button.variant !== "ghost")];
  return { row, more: buttons.filter((entry) => !picked.includes(entry)) };
}

/**
 * The card's buttons, in raft-ui Buttons: `default` an ink border, `ghost`
 * frameless, the App's label as plain text, laid out by
 * linkCardRowLayout: a More menu (⋯) and up to two buttons, one group on
 * one line (raft-ui puts PreviewCardActions' buttons at the end). None in
 * the hover card on a touch-only device (the chip opens the link there;
 * addendum 5 §3); a block card keeps them. Only read and navigate ones once the
 * Server said its card actions are off. While the view is busy or its
 * operation is open, read and execute are disabled (in the menu too) and a
 * status line beside the buttons says so, with a Spinner while something
 * runs; that state is the view's, so it is there again when the card
 * reopens. The buttons are one group (raft-ui messageCard's actionGroup), so
 * when the row runs out of room the status line goes onto a line of its own
 * first and the buttons stay whole on theirs (DS Cards in messages › Buttons). A menu item that reads or prepares shows there, never on the ⋯,
 * which stays enabled (Remy). `placement`: the hover card's row
 * (PreviewCardActions) or a block card's (AppLinkCardActions), each with its
 * own layout (linkCardRowLayout).
 */
export function LinkCardActions({ result, owner, placement = "hover" }: { result: CardResult; owner: string; placement?: "hover" | "block" }) {
  const { formatMessage } = useIntl();
  const view = result.view;
  const viewKey = view ? linkCardViewKey(view, result.url) : null;
  const state = useLinkCardViewState(viewKey);
  const unavailable = useLinkCardActionsUnavailable(view);
  const statusId = useId();
  // Touch-only, kept current: the hover card is read-only there (a tablet that gets a mouse shows them);
  // a block card's buttons work by touch too (RFC 076 §13).
  const coarse = useMediaQuery(LINK_CARD_COARSE_POINTER_QUERY);
  const hovers = useMediaQuery(LINK_CARD_HOVER_QUERY);
  if (!result.cardV2 || !view || (placement === "hover" && coarse && !hovers)) return null;
  const buttons = linkCardButtons(result.cardV2).filter(([, button]) => {
    const { action } = button;
    if (action.kind === "navigate") return true;
    if (unavailable) return false;
    // An enabled execute button Raft signed no handle for can't run: not drawn.
    return action.kind === "read" || !!button.disabledReason || hasHandle(result, action.action_id);
  });
  if (!buttons.length) return null;
  const holding = state.busy === "holding";
  const blocked = !!state.busy || !!state.operation;
  const working = state.busy === "reading" || state.busy === "preparing" ? state.actionId : undefined;
  const { row: inRow, more } = linkCardRowLayout(buttons, placement === "block" ? { url: result.url } : null);
  const Actions = placement === "block" ? AppLinkCardActions : PreviewCardActions;
  // A menu item at work: its spinner is the status line's, the ⋯ stays as it is.
  const menuWorking = working !== undefined && more.some(([, button]) => busyKey(button) === working);
  const pending = !!state.operation || state.busy === "executing" || state.busy === "recovering" || state.busy === "refreshing";
  const status = holding ? "holding" : pending ? "pending" : menuWorking ? "working" : null;
  const describedBy = status ? statusId : undefined;
  return (
    <Actions data-link-card-actions={placement} aria-busy={pending || menuWorking || undefined}>
      {status ? (
        <Text.Sans
          id={statusId}
          role="status"
          size="small"
          variant="muted"
          className="flex min-w-0 items-center gap-1.5"
          data-link-card-pending={status}
        >
          {status === "holding" ? null : <Spinner size="xs" aria-hidden="true" />}
          {formatMessage({ id: status === "holding" ? "message.appLink.action.holding" : "message.appLink.action.working" })}
        </Text.Sans>
      ) : null}
      <div className={messageCard().actionGroup()} data-link-card-row-buttons="">
        {more.length ? <LinkCardMoreMenu result={result} buttons={more} owner={owner} blocked={blocked} describedBy={describedBy} /> : null}
        {inRow.map(([id, button]) => (
          <LinkCardButtonView
            key={id}
            result={result}
            button={button}
            owner={owner}
            blocked={blocked}
            loading={working !== undefined && working === busyKey(button)}
            describedBy={describedBy}
          />
        ))}
      </div>
    </Actions>
  );
}

/** A button of the group: the group wraps buttons whole first; only a single label wider than the card shrinks, cut with an ellipsis (and its tooltip shows it whole). */
const GROUP_BUTTON = "min-w-0 shrink [&>[data-slot=button-content]]:min-w-0 [&>[data-slot=button-content]]:max-w-full";

/** Whether a label is cut with an ellipsis now (wider than its box). */
const labelCut = (label: HTMLElement | null) => !!label && label.scrollWidth > label.clientWidth;

/**
 * A button of the card's row. It may shrink, its label cut with an
 * ellipsis: then hovering it (or focusing it) shows the full label in a
 * raft-ui Tooltip, as the DS gives a truncated name one; a label shown whole
 * gets none (the DS: don't repeat a visible label). Screen readers already
 * read the whole label, which stays in the button's text. A disabled button
 * with the App's reason keeps its tooltip with the reason, under the full
 * label when that is cut: then the reason is a second line in the HUD's
 * secondary text (`foreground-on-hud-muted`, DS Color), a small gap below it.
 */
function LinkCardButtonView({ result, button, owner, blocked, loading, describedBy }: {
  result: CardResult;
  button: LinkCardButton;
  owner: string;
  blocked: boolean;
  loading: boolean;
  describedBy: string | undefined;
}) {
  const { formatMessage } = useIntl();
  const reasonId = useId();
  const labelRef = useRef<HTMLSpanElement>(null);
  const [showLabel, setShowLabel] = useState(false);
  const press = useCallback(() => void pressLinkCardButton({ result, button, owner, format: formatMessage }), [result, button, owner, formatMessage]);
  const { action, label, disabledReason } = button;
  // Measured as the tooltip is about to open: the card's width, the UI language and the font decide whether the label is cut.
  const tooltipOpenChange = useCallback((open: boolean, details: { cancel: () => void }) => {
    if (!open) return;
    const cut = labelCut(labelRef.current);
    setShowLabel(cut);
    if (!cut && !disabledReason) details.cancel();
  }, [disabledReason]);
  const variant = button.variant === "ghost" ? "ghost" : "default";
  const disabled = !!disabledReason || (action.kind !== "navigate" && blocked);
  // Only http(s), in a new tab without opener or referrer, like the chip.
  const href = action.kind === "navigate" && !disabledReason ? appLinkOpenHref(action.url) : null;
  if (action.kind === "navigate" && !disabledReason && !href) return null;
  // focusableWhenDisabled: a disabled button stays in the keyboard path, so
  // its reason (or the pending line) is read out and Tab moves on through the card.
  const control = href ? (
    <Button
      variant={variant}
      nativeButton={false}
      role="link"
      render={<a href={href} target="_blank" rel="noopener noreferrer" {...webLinkProps} aria-label={opensInNewTabAriaLabel(formatMessage, label)} />}
      className={GROUP_BUTTON}
      data-link-card-button="navigate"
    >
      <span ref={labelRef} className="truncate" data-link-card-label="">{label}</span>
      <LeavingRaftMark data-icon="inline-end" />
    </Button>
  ) : (
    <Button
      variant={variant}
      disabled={disabled}
      focusableWhenDisabled
      loading={loading}
      loadingLabel={formatMessage({ id: "message.appLink.action.working" })}
      aria-describedby={disabledReason ? reasonId : describedBy}
      onClick={press}
      className={GROUP_BUTTON}
      data-link-card-button={action.kind}
      data-link-card-action={action.kind === "execute" ? action.action_id : undefined}
    >
      <span ref={labelRef} className="truncate" data-link-card-label="">{label}</span>
    </Button>
  );
  return (
    <>
      <Tooltip onOpenChange={tooltipOpenChange}>
        <TooltipTrigger render={control} />
        <TooltipContent data-link-card-tooltip="">
          {showLabel ? <span className="block" data-link-card-tooltip-label="">{label}</span> : null}
          {disabledReason ? (
            // Under the whole label, the reason is the second line: secondary text on the HUD, 4 px below it (Kirby).
            <span className={showLabel ? "mt-1 block text-foreground-on-hud-muted" : "block"} data-link-card-tooltip-reason="">{disabledReason}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
      {disabledReason ? <span id={reasonId} className="sr-only" data-link-card-disabled-reason="">{disabledReason}</span> : null}
    </>
  );
}

/**
 * The buttons the row doesn't show (linkCardRowLayout), as the items of a
 * DS DropdownMenu opened from a frameless ⋯ (Kirby), in tree order. An item
 * runs like its button would; a navigate one is a link item. Disabled with the view (described by the
 * status line), or with the App's `disabledReason` as its second line and
 * description: an item can't carry a tooltip. The ⋯ itself is never loading
 * or disabled: while an item reads or prepares, the status line under the
 * buttons shows it (Remy). Focus comes back to the ⋯ when the menu closes.
 */
function LinkCardMoreMenu({ result, buttons, owner, blocked, describedBy }: {
  result: CardResult;
  buttons: Array<[string, LinkCardButton]>;
  owner: string;
  blocked: boolean;
  describedBy: string | undefined;
}) {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: "message.appLink.action.more" });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            variant="ghost"
            size="icon-md"
            aria-label={label}
            aria-describedby={describedBy}
            data-link-card-more=""
          />
        )}
      >
        <Ellipsis aria-hidden="true" />
      </DropdownMenuTrigger>
      {/* Opens down and to the left of the ⋯: the group sits at the card's end, so the menu stays inside the card's width (Kirby). */}
      <DropdownMenuContent align="end" aria-label={result.title} data-link-card-more-menu="">
        {buttons.map(([id, button]) => (
          <LinkCardMenuItem key={id} result={result} button={button} owner={owner} blocked={blocked} describedBy={describedBy} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LinkCardMenuItem({ result, button, owner, blocked, describedBy }: {
  result: CardResult;
  button: LinkCardButton;
  owner: string;
  blocked: boolean;
  /** The status line, while the view is busy or pending. */
  describedBy: string | undefined;
}) {
  const { formatMessage } = useIntl();
  const reasonId = useId();
  const press = useCallback(() => void pressLinkCardButton({ result, button, owner, format: formatMessage }), [result, button, owner, formatMessage]);
  const { action, label, disabledReason } = button;
  if (action.kind === "navigate" && !disabledReason) {
    // A link item: opens in a new tab without opener or referrer, like the chip, and can be copied.
    const href = appLinkOpenHref(action.url);
    if (!href) return null;
    return (
      <DropdownMenuLinkItem
        closeOnClick
        render={<a href={href} target="_blank" rel="noopener noreferrer" {...webLinkProps} aria-label={opensInNewTabAriaLabel(formatMessage, label)} />}
        data-link-card-button="navigate"
      >
        <DropdownMenuItemLabel>{label}</DropdownMenuItemLabel>
        <LeavingRaftMark />
      </DropdownMenuLinkItem>
    );
  }
  return (
    <DropdownMenuItem
      disabled={!!disabledReason || blocked}
      onClick={press}
      aria-describedby={disabledReason ? reasonId : blocked ? describedBy : undefined}
      data-link-card-button={action.kind}
      data-link-card-action={action.kind === "execute" ? action.action_id : undefined}
    >
      {disabledReason ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <DropdownMenuItemLabel>{label}</DropdownMenuItemLabel>
          <span id={reasonId} className="text-footnote font-normal break-words [overflow-wrap:anywhere]" data-link-card-disabled-reason="">{disabledReason}</span>
        </span>
      ) : <DropdownMenuItemLabel>{label}</DropdownMenuItemLabel>}
    </DropdownMenuItem>
  );
}

/**
 * Raft's confirm dialog for an action that asked for `confirm: "prepare"`
 * (protocol §5.2; addendum 5 §3): a confirmation, so a raft-ui Dialog at
 * `size="sm"` (DS PreviewCard › Item card, Dialog › Variants), outside the
 * hover card, so moving the pointer away or the card closing neither closes
 * nor cancels it. Cancel first, the confirm last; the confirm is `primary`
 * because the protocol says only that the action does something, not that it
 * interrupts or can't be undone (DS AlertDialog › Variants).
 * It shows only the description's title, body, rows and fine print, as plain
 * text, with the App's confirm and cancel labels, and Raft's own line saying
 * which App and host ask. Drawn by the chip that asked; Cancel, Esc and that
 * chip going away send nothing.
 *
 * For an App Raft hasn't reviewed (`app.reviewed: false`, RFC 076 §17), Raft
 * adds "Run by {App}" with the App's stored icon under the title, and its last
 * line says the App was made on this Server, isn't reviewed by Raft, gets the
 * person's name and acts with its own access, in place of the App and host
 * line; the dialog is described by it. It asks before each of that App's
 * acting buttons: an undo-window one has no description, so the title is its
 * label, the confirm its label and the cancel Raft's (Kirby, #proj-apps:#60).
 *
 * A form on an App-sent card's acting button (RFC 086 §5.1, `confirm.form`)
 * is filled in here: a small task, so `size="md"` (DS Dialog › Variants), not
 * closed by a click outside it. For an App Raft hasn't reviewed, the notice
 * moves above the fields, in a warning Banner (DS Dialog › Rules: what people
 * must read before they act), so it is read before anything is typed. The
 * values are read from the fields only when the dialog is confirmed, and go
 * with the dialog when it closes (LinkCardFormFields.tsx); a SecretInput's
 * are handed over to be sealed (linkCardSeal.ts) and its field emptied.
 */
export function LinkCardConfirmDialog({ result, owner, finalFocus }: { result: CardResult; owner: string; finalFocus: RefObject<HTMLElement | null> }) {
  const view = result.view;
  const viewKey = view ? linkCardViewKey(view, result.url) : null;
  const confirm = useLinkCardViewState(viewKey).confirm;
  const mine = !!viewKey && confirm?.owner === owner;
  useEffect(() => {
    if (!mine || !viewKey) return;
    return () => cancelLinkCardAction(viewKey);
  }, [mine, viewKey]);
  if (!mine || !confirm || !viewKey) return null;
  // One mount per press: a form's fields (and what was typed in them) never outlive the dialog that asked.
  return <OpenLinkCardConfirmDialog key={confirm.kind === "prepared" ? confirm.prepared.id : `run:${confirm.label}`} result={result} viewKey={viewKey} confirm={confirm} finalFocus={finalFocus} />;
}

function OpenLinkCardConfirmDialog({ result, viewKey, confirm, finalFocus }: { result: CardResult; viewKey: string; confirm: LinkCardConfirm; finalFocus: RefObject<HTMLElement | null> }) {
  const { formatMessage } = useIntl();
  const bodyId = useId();
  const noticeId = useId();
  const fields = useRef(new Map<string, HTMLInputElement>());
  const [problems, setProblems] = useState<Record<string, LinkCardFormProblem>>({});
  const { executing, unreviewed, form } = confirm;
  const openChange = useCallback((open: boolean) => { if (!open) cancelLinkCardAction(viewKey); }, [viewKey]);
  const confirmAction = useCallback(() => {
    if (!form) { void confirmLinkCardAction(viewKey); return; }
    if (executing) return;
    const values = new Map(form.fields.map((field) => [field.id, fields.current.get(field.id)?.value ?? ""]));
    const found = linkCardFormProblems(form, values);
    setProblems(found);
    const invalid = form.fields.find((field) => found[field.id]);
    if (invalid) { fields.current.get(invalid.id)?.focus(); return; }
    const secrets = linkCardFormSecrets(form, values);
    // SecretInput values are sealed for a prepared action's execute only (RFC 086 §5.1): never through an undo window.
    if (secrets && confirm.kind !== "prepared") return;
    // Handed over to be sealed (linkCardSeal.ts clears them once sealed): the masked fields are emptied now.
    for (const field of form.fields) {
      const input = field.type === "SecretInput" ? fields.current.get(field.id) : undefined;
      if (input) input.value = "";
    }
    void confirmLinkCardAction(viewKey, linkCardFormInputs(form, values), secrets);
  }, [form, executing, viewKey, confirm.kind]);
  // A SecretInput refused input past its byte limit (LinkCardFormFields): it says so now, not on confirm.
  const tooLong = useCallback((fieldId: string) => setProblems((current) => ({ ...current, [fieldId]: "tooLong" })), []);
  // A form's first field takes focus when the dialog opens (Base UI's default otherwise).
  const firstField = useCallback(() => (form ? fields.current.get(form.fields[0]!.id) ?? true : true), [form]);
  const description = confirm.kind === "prepared" ? confirm.description : null;
  const title = description ? description.title
    : form && confirm.kind === "run" ? confirm.label
    : formatMessage({ id: "message.appLink.action.unreviewed.runTitle" }, { label: confirm.kind === "run" ? confirm.label : "" });
  const domain = appLinkDomain(result.url);
  // Read out with the title: the App's body, then Raft's notice, which is the one place the person learns Raft hasn't reviewed it.
  const describedBy = unreviewed ? [description?.body ? bodyId : null, noticeId].filter(Boolean).join(" ") : undefined;
  const notice = formatMessage({ id: "message.appLink.action.unreviewed.notice" }, { app: result.app.name });
  return (
    <Dialog open onOpenChange={openChange} disablePointerDismissal={!!form}>
      <DialogContent size={form ? "md" : "sm"} initialFocus={form ? firstField : undefined} finalFocus={finalFocus} aria-busy={executing || undefined} aria-describedby={describedBy} data-link-card-confirm={confirm.kind}>
        <DialogHeader>
          <DialogTitle className="break-words [overflow-wrap:anywhere]">{title}</DialogTitle>
          <DialogClose disabled={executing} aria-label={formatMessage({ id: "common.confirm.closeDialog" })} data-link-card-confirm-close="" />
        </DialogHeader>
        <DialogBody className="grid gap-3">
          {/* Who is speaking, before the App's own words: the title, body, rows and button labels of a prepared
              action are the App's, so its icon and name come first (W3 of the #13978 review). */}
          {unreviewed || description ? (
            <div className="flex min-w-0 items-center gap-2" data-link-card-confirm-run-by={unreviewed ? "" : undefined} data-link-card-confirm-from={unreviewed ? undefined : ""}>
              <AppLinkIcon app={result.app} frame="card" />
              <Text.Sans size="small" className="min-w-0 truncate font-semibold text-foreground">
                {formatMessage({ id: unreviewed ? "message.appLink.action.unreviewed.runBy" : "message.appLink.action.confirmFrom" }, { app: result.app.name })}
              </Text.Sans>
            </div>
          ) : null}
          {description?.body ? (
            <DialogDescription id={bodyId} className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]" data-link-card-confirm-body="">{description.body}</DialogDescription>
          ) : null}
          {description?.rows?.length ? (
            <DescriptionList direction="horizontal" className="w-full" data-link-card-confirm-rows="">
              {description.rows.map((row, index) => (
                <DescriptionItem key={index}>
                  <DescriptionTerm className="break-words [overflow-wrap:anywhere]">{row.label}</DescriptionTerm>
                  <DescriptionDetails className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{row.value}</DescriptionDetails>
                </DescriptionItem>
              ))}
            </DescriptionList>
          ) : null}
          {description?.fine_print ? (
            <Text.Sans size="small" variant="muted" className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]" data-link-card-confirm-fine-print="">
              {description.fine_print}
            </Text.Sans>
          ) : null}
          {form && unreviewed ? (
            <Banner status="warning" data-link-card-confirm-source="unreviewed">
              <TriangleAlert />
              <BannerDescription id={noticeId} className="break-words [overflow-wrap:anywhere]">{notice}</BannerDescription>
            </Banner>
          ) : null}
          {form ? <LinkCardFormFields form={form} app={result.app.name} problems={problems} inputs={fields} disabled={executing} onSubmit={confirmAction} onTooLong={tooLong} /> : null}
          {form && unreviewed ? null : unreviewed ? (
            <Text.Sans id={noticeId} size="small" variant="muted" className="break-words [overflow-wrap:anywhere]" data-link-card-confirm-source="unreviewed">
              {notice}
            </Text.Sans>
          ) : (
            <Text.Sans size="small" variant="muted" className="break-all" data-link-card-confirm-source="">
              {formatMessage({ id: "message.appLink.action.confirmSource" }, { app: result.app.name, domain: domain ?? "" })}
            </Text.Sans>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="lg" />} disabled={executing} data-link-card-confirm-cancel="">
            {description ? description.cancel_label : formatMessage({ id: "common.confirm.cancel" })}
          </DialogClose>
          {/* focusableWhenDisabled: the confirm keeps focus while execute is on its way. */}
          <Button
            focusableWhenDisabled
            variant="primary"
            size="lg"
            loading={executing}
            loadingLabel={formatMessage({ id: "message.appLink.action.working" })}
            onClick={confirmAction}
            data-link-card-confirm-action=""
          >
            {description ? description.confirm_label : confirm.kind === "run" ? confirm.label : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
