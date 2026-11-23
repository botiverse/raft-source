import { AvatarBadge, Badge, Button, Card, CardContent, CardTitle, Skeleton, Status, Text } from "@botiverse/raft-ui";
import { Ellipsis, SaveStatus, SaveStatusError } from "@botiverse/raft-ui/wip";
import type { AvatarBadgeOffset } from "@botiverse/raft-ui";
import { useCallback, useId } from "react";
import { Check, TriangleAlert } from "lucide-react";
import { useIntl } from "react-intl";
import { ConnectedAppLogo } from "../../components/settings/ConnectedAppLogo";
import { SkeletonTextBar } from "../../components/ui/Skeleton";
import { SKELETON_BUTTON_MD_CLASS } from "../../components/ui/skeletonBoxes";
import type { MessageId } from "../../i18n/messages/en";
import { appCardSourceParts } from "./appCardSource";
import type { AppCardState, AppView } from "./appView";

/**
 * One App as a card, drawn from an `AppView` (`appView.ts`): the logo, the
 * name (with Official for Raft's own), two lines of description, one line
 * that says where it came from, and at most one button. The whole card opens
 * the App's detail. Presentational: every press is a callback, and a button
 * the caller passes no callback for is not drawn (a member's view); without
 * `onOpen` the card is not a button at all (nothing opens for this viewer).
 *
 * - `variant="yours"`: an App this Server has. A state that needs someone
 *   (`AppView.state`) puts the attention dot on the logo, says the state in
 *   place of the source line, and offers its step as the button.
 * - `variant="discover"`: a listing. Add, or Added once this Server has it;
 *   no state. While its add runs, Add says Adding… and takes no press
 *   (`adding`); while another card's runs, it waits (`addDisabled`). A failed
 *   add says why on the card, under its text (`addError`, raft-ui's
 *   SaveStatus: an Add applies at once, like a setting that does).
 *
 * The card never names an App type, never says reviewed or unreviewed, and
 * shows no address: the source line is who made or listed it.
 */

/** A state that needs someone: the ones a card offers a step for. */
export type AppCardAction = Exclude<AppCardState, "normal">;

export interface AppCardProps {
  app: AppView;
  variant?: "yours" | "discover";
  /**
   * Who made an internal App ("Internal · made by {name}"): the caller
   * resolves `app.createdByUserId`. Without it the line says "Internal".
   */
  creatorName?: string | null;
  /**
   * The card itself: opens the App's detail. Leave it out when nothing opens
   * for this viewer: the card is then plain, with no cover button.
   */
  onOpen?: (app: AppView) => void;
  /**
   * The state's step (Review, Sign in, View). Leave it out for a viewer who
   * can't act: the state still shows, with no button.
   */
  onAction?: (state: AppCardAction, app: AppView) => void;
  /** Discover's Add. Leave it out for a viewer who can't add Apps. */
  onAdd?: (app: AppView) => void;
  /** Discover's Add is running for this card: it says Adding… and takes no press. */
  adding?: boolean;
  /** Another card's Add is running: this one waits, with no press. */
  addDisabled?: boolean;
  /** What this card's last Add failed with, under its text until the next Add. */
  addError?: string;
  testId?: string;
}

const STATUS_TEXT_ID: Record<AppCardAction, MessageId> = {
  updateNeedsApproval: "apps.card.statusUpdateNeedsApproval",
  signInExpired: "apps.card.statusSignedOut",
  cannotConnect: "apps.card.statusCannotConnect",
};

const ACTION_LABEL_ID: Record<AppCardAction, MessageId> = {
  updateNeedsApproval: "apps.card.actionReview",
  signInExpired: "apps.card.actionSignIn",
  cannotConnect: "apps.card.actionView",
};

