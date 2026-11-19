import { useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Button, CopyableCode, CopyableCodeAction, CopyableCodeRoot, DialogDescription, Text } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import ConfirmDialog from "../../../components/ConfirmDialog";
import Banner from "../../../components/ui/Banner";
import type { MessageId } from "../../../i18n/messages";
import { ConnectedAppDetailSection } from "./ConnectedAppDetailSection";
import { ConnectedAppEditorActionRow } from "./ConnectedAppEditorActionRow";
import { ConnectedAppEditorSection } from "./ConnectedAppEditorSection";
import { useOwnServerCardButtons } from "../useOwnServerCardButtons";
import type { AllowCardButtonsOutcome, CardButtonsRead, OwnServerCardButtons, OwnServerCardButtonsState } from "./ownServerCardButtons";

const STATUS: Record<OwnServerCardButtonsState, MessageId> = {
  no_endpoint: "settings.connectedApps.cardButtons.status.off",
  off: "settings.connectedApps.cardButtons.status.off",
  not_allowed: "settings.connectedApps.cardButtons.status.off",
  on: "settings.connectedApps.cardButtons.status.on",
  allowed: "settings.connectedApps.cardButtons.status.allowed",
  pending_review: "settings.connectedApps.cardButtons.status.pendingReview",
  endpoint_changed: "settings.connectedApps.cardButtons.status.changed",
  suspended: "settings.connectedApps.cardButtons.status.paused",
};

type OpenDialog =
  /** `url`: the endpoint shown, and sent exactly; `changed`: it replaced the one shown before (409). */
  | { kind: "allow"; again: boolean; url: string; changed: boolean }
  /** Withdraw the allow (`allow`), or switch an own-Server App's buttons off. */
  | { kind: "revoke" };

/** An action endpoint, in mono with its copy button (raft-ui CopyableCode); long ones wrap. */
function ActionEndpoint({ url }: { url: string }) {
  const { formatMessage } = useIntl();
  return (
    <CopyableCodeRoot className="w-full min-w-0">
      <CopyableCode className="break-all" data-card-buttons-endpoint="">{url}</CopyableCode>
      <CopyableCodeAction aria-label={formatMessage({ id: "settings.connectedApps.cardButtons.copyEndpoint" })} />
    </CopyableCodeRoot>
  );
}

/**
 * The frame the section sits in: a section of the App editor (an App made on
 * this Server), or a section of an installed App's page.
 */
function Frame({ frame, status, children }: { frame: "editor" | "detail"; status: string; children: ReactNode }) {
  const { formatMessage } = useIntl();
  const title = formatMessage({ id: "settings.connectedApps.cardButtons.title" });
  const description = formatMessage({ id: "settings.connectedApps.cardButtons.description" });
  return frame === "editor" ? (
    <ConnectedAppEditorSection sectionId="card-buttons" title={title} description={description} status={status}>
      {children}
    </ConnectedAppEditorSection>
  ) : (
    <ConnectedAppDetailSection title={title} description={description}>
      <div className="grid gap-3" data-card-buttons-frame="detail">{children}</div>
    </ConnectedAppDetailSection>
  );
}

/**
 * The Card buttons section (RFC 076 §17; Kirby's drawings, #proj-apps:#60 and
 * #73): whether the buttons on this App's cards may act on this Server. In the
 * App editor (an App made here) and on an installed App's page. It draws what
 * the read gives it, deriving nothing:
 * - `official`: one line: Raft reviewed it, its buttons work everywhere, there
 *   is nothing to change here (an allow would be refused);
 * - an App made here (`own_server`), on by default: `on` (who switched it on
 *   and when, or "on by default"), Switch off; `off` (who switched it off),
 *   the endpoint in force, Switch on;
 * - an App from elsewhere (`allow`): `not_allowed`, the endpoint in force,
 *   copyable, and Allow; `allowed`, who allowed it and when (the date alone
 *   without a name), and Withdraw; `endpoint_changed`, a warning, the new
 *   endpoint, the one allowed before muted under it, and Allow again;
 *   `pending_review`, the new endpoint muted and that it can be allowed once
 *   Raft has reviewed it;
 * - both: `no_endpoint`, that the App has none, so its buttons only open
 *   links; `suspended`, an info banner (Raft can't verify the domain now) over
 *   the row, Withdraw or Switch off still there.
 * Allow, Withdraw and Switch off confirm in a small dialog, Cancel first;
 * Switch on, back to the default, does not. Allow repeats the endpoint and
 * sends exactly it; when the App changed it meanwhile the dialog stays open
 * with the new one and a warning, to be checked and allowed. There is no
 * view-only state: only owners and admins get an answer.
 */
