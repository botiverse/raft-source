// The dialog an `integration:install_marketplace_app` card's button opens,
// from the spec frame (ActionCardSpecCard, by the card's action
// key). The card asks only for the scopes one agent
// login needs, but installing approves the app's whole declaration on this
// Server, so the admin confirms that set here first.
//
// What the admin consents to comes from the server by the App's id, never from
// the card (Q1, Tenny 6cad605e): the App's name, the permissions installing
// approves and, with app_prompt_text_consent on, the text it adds to agent
// prompts are the App's Marketplace record (GET /integrations/marketplace, the
// row whose `id` is the card's `clientId`, through the cache Settings › Apps
// reads too: lib/marketplaceRecords), as Settings › Apps shows them. A
// card's fields are written by whoever prepared it, so none of them is shown
// here. The card's binding (the App's raw name by `clientNameSha256`,
// `installScopes` / `installGroups`, `installTextRevisionId`) is only
// compared: executing the card installs exactly that bound set, and only while
// it still matches the app, so a record that no longer matches the binding
// blocks Install here before anyone tries (and asks for a fresh request), and a
// later developer edit fails the confirm instead of slipping into the grant.

import { useCallback, useEffect, useEffectEvent, useId, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import {
  Banner,
  BannerAction,
  BannerDescription,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Spinner,
} from "@botiverse/raft-ui";
import { effectiveAllowedOAuthScopes, renderThirdPartyInertText, sha256Hex } from "@botiverse/raft-shared";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import api from "../../api/client";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../settings/secondFactorStepUp";
import type { MessageId } from "../../i18n/messages";
import { AppPermissionSetList } from "../integrations/AppPermissionSetList";
import { AppPromptTextSection } from "../integrations/AppPromptText";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../ui/NarrowDialog";
import type { MarketplaceOAuthClientRecord } from "../../features/apps/connected-apps/oauthClientRecords";
import { appTextChangedCurrent, installEntryPromptText } from "../../lib/appPromptText";
import type { AppPromptTextFields } from "../../lib/appPromptText";
import { forgetMarketplaceRecords, readMarketplaceRecords } from "../../lib/marketplaceRecords";
import { useAgentStore } from "../../store/agentStore";
import { APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";

type InstallCardAction = Extract<ActionCardMetadata["action"], { type: "integration:install_marketplace_app" }>;

interface ActionCardMutationResponse {
  messageId: string;
  metadata: ActionCardMetadata;
}

// 409s from executing an install card that no retry can fix: the card is bound
// to an app, an agent and a set of scopes, and one of them no longer matches.
// The server's message is English and tells the agent what to do, so the admin
// gets Raft's copy instead, and Install stays disabled.
const STALE_CARD_MESSAGE_IDS = {
  APP_PERMISSIONS_CHANGED: "actionCard.installDialog.permissionsChanged",
  MARKETPLACE_APP_CHANGED: "actionCard.installDialog.appChanged",
  SCOPE_BINDING_CHANGED: "actionCard.installDialog.scopesChanged",
  AGENT_BINDING_CHANGED: "actionCard.installDialog.agentChanged",
} as const satisfies Record<string, MessageId>;

function staleCardMessageId(code: string | undefined): MessageId | null {
  return code && Object.prototype.hasOwnProperty.call(STALE_CARD_MESSAGE_IDS, code)
    ? STALE_CARD_MESSAGE_IDS[code as keyof typeof STALE_CARD_MESSAGE_IDS]
    : null;
}

type ExecuteError = {
  response?: { status?: number; data?: { error?: string; code?: string } };
  message?: string;
} | null;

/** The App as this Server's Marketplace lists it: what the dialog shows. */
interface InstallRecord {
  /** The App's name to show, inert-rendered (escaped) as the Marketplace shows it. */
  name: string;
  /**
   * The App's name as the card binds it: the SHA-256 of the raw name
   * (`clientNameSha256`, bindMarketplaceAppName on the server). Null where this
   * browser can't hash (no WebCrypto).
   */
  rawNameSha256: string | null;
  /** Its service key (`clientId` on the record). */
  clientKey: string;
  scopes: string[];
  groups: string[];
  /** The text it adds to agent prompts, and that text's revision; null when the server sent none. */
  text: { revisionId: string; fields: AppPromptTextFields } | null;
  /** Still installable as an install card installs it: a public Marketplace App (actionCardsService). */
  installable: boolean;
}

/** The raw name's SHA-256, or null where this browser has no WebCrypto. */
async function rawNameSha256(name: string): Promise<string | null> {
  try {
    return await sha256Hex(name);
  } catch {
    return null;
  }
}

async function installRecordOf(record: MarketplaceOAuthClientRecord): Promise<InstallRecord> {
  return {
    name: renderThirdPartyInertText({ field: "app_name", value: record.name }),
    rawNameSha256: await rawNameSha256(record.name),
    clientKey: record.clientId,
    scopes: effectiveAllowedOAuthScopes(record.allowedScopes),
    groups: [...(record.appNotificationGroups ?? [])],
    text: record.promptTextRevisionId ? { revisionId: record.promptTextRevisionId, fields: installEntryPromptText(record) } : null,
    installable: record.appType === "third_party_global"
      && record.humanMarketplaceVisible
      && (record.publishStatus === "published" || record.publishStatus === "unpublish_requested"),
  };
}

type RecordLoad =
  | { status: "loading" }
  | { status: "failed" }
  /** `record` null: this Server's Marketplace no longer lists the App. */
  | { status: "loaded"; record: InstallRecord | null };

/**
 * The App's Marketplace record, by its id: a recent read of the list when there
 * is one (lib/marketplaceRecords), else a new one. `retry` reads it anew.
 * `onRead` gets each record read (null: the list no longer has the App).
 */
function useInstallRecord(clientId: string, onRead: (record: InstallRecord | null) => void): { load: RecordLoad; retry: () => void } {
  const read = useEffectEvent(onRead);
  // 0: the first read, which may reuse a recent answer; each Retry asks the server again.
  const [attempt, setAttempt] = useState(0);
  // The answer to one read (its key); a read whose answer hasn't come is loading.
  const [answer, setAnswer] = useState<{ key: string; load: RecordLoad } | null>(null);
  const key = `${clientId}#${attempt}`;
  useEffect(() => {
    let cancelled = false;
    void readMarketplaceRecords({ fresh: attempt > 0 })
      .then(
        async (records): Promise<RecordLoad> => {
          const record = records.find((candidate) => candidate.id === clientId);
          return { status: "loaded", record: record ? await installRecordOf(record) : null };
        },
        (): RecordLoad => ({ status: "failed" }),
      )
      .then((load) => {
        if (cancelled) return;
        setAnswer({ key, load });
        if (load.status === "loaded") read(load.record);
      });
    return () => { cancelled = true; };
  }, [attempt, clientId, key]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { load: answer?.key === key ? answer.load : LOADING, retry };
}

const LOADING: RecordLoad = { status: "loading" };

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/**
 * Why the record can't be installed from this card, before anyone tries: what
 * executing it would refuse with a 409 (actionCardsService), said before the
 * click (nothing was tried yet). Null: the record matches the card's binding.
 */
function staleBindingMessageId(action: InstallCardAction, record: InstallRecord, promptTextConsent: boolean): MessageId | null {
  // The App's raw name against the raw name the card bound (by its hash, as the
  // server checks it): the escaped name is for display only. Without WebCrypto,
  // the escaped name against the card's `clientName`, which the server stores
  // escaped the same way.
  const sameName = record.rawNameSha256 !== null
    ? record.rawNameSha256 === action.clientNameSha256
    : record.name === action.clientName;
  if (!record.installable || record.clientKey !== action.clientKey || !sameName) {
    return "actionCard.installDialog.beforeInstall.appChanged";
  }
  if (!sameSet(record.scopes, action.installScopes ?? []) || !sameSet(record.groups, action.installGroups ?? [])) {
    return "actionCard.installDialog.beforeInstall.permissionsChanged";
  }
  if (promptTextConsent && (record.text?.revisionId ?? null) !== (action.installTextRevisionId ?? null)) {
    return "actionCard.installDialog.beforeInstall.textChanged";
  }
  return null;
}

export function InstallAppCardDialog({
  action,
  messageId,
  confirmationVersion,
  onClose,
  onExecuted,
  onSubmitStart,
  onSubmitError,
}: {
  /** The card's action: the App's id to look up, the binding to compare, the agent who asked. Never shown as the App. */
  action: InstallCardAction;
  messageId: string;
  confirmationVersion?: number;
  onClose: () => void;
  onExecuted: (out: ActionCardMutationResponse) => void;
  onSubmitStart?: () => void;
  onSubmitError?: (error: unknown) => void;
}) {
  const { formatMessage } = useIntl();
  const titleId = useId();
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal no retry can fix: the agent has to prepare a fresh card.
  const [blocked, setBlocked] = useState(false);
  // Cards prepared before the server bound the set can't be executed (409).
  const bound = Array.isArray(action.installScopes) && Array.isArray(action.installGroups);
  const promptTextConsent = useServerFeatureFlag(APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY).enabled;
  // A record that no longer matches the card (or a list without the App): the App
  // moved, or the read reused here is behind it. Either way the next dialog reads
  // it anew, so a fresh card isn't judged by this read (Kirby, P6 review).
  const { load, retry } = useInstallRecord(action.clientId, (found) => {
    if (bound && (found === null || staleBindingMessageId(action, found, promptTextConsent) !== null)) forgetMarketplaceRecords();
  });
  const record = load.status === "loaded" ? load.record : null;
  // The agent who asked, as this Server names it (the server checks the card's name against it on execute).
  const agentName = useAgentStore((state) => {
    const agent = state.agents.find((candidate) => candidate.id === action.agentId);
    return agent ? agent.displayName || agent.name : null;
  }) ?? action.agentName;
  const shownText = promptTextConsent ? record?.text ?? null : null;
  const staleId = useMemo(
    () => (record && bound ? staleBindingMessageId(action, record, promptTextConsent) : null),
    [action, bound, promptTextConsent, record],
  );
  const copyValues = { client: record?.name ?? "", agent: agentName };
  const canInstall = bound && record !== null && staleId === null && !blocked;

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && !installing) onClose();
  }, [installing, onClose]);

  const handleInstall = useCallback(async () => {
    if (!canInstall || !record) return;
    setInstalling(true);
    setError(null);
    onSubmitStart?.();
    try {
      // No expected_* here: the server installs the set it stored on the card.
      // A card that needs a second factor is refused with 403 first: "Verify it's you", then once more.
      const { data } = await withSecondFactorStepUp(
        () => api.post<ActionCardMutationResponse>(
          `/actions/${messageId}/execute`,
          { expectedState: "prepared", expectedConfirmationVersion: confirmationVersion },
        ),
        "actionCard",
      );
      onExecuted(data);
    } catch (err) {
      // "Verify it's you" closed: nothing happened, the dialog stays as it was.
      if (isSecondFactorStepUpCancelled(err)) {
        setInstalling(false);
        return;
      }
      onSubmitError?.(err);
      const e = err as ExecuteError;
      // The app's text moved past the revision shown here: say so, not "permissions".
      const changedId = shownText && appTextChangedCurrent(err, shownText.revisionId)
        ? "actionCard.installDialog.textChanged"
        : e?.response?.status === 409 ? staleCardMessageId(e.response.data?.code) : null;
      if (changedId) {
        // The App moved on since the record shown here was read: the next dialog reads it anew.
        forgetMarketplaceRecords();
        setError(formatMessage({ id: changedId }, { client: record.name, agent: agentName }));
        setBlocked(true);
      } else {
        setError(e?.response?.data?.error ?? e?.message ?? formatMessage({ id: "actionCard.executeFailed" }));
      }
      setInstalling(false);
    }
  }, [agentName, canInstall, confirmationVersion, formatMessage, messageId, onExecuted, onSubmitError, onSubmitStart, record, shownText]);

  // What the dialog is about, in every state: it names the App only once its record is read, and
  // says it approves the set below only when that set is listed.
  const description = (
    <DialogDescription>
      {bound && record
        ? formatMessage({ id: "actionCard.installDialog.description" }, copyValues)
        : formatMessage({ id: "actionCard.installDialog.descriptionWithoutApp" }, { agent: agentName })}
    </DialogDescription>
  );
  let body;
  if (!bound) {
    body = (
      <Banner status="warning" size="sm" data-testid="install-app-card-unbound">
        {formatMessage({ id: "actionCard.installDialog.unbound" }, { agent: agentName })}
      </Banner>
    );
  } else if (load.status === "loading") {
    body = (
      <div className="flex justify-center py-6" data-testid="install-app-card-loading">
        <Spinner size="md" aria-label={formatMessage({ id: "common.loadingLabel" })} />
      </div>
    );
  } else if (load.status === "failed") {
    body = (
      <Banner status="warning" size="sm" role="alert" data-testid="install-app-card-load-failed">
        <BannerDescription>{formatMessage({ id: "apps.marketplace.loadFailed" })}</BannerDescription>
        <BannerAction>
          <Button type="button" variant="default" size="md" onClick={retry}>
            {formatMessage({ id: "actionCard.installDialog.retry" })}
          </Button>
        </BannerAction>
      </Banner>
    );
  } else if (!record) {
    body = (
      <Banner status="warning" size="sm" role="alert" data-testid="install-app-card-unavailable">
        {formatMessage({ id: "actionCard.installDialog.appUnavailable" }, { agent: agentName })}
      </Banner>
    );
  } else {
    body = (
      <>
        <AppPermissionSetList scopes={record.scopes} groups={record.groups} />
        {shownText ? <AppPromptTextSection fields={shownText.fields} service={record.clientKey} /> : null}
        {staleId ? (
          <Banner status="warning" size="sm" role="alert" data-testid="install-app-card-stale">
            {formatMessage({ id: staleId }, copyValues)}
          </Banner>
        ) : null}
      </>
    );
  }

  return (
    <Dialog open onOpenChange={handleOpenChange} disablePointerDismissal>
      <NarrowDialogContent
        narrow="sheet"
        aria-labelledby={titleId}
        data-testid="install-app-card-dialog"
        title={formatMessage({ id: "actionCard.verb.installApp" })}
        titleId={titleId}
        closeLabel={formatMessage({ id: "common.close" })}
        closeDisabled={installing}
        header={(
          <DialogHeader>
            {/* A dialog opened by a button takes that button's label, in sentence case. */}
            <DialogTitle id={titleId}>{formatMessage({ id: "actionCard.verb.installApp" })}</DialogTitle>
            <DialogClose aria-label={formatMessage({ id: "common.close" })} />
          </DialogHeader>
        )}
      >
        <DialogBody className="grid gap-4">
          {description}
          {body}
          {error ? <Banner status="warning" size="sm" role="alert">{error}</Banner> : null}
        </DialogBody>
        <DialogActions as={DialogFooter}>
          <Button type="button" variant="ghost" size="lg" onClick={onClose} disabled={installing}>
            {formatMessage({ id: "common.confirm.cancel" })}
          </Button>
          <DialogCommit>
            {(inHead) => (
              <Button
                type="button"
                variant="primary"
                size={inHead ? "md" : "lg"}
                loading={installing}
                disabled={!canInstall || installing}
                onClick={handleInstall}
              >
                {formatMessage({ id: "actionCard.installDialog.confirm" })}
              </Button>
            )}
          </DialogCommit>
        </DialogActions>
      </NarrowDialogContent>
    </Dialog>
  );
}