// The card's parts, shared with its skeleton. The card is its own container:
// under 360px of card the button takes a line of its own under the text, so
// the name keeps the card's width on a phone.
const CARD_CLASS = "@container/app-card relative";
// The card shows its cover button's hover, press and focus (as a Marketplace
// card with a control on it, MarketplaceListingRow).
const CARD_OPEN_STATES_CLASS = "has-[[data-app-card-open]:hover]:overlay-subtle has-[[data-app-card-open]:active]:overlay-medium has-[[data-app-card-open]:focus-visible]:shadow-focus";
const CARD_GRID_CLASS = "grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 @[360px]/app-card:grid-cols-[auto_minmax(0,1fr)_auto]";
const CARD_BODY_CLASS = "flex min-w-0 flex-col gap-1";
const CARD_NAME_LINE_CLASS = "flex min-w-0 items-center gap-2";
// Two lines, always: a short description keeps the card's height.
const CARD_DESCRIPTION_CLASS = "h-[2lh]";
const CARD_SOURCE_LINE_CLASS = "min-h-[1lh]";
const CARD_TRAILING_CLASS = "relative col-start-2 flex min-w-0 items-center @[360px]/app-card:col-start-3 @[360px]/app-card:row-start-1";

/** The dot's centre on the logo's top-right corner (DS ListRow › States). */
const TOP_RIGHT: AvatarBadgeOffset = ["100%", 0];

/**
 * The mark on the logo of an App that needs someone: today's pink attention
 * pixel, for every state. Its shape and colour are one decision, kept here.
 * Decorative: the card's status line says the state in words.
 */
function AppCardAttentionDot() {
  return (
    <AvatarBadge
      offset={TOP_RIGHT}
      data-testid="app-card-attention-dot"
      render={<Status aria-hidden="true" variant="accent" size="sm" />}
    />
  );
}