export function ConnectedAppCardButtonsSection({ read, frame = "editor", appName, serverName, onAllow, onWithdraw }: {
  read: NonNullable<CardButtonsRead>;
  frame?: "editor" | "detail";
  appName: string;
  serverName: string;
  onAllow: (actionEndpoint: string) => Promise<AllowCardButtonsOutcome>;
  onWithdraw: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  if (read.kind === "official") {
    return (
      <Frame frame={frame} status={formatMessage({ id: "settings.connectedApps.cardButtons.status.on" })}>
        <div className="contents" data-card-buttons="official">
          <Text.Sans size="small" variant="muted">{formatMessage({ id: "settings.connectedApps.cardButtons.official" }, { app: appName })}</Text.Sans>
        </div>
      </Frame>
    );
  }
  return <CardButtonsView view={read.view} frame={frame} appName={appName} serverName={serverName} onAllow={onAllow} onWithdraw={onWithdraw} />;
}

function CardButtonsView({ view, frame, appName, serverName, onAllow, onWithdraw }: {
  view: OwnServerCardButtons;
  frame: "editor" | "detail";
  appName: string;
  serverName: string;
  onAllow: (actionEndpoint: string) => Promise<AllowCardButtonsOutcome>;
  onWithdraw: () => Promise<void>;
}) {
  const { formatMessage, formatDate } = useIntl();
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [switching, setSwitching] = useState(false);
  // A failed switch-on is about the state it was tried in: a new read (switched off, changed elsewhere) clears it.
  const [switchFailedOn, setSwitchFailedOn] = useState<OwnServerCardButtons | null>(null);
  const switchFailed = switchFailedOn === view;
  // Where focus goes when a dialog closes: the row's button (DS: the nearest related element).
  const actionRef = useRef<HTMLButtonElement>(null);
  const closeDialog = useCallback(() => setDialog(null), []);
  const failed = useCallback(() => new Error(formatMessage({ id: "settings.connectedApps.cardButtons.failed" })), [formatMessage]);

  const allowShown = useCallback(async () => {
    if (dialog?.kind !== "allow") return;
    let outcome: AllowCardButtonsOutcome;
    try {
      outcome = await onAllow(dialog.url);
    } catch {
      throw failed();
    }
    if (outcome.kind === "endpoint_changed") setDialog({ ...dialog, url: outcome.actionEndpoint, changed: true });
    else setDialog(null);
  }, [dialog, failed, onAllow]);
  const withdraw = useCallback(async () => {
    try {
      await onWithdraw();
    } catch {
      throw failed();
    }
  }, [failed, onWithdraw]);

  const { mode, state, actionEndpoint, pendingActionEndpoint, allowedActionEndpoint, changedAt, changedBy } = view;
  // Switching an own-Server App's buttons back on is going back to the default: no dialog. A changed endpoint (409)
  // reads the section again, which then shows the new one to switch on.
  const switchOn = useCallback(async () => {
    if (!actionEndpoint || switching) return;
    setSwitching(true);
    setSwitchFailedOn(null);
    try {
      await onAllow(actionEndpoint);
    } catch {
      setSwitchFailedOn(view);
    } finally {
      setSwitching(false);
    }
  }, [actionEndpoint, onAllow, switching, view]);

  const endpointTitle = formatMessage({ id: "settings.connectedApps.cardButtons.endpoint" });
  const actionButton = (label: MessageId, onClick: () => void, loading = false) => (
    <Button ref={actionRef} type="button" size="md" onClick={onClick} loading={loading} data-card-buttons-action="">
      {formatMessage({ id: label })}
    </Button>
  );
  const openAllow = (again: boolean) => () => { if (actionEndpoint) setDialog({ kind: "allow", again, url: actionEndpoint, changed: false }); };
  const when = changedAt ? formatDate(new Date(changedAt), { dateStyle: "medium" }) : "";
  // Who made the change in place and when, in the row's words; the date alone when Raft no longer knows who.
  const madeBy = (withName: MessageId, dateOnly: MessageId) => changedBy
    ? formatMessage({ id: withName }, { name: changedBy.name, date: when })
    : formatMessage({ id: dateOnly }, { date: when });

  return (
    <Frame frame={frame} status={formatMessage({ id: STATUS[state] })}>
      <div className="contents" data-card-buttons={state} data-card-buttons-mode={mode}>
        {state === "endpoint_changed" ? (
          <Banner intent="warning" density="sm" live={false} title={formatMessage({ id: "settings.connectedApps.cardButtons.changedTitle" })}>
            {formatMessage({ id: "settings.connectedApps.cardButtons.changedBody" })}
          </Banner>
        ) : null}
        {state === "suspended" ? (
          <Banner intent="info" density="sm" live={false} title={formatMessage({ id: "settings.connectedApps.cardButtons.pausedTitle" })}>
            {formatMessage({ id: "settings.connectedApps.cardButtons.pausedBody" })}
          </Banner>
        ) : null}
        {switchFailed ? (
          <Banner intent="warning" density="sm">{formatMessage({ id: "settings.connectedApps.cardButtons.failed" })}</Banner>
        ) : null}
        {state === "no_endpoint" ? (
          <ConnectedAppEditorActionRow title={endpointTitle} description={formatMessage({ id: "settings.connectedApps.cardButtons.noEndpoint" })} />
        ) : null}

        {/* An App made here: on by default, switched off and on. */}
        {mode === "own_server" && (state === "on" || state === "suspended") && actionEndpoint ? (
          <ConnectedAppEditorActionRow
            title={endpointTitle}
            description={changedAt
              ? madeBy("settings.connectedApps.cardButtons.onBy", "settings.connectedApps.cardButtons.onOn")
              : formatMessage({ id: "settings.connectedApps.cardButtons.onByDefault" })}
            action={actionButton("settings.connectedApps.cardButtons.switchOff", () => setDialog({ kind: "revoke" }))}
          >
            <ActionEndpoint url={actionEndpoint} />
          </ConnectedAppEditorActionRow>
        ) : null}
        {mode === "own_server" && state === "off" && actionEndpoint ? (
          <ConnectedAppEditorActionRow
            title={endpointTitle}
            description={changedAt
              ? madeBy("settings.connectedApps.cardButtons.offBy", "settings.connectedApps.cardButtons.offOn")
              : formatMessage({ id: "settings.connectedApps.cardButtons.offDescriptionOwn" })}
            action={actionButton("settings.connectedApps.cardButtons.switchOn", () => void switchOn(), switching)}
          >
            <ActionEndpoint url={actionEndpoint} />
          </ConnectedAppEditorActionRow>
        ) : null}

        {/* An App from elsewhere: allowed here, or not. */}
        {mode === "allow" && state === "pending_review" && pendingActionEndpoint ? (
          <ConnectedAppEditorActionRow title={endpointTitle} description={formatMessage({ id: "settings.connectedApps.cardButtons.pendingReview" })}>
            <Text.Mono size="meta" variant="muted" className="break-all" data-card-buttons-pending-endpoint="">{pendingActionEndpoint}</Text.Mono>
          </ConnectedAppEditorActionRow>
        ) : null}
        {mode === "allow" && state === "not_allowed" && actionEndpoint ? (
          <ConnectedAppEditorActionRow
            title={endpointTitle}
            description={formatMessage({ id: "settings.connectedApps.cardButtons.offDescription" })}
            action={actionButton("settings.connectedApps.cardButtons.allow", openAllow(false))}
          >
            <ActionEndpoint url={actionEndpoint} />
          </ConnectedAppEditorActionRow>
        ) : null}
        {mode === "allow" && (state === "allowed" || state === "suspended") && allowedActionEndpoint ? (
          <ConnectedAppEditorActionRow
            title={endpointTitle}
            description={madeBy("settings.connectedApps.cardButtons.allowedBy", "settings.connectedApps.cardButtons.allowedOn")}
            action={actionButton("settings.connectedApps.cardButtons.revoke", () => setDialog({ kind: "revoke" }))}
          >
            <ActionEndpoint url={allowedActionEndpoint} />
          </ConnectedAppEditorActionRow>
        ) : null}
        {mode === "allow" && state === "endpoint_changed" && actionEndpoint ? (
          <ConnectedAppEditorActionRow
            title={endpointTitle}
            description={formatMessage({ id: "settings.connectedApps.cardButtons.changedDescription" })}
            action={actionButton("settings.connectedApps.cardButtons.allowAgain", openAllow(true))}
          >
            <ActionEndpoint url={actionEndpoint} />
            {allowedActionEndpoint ? (
              <div className="grid gap-1">
                <Text.Sans size="small" variant="muted">{formatMessage({ id: "settings.connectedApps.cardButtons.allowedBefore" })}</Text.Sans>
                <Text.Mono size="meta" variant="muted" className="break-all" data-card-buttons-old-endpoint="">{allowedActionEndpoint}</Text.Mono>
              </div>
            ) : null}
          </ConnectedAppEditorActionRow>
        ) : null}
      </div>

      {dialog?.kind === "allow" ? (
        <ConfirmDialog
          title={formatMessage({ id: dialog.again ? "settings.connectedApps.cardButtons.allowDialog.againTitle" : "settings.connectedApps.cardButtons.allowDialog.title" })}
          message={(
            <div className="grid gap-3" data-card-buttons-dialog="allow">
              {dialog.changed ? (
                <Banner intent="warning" density="sm" data-card-buttons-changed-meanwhile="">
                  {formatMessage({ id: "settings.connectedApps.cardButtons.allowDialog.changedMeanwhile" }, { app: appName })}
                </Banner>
              ) : null}
              <DialogDescription>{formatMessage({ id: "settings.connectedApps.cardButtons.allowDialog.lead" }, { app: appName, server: serverName })}</DialogDescription>
              <ActionEndpoint url={dialog.url} />
              <DialogDescription>{formatMessage({ id: "settings.connectedApps.cardButtons.allowDialog.rest" }, { app: appName })}</DialogDescription>
            </div>
          )}
          plainMessage
          confirmLabel={formatMessage({ id: "settings.connectedApps.cardButtons.allowDialog.confirm" })}
          confirmVariant="primary"
          size="sm"
          layer={1}
          closeOnConfirm={false}
          finalFocus={actionRef}
          onConfirm={allowShown}
          onClose={closeDialog}
          confirmTestId="connected-app-card-buttons-allow-confirm"
        />
      ) : null}
      {dialog?.kind === "revoke" ? (
        <ConfirmDialog
          title={formatMessage({ id: mode === "own_server" ? "settings.connectedApps.cardButtons.switchOffDialog.title" : "settings.connectedApps.cardButtons.revokeDialog.title" })}
          message={formatMessage({ id: mode === "own_server" ? "settings.connectedApps.cardButtons.switchOffDialog.body" : "settings.connectedApps.cardButtons.revokeDialog.body" }, { app: appName })}
          confirmLabel={formatMessage({ id: mode === "own_server" ? "settings.connectedApps.cardButtons.switchOff" : "settings.connectedApps.cardButtons.revoke" })}
          confirmVariant="warning"
          size="sm"
          layer={1}
          finalFocus={actionRef}
          onConfirm={withdraw}
          onClose={closeDialog}
          confirmTestId="connected-app-card-buttons-revoke-confirm"
        />
      ) : null}
    </Frame>
  );
}

/**
 * Card buttons on the page of an App installed here (#proj-apps:#73): read only for owners and admins (others get
 * no answer, so nothing shows), as one section of the current page.
 */
export function InstalledAppCardButtons({ appId, appName, serverName }: { appId: string | null; appName: string; serverName: string }) {
  const cardButtons = useOwnServerCardButtons(appId, { installed: true });
  if (!cardButtons.view) return null;
  return (
    <ConnectedAppCardButtonsSection
      read={cardButtons.view}
      frame="detail"
      appName={appName}
      serverName={serverName}
      onAllow={cardButtons.allow}
      onWithdraw={cardButtons.withdraw}
    />
  );
}