export function AppCard({ app, variant = "yours", creatorName, onOpen, onAction, onAdd, adding = false, addDisabled = false, addError, testId }: AppCardProps) {
  const { formatMessage } = useIntl();
  const nameId = useId();
  const lineId = useId();
  const buttonId = useId();
  const addStatusId = useId();
  const handleOpen = useCallback(() => onOpen?.(app), [app, onOpen]);
  // A listing has no state of its own to show.
  const action: AppCardAction | null = variant === "yours" && app.state !== "normal" ? app.state : null;
  const handleAction = useCallback(() => {
    if (action) onAction?.(action, app);
  }, [action, app, onAction]);
  const handleAdd = useCallback(() => onAdd?.(app), [app, onAdd]);
  const source = appCardSourceParts(app, creatorName, formatMessage).join(" · ");

  let trailing = null;
  if (action && onAction) {
    trailing = (
      // Named by its label and the App: "Sign in Notion".
      <Button id={buttonId} aria-labelledby={`${buttonId} ${nameId}`} type="button" variant="default" size="md" onClick={handleAction} data-testid="app-card-action">
        <TriangleAlert aria-hidden="true" size={14} />
        {formatMessage({ id: ACTION_LABEL_ID[action] })}
      </Button>
    );
  } else if (variant === "discover" && app.added) {
    trailing = (
      <Text.Sans size="caption" variant="placeholder" render={<span />} className="inline-flex items-center gap-1" data-testid="app-card-added">
        <Check aria-hidden="true" size={14} />
        {formatMessage({ id: "apps.card.added" })}
      </Text.Sans>
    );
  } else if (variant === "discover" && onAdd) {
    trailing = (
      <Button
        id={buttonId}
        aria-labelledby={`${buttonId} ${nameId}`}
        aria-describedby={addError ? addStatusId : undefined}
        type="button"
        variant="default"
        size="md"
        disabled={adding || addDisabled}
        onClick={handleAdd}
        data-testid="app-card-add"
      >
        {formatMessage({ id: adding ? "apps.detail.adding" : "apps.card.add" })}
      </Button>
    );
  }

  return (
    <Card className={onOpen ? `${CARD_CLASS} ${CARD_OPEN_STATES_CLASS}` : CARD_CLASS} data-testid={testId} data-state={action ?? "normal"}>
      {/* A button can't hold a button: this one, named after the App, covers
          the card and opens it; the card's own button sits above it. The text
          lets the pointer through to it. */}
      {onOpen ? (
        <button
          type="button"
          aria-label={app.name}
          aria-describedby={lineId}
          onClick={handleOpen}
          data-app-card-open
          className="absolute inset-0 rounded-[inherit] outline-none"
        />
      ) : null}
      <CardContent className={`pointer-events-none ${CARD_GRID_CLASS}`}>
        <span className="relative inline-flex shrink-0">
          <ConnectedAppLogo name={app.name} logoUrl={app.logoUrl} seed={app.logoSeed} size="sm" />
          {action ? <AppCardAttentionDot /> : null}
        </span>
        <div className={CARD_BODY_CLASS}>
          <div className={CARD_NAME_LINE_CLASS}>
            <CardTitle id={nameId} className="min-w-0">
              <Ellipsis tooltip={false}>{app.name}</Ellipsis>
            </CardTitle>
            {app.official ? (
              <Badge appearance="outline" className="shrink-0" data-testid="app-card-official">
                {formatMessage({ id: "apps.card.official" })}
              </Badge>
            ) : null}
          </div>
          <Text.Sans size="small" className={CARD_DESCRIPTION_CLASS} data-testid="app-card-description">
            {app.description ? <Ellipsis lines={2} tooltip={false}>{app.description}</Ellipsis> : null}
          </Text.Sans>
          {action ? (
            <Text.Sans id={lineId} size="caption" className={`${CARD_SOURCE_LINE_CLASS} font-semibold text-warning-strong`} data-testid="app-card-status">
              <Ellipsis tooltip={false}>{formatMessage({ id: STATUS_TEXT_ID[action] })}</Ellipsis>
            </Text.Sans>
          ) : (
            <Text.Sans id={lineId} size="caption" className={CARD_SOURCE_LINE_CLASS} data-testid="app-card-source">
              {source ? <Ellipsis tooltip={false}>{source}</Ellipsis> : null}
            </Text.Sans>
          )}
          {variant === "discover" && onAdd ? (
            <SaveStatus id={addStatusId} data-testid="app-card-add-status">
              {addError ? <SaveStatusError>{addError}</SaveStatusError> : null}
            </SaveStatus>
          ) : null}
        </div>
        {trailing ? <div className={`pointer-events-auto ${CARD_TRAILING_CLASS}`}>{trailing}</div> : null}
      </CardContent>
    </Card>
  );
}

/**
 * A card while its list loads: the card's own box with the logo's 35px
 * square, a bar in the name, two in the description and one in the source
 * line, and a button's box where the caller's cards will have one.
 */
export function AppCardSkeleton({ button = false }: { button?: boolean }) {
  return (
    <Card className={CARD_CLASS} aria-hidden="true" data-skeleton="" data-testid="app-card-skeleton">
      <CardContent className={CARD_GRID_CLASS}>
        <Skeleton className="size-[35px] shrink-0" />
        <div className={CARD_BODY_CLASS}>
          <div className={CARD_NAME_LINE_CLASS}>
            <CardTitle className="min-w-0 flex-1"><SkeletonTextBar className="w-32" /></CardTitle>
          </div>
          <Text.Sans size="small" render={<div />} className={CARD_DESCRIPTION_CLASS}>
            <div><SkeletonTextBar className="w-full" /></div>
            <div><SkeletonTextBar className="w-2/3" /></div>
          </Text.Sans>
          <Text.Sans size="caption" render={<div />} className={CARD_SOURCE_LINE_CLASS}>
            <SkeletonTextBar className="w-24" />
          </Text.Sans>
        </div>
        {button ? (
          <div className={CARD_TRAILING_CLASS}><Skeleton className={`w-16 ${SKELETON_BUTTON_MD_CLASS}`} /></div>
        ) : null}
      </CardContent>
    </Card>
  );
}
