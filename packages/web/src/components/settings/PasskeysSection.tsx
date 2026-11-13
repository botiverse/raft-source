/**
 * Settings › Account › Passkeys (#triage:#135, design v2 set-on / set-menu /
 * set-menu-last / set-unsupported / set-add-cancel / set-add-exists /
 * dlg-reauth-password / dlg-rename / dlg-delete / dlg-stepup): list, add,
 * rename and delete the person's passkeys. Sits before Two-step
 * verification.
 *
 * The server (routes/secondFactor.ts, services/secondFactor/passkeyManagement.ts)
 * decides what proof each change needs:
 *   - Adding: with two-step verification off, a recent sign-in or the
 *     password again (POST /passkeys/registration/options answers 403
 *     `reauth_required`; POST /reauth/password, then options again); with it
 *     on, a step-up answer in the options request itself (403
 *     `step_up_required` with `methods`: a code, a backup code or a passkey).
 *     Then the browser creates the passkey and POST /registration/verify
 *     stores it. A closed prompt or a passkey this device already has says so
 *     in the card (A6, set-add-cancel, set-add-exists).
 *   - Deleting: confirmed first; with two-step verification on, a step-up
 *     answer too, and never the last way to verify (A7: the menu item is
 *     disabled and the reason sits under the list, its "turn off two-step
 *     verification" opening Turn Off in the section below).
 *   - Renaming: just the new name.
 * A change here reloads Two-step verification too (its Passkeys row counts
 * them), and a change there reloads this (useSecondFactorSettings).
 *
 * Not here yet (design): re-authenticating with Google / GitHub / Apple for
 * an account without a password (dlg-reauth-provider; this says to sign in
 * again instead).
 */
import {
  Badge,
  Button,
  DialogDescription,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconTile,
  Input,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  TextLink,
} from "@botiverse/raft-ui";
import { EllipsisVertical, KeyRound, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { useIntl } from "react-intl";

import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { SignInSecondFactorMethod } from "../auth/secondFactorSignIn";
import {
  canCreatePasskeys,
  createPasskey,
  isPasskeyAlreadyOnDevice,
  isPasskeyCancel,
} from "../auth/webauthn";
import type { PasskeyCreationOptionsJSON } from "../auth/webauthn";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import SectionHeader from "../ui/SectionHeader";
import AppTooltip from "../ui/Tooltip";
import {
  fetchSecondFactorStatus,
  finishPasskeyRegistration,
  listPasskeys,
  reauthenticateWithPassword,
  removePasskey,
  renamePasskey,
  secondFactorFailureOf,
  startPasskeyRegistration,
} from "./secondFactorApi";
import type { PasskeySummary, SecondFactorStatus, StepUpAnswer } from "./secondFactorApi";
import {
  AnswerField,
  CancelButton,
  CommitButton,
  DoneButton,
  StepDialog,
  requestTurnOff,
  secondFactorSettingsChanged,
  useSecondFactorSettings,
} from "./TwoStepVerificationSection";
import { useAnswer, useFailureCopy } from "./secondFactorAnswer";
import type { FailureCopy } from "./secondFactorAnswer";
import VerifyItsYouDialog from "./VerifyItsYouDialog";

type Notice = { intent: "info" | "warning"; message: string };

/** The section (its `auth_second_factor_v1` gate is retired, #raft-architecture:#32). */
export default function PasskeysSection({ passwordConfigured }: { passwordConfigured: boolean | null }) {
  return <PasskeysCard passwordConfigured={passwordConfigured} />;
}

type Loaded = { passkeys: PasskeySummary[]; status: SecondFactorStatus };

type OpenDialog =
  | { kind: "reauth" }
  | { kind: "noPassword" }
  | { kind: "verifyAdd"; methods: SignInSecondFactorMethod[] }
  | { kind: "rename"; passkey: PasskeySummary }
  | { kind: "delete"; passkey: PasskeySummary };

function PasskeysCard({ passwordConfigured }: { passwordConfigured: boolean | null }) {
  const { formatMessage } = useIntl();
  // undefined: loading; null: the server says the feature is not there (404).
  // One state for the read, so an answer sets it once (loadFailed keeps the rows on screen).
  const [load, setLoad] = useState<{ loaded: Loaded | null | undefined; loadFailed: boolean }>({ loaded: undefined, loadFailed: false });
  const { loaded, loadFailed } = load;
  const revision = useSecondFactorSettings((state) => state.revision);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const creatable = useMemo(() => canCreatePasskeys(), []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listPasskeys(), fetchSecondFactorStatus()]).then(([passkeys, status]) => {
      if (cancelled) return;
      setLoad({ loaded: { passkeys, status }, loadFailed: false });
    }, (err: unknown) => {
      if (cancelled) return;
      // The server evaluates the flag for the person alone: its 404 is the final word.
      const off = secondFactorFailureOf(err).status === 404;
      setLoad((current) => (off ? { ...current, loaded: null } : { ...current, loadFailed: true }));
    });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const closeDialog = useCallback(() => setDialog(null), []);

  /** The browser creates the passkey for `options`, the server stores it; what went wrong says so in the card. */
  const createAndStore = useCallback(async (options: PasskeyCreationOptionsJSON) => {
    setAdding(true);
    try {
      await finishPasskeyRegistration(await createPasskey(options));
      secondFactorSettingsChanged();
    } catch (err) {
      const code = secondFactorFailureOf(err).code;
      if (isPasskeyCancel(err)) {
        setNotice({ intent: "info", message: formatMessage({ id: "settings.passkeys.addCancelled" }) });
      } else if (isPasskeyAlreadyOnDevice(err) || code === "passkey_already_registered") {
        setNotice({ intent: "warning", message: formatMessage({ id: "settings.passkeys.alreadyExists" }) });
      } else if (code === "passkeys_unavailable") {
        setNotice({ intent: "warning", message: formatMessage({ id: "settings.passkeys.unavailable" }) });
      } else {
        setNotice({ intent: "warning", message: formatMessage({ id: "settings.passkeys.addFailed" }) });
      }
    } finally {
      setAdding(false);
    }
  }, [formatMessage]);

  const handleAdd = useCallback(async () => {
    if (adding) return;
    setNotice(null);
    setAdding(true);
    let options: PasskeyCreationOptionsJSON;
    try {
      options = await startPasskeyRegistration();
    } catch (err) {
      setAdding(false);
      const failure = secondFactorFailureOf(err);
      if (failure.code === "reauth_required") {
        setDialog({ kind: passwordConfigured === false ? "noPassword" : "reauth" });
      } else if (failure.code === "step_up_required") {
        setDialog({ kind: "verifyAdd", methods: failure.methods });
      } else if (failure.code === "passkeys_unavailable") {
        setNotice({ intent: "warning", message: formatMessage({ id: "settings.passkeys.unavailable" }) });
      } else {
        setNotice({ intent: "warning", message: formatMessage({ id: "common.confirm.somethingWentWrong" }) });
      }
      return;
    }
    await createAndStore(options);
  }, [adding, createAndStore, formatMessage, passwordConfigured]);

  const handleAddClick = useCallback(() => {
    void handleAdd();
  }, [handleAdd]);

  /** After the password or a step-up answer: options, then the browser's prompt. */
  const continueAdd = useCallback(async (answer?: StepUpAnswer) => {
    const options = await startPasskeyRegistration(answer);
    setDialog(null);
    void createAndStore(options);
  }, [createAndStore]);

  const answerAdd = useCallback((answer: StepUpAnswer) => continueAdd(answer), [continueAdd]);
  const afterReauth = useCallback(() => continueAdd(), [continueAdd]);
  const handleRename = useCallback((passkey: PasskeySummary) => setDialog({ kind: "rename", passkey }), []);
  const handleDelete = useCallback((passkey: PasskeySummary) => setDialog({ kind: "delete", passkey }), []);
  const handleChanged = useCallback(() => {
    setDialog(null);
    secondFactorSettingsChanged();
  }, []);

  if (loaded === null) return null;
  if (loaded === undefined && !loadFailed) return null;

  const passkeys = loaded?.passkeys ?? [];
  // design A7: with two-step verification on, the only passkey goes only while an authenticator app stays.
  const lastFactor = loaded?.status.enabled === true && !loaded.status.methods.totp && passkeys.length === 1;

  return (
    // id: /settings/account#passkeys opens Account at this section (useScrollToSettingsSection).
    <div id="passkeys" className="mb-6 scroll-mt-4" data-testid="passkeys-section">
      <SectionHeader
        className="mb-3"
        icon={<KeyRound size={16} />}
        label={formatMessage({ id: "settings.passkeys.sectionLabel" })}
      />
      {/* Settings rows (DS Forms › A setting's row; cindyz, #proj-raft-ui:#220): Passkeys
          with Add at its end (under the text where the row is under 32rem wide), then
          one row per passkey; the last-factor reason sits under the list (A7). */}
      {!loaded ? (
        <Banner intent="warning" density="sm">{formatMessage({ id: "settings.passkeys.loadFailed" })}</Banner>
      ) : (
        <>
          <ListRowGroup className="@container" data-testid="passkeys-rows">
            <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
              <ListRowBody>
                <ListRowTitle>{formatMessage({ id: "settings.passkeys.title" })}</ListRowTitle>
                {creatable ? null : (
                  <ListRowDescription wrap data-testid="passkeys-unsupported">
                    {formatMessage({ id: "settings.passkeys.unsupported" })}
                  </ListRowDescription>
                )}
                {passkeys.length === 0 ? (
                  <ListRowDescription wrap>{formatMessage({ id: "settings.passkeys.empty" })}</ListRowDescription>
                ) : null}
                {notice ? <Banner intent={notice.intent} density="sm" className="mt-2">{notice.message}</Banner> : null}
              </ListRowBody>
              <div className="shrink-0 @max-lg:basis-full">
                <Button
                  variant="outline"
                  size="md"
                  type="button"
                  onClick={handleAddClick}
                  loading={adding}
                  disabled={!creatable}
                >
                  {formatMessage({ id: "settings.passkeys.add" })}
                </Button>
              </div>
            </ListRow>
            {passkeys.map((passkey) => (
              <PasskeyRow
                key={passkey.id}
                passkey={passkey}
                deleteDisabled={lastFactor}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
          </ListRowGroup>
          {lastFactor ? (
            <p className="mt-3 text-footnote text-foreground-muted" data-testid="passkeys-last-factor">
              {formatMessage({ id: "settings.passkeys.lastFactor" }, {
                turnOff: (chunks: ReactNode[]) => (
                  <TextLink key="turn-off" type="button" variant="strong" onClick={requestTurnOff}>{chunks}</TextLink>
                ),
              })}
            </p>
          ) : null}
        </>
      )}

      {dialog?.kind === "reauth" ? <ReauthDialog onVerified={afterReauth} onClose={closeDialog} /> : null}
      {dialog?.kind === "noPassword" ? <NoPasswordDialog onClose={closeDialog} /> : null}
      {dialog?.kind === "verifyAdd" ? (
        <VerifyItsYouDialog
          description={formatMessage({ id: "settings.passkeys.stepUpAdd" })}
          methods={dialog.methods}
          onAnswer={answerAdd}
          onClose={closeDialog}
          testId="passkeys-verify-dialog"
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <RenameDialog passkey={dialog.passkey} initialName={dialog.passkey.name} onChanged={handleChanged} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === "delete" ? (
        <DeleteDialog passkey={dialog.passkey} onChanged={handleChanged} onClose={closeDialog} />
      ) : null}
    </div>
  );
}

function PasskeyRow({ passkey, deleteDisabled, onRename, onDelete }: {
  passkey: PasskeySummary;
  deleteDisabled: boolean;
  onRename: (passkey: PasskeySummary) => void;
  onDelete: (passkey: PasskeySummary) => void;
}) {
  const { formatMessage } = useIntl();
  const { formatCompactDate } = useTimeFormatter();
  const actionsLabel = formatMessage({ id: "settings.passkeys.actions" }, { name: passkey.name });
  const handleRename = useCallback(() => onRename(passkey), [onRename, passkey]);
  const handleDelete = useCallback(() => onDelete(passkey), [onDelete, passkey]);
  const added = formatCompactDate(passkey.createdAt);
  return (
    <ListRow
      variant="plain"
      interactive={false}
      role="group"
      aria-label={passkey.name}
      data-testid={`passkey-row-${passkey.id}`}
    >
      <IconTile><KeyRound /></IconTile>
      <ListRowBody>
        <span className="flex min-w-0 items-center gap-2">
          <ListRowTitle className="flex-initial">{passkey.name}</ListRowTitle>
          {passkey.synced ? (
            <Badge variant="default" appearance="soft">{formatMessage({ id: "settings.passkeys.synced" })}</Badge>
          ) : null}
        </span>
        <ListRowDescription>
          {passkey.lastUsedAt
            ? formatMessage({ id: "settings.passkeys.meta" }, { added, used: formatCompactDate(passkey.lastUsedAt) })
            : formatMessage({ id: "settings.passkeys.metaNeverUsed" }, { added })}
        </ListRowDescription>
      </ListRowBody>
      <DropdownMenu>
        <AppTooltip content={actionsLabel}>
          <DropdownMenuTrigger
            render={<Button type="button" size="icon-md" variant="ghost" aria-label={actionsLabel} data-testid={`passkey-actions-${passkey.id}`} />}
          >
            <EllipsisVertical aria-hidden="true" />
          </DropdownMenuTrigger>
        </AppTooltip>
        <DropdownMenuContent align="end" aria-label={actionsLabel}>
          <DropdownMenuItem onClick={handleRename}>
            <Pencil />{formatMessage({ id: "settings.passkeys.rename" })}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleDelete} disabled={deleteDisabled}>
            <Trash2 />{formatMessage({ id: "settings.passkeys.delete" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ListRow>
  );
}

// ── Adding: proof of identity first (design A6) ──

/** Two-step verification off: the password again (POST /reauth/password), then the prompt. */
function ReauthDialog({ onVerified, onClose }: { onVerified: () => Promise<void>; onClose: () => void }) {
  const { formatMessage } = useIntl();
  const describeFailure = useFailureCopy();
  const answer = useAnswer();
  const { value, setBusy, setFailure } = answer;

  const submit = useCallback(async () => {
    if (!value) return;
    setBusy(true);
    setFailure({});
    try {
      await reauthenticateWithPassword(value);
      await onVerified();
    } catch (err) {
      setFailure(describeFailure(err, "password"));
      setBusy(false);
    }
  }, [describeFailure, onVerified, setBusy, setFailure, value]);

  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);

  return (
    <StepDialog
      title={formatMessage({ id: "settings.twoStep.reauthTitle" })}
      narrow="centered"
      size="md"
      busy={answer.busy}
      onClose={onClose}
      onSubmit={handleSubmit}
      testId="passkeys-reauth-dialog"
      footer={(
        <>
          <CancelButton busy={answer.busy} onClose={onClose} />
          <CommitButton label={formatMessage({ id: "settings.twoStep.verify" })} busy={answer.busy} disabled={!value} />
        </>
      )}
    >
      <DialogDescription>{formatMessage({ id: "settings.passkeys.reauthDescription" })}</DialogDescription>
      <AnswerField
        kind="password"
        label={formatMessage({ id: "settings.twoStep.passwordLabel" })}
        value={value}
        onChange={answer.change}
        error={answer.failure.field}
      />
      {answer.failure.banner ? <Banner intent="warning" density="sm">{answer.failure.banner}</Banner> : null}
    </StepDialog>
  );
}

function NoPasswordDialog({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <StepDialog
      title={formatMessage({ id: "settings.twoStep.reauthTitle" })}
      narrow="centered"
      size="md"
      busy={false}
      onClose={onClose}
      onSubmit={onClose}
      testId="passkeys-reauth-dialog"
      footer={<DoneButton onClose={onClose} />}
    >
      <DialogDescription>{formatMessage({ id: "settings.passkeys.reauthNoPassword" })}</DialogDescription>
    </StepDialog>
  );
}

// ── Rename (design dlg-rename) ──

const NAME_MAX_LENGTH = 64;

function RenameDialog({ passkey, initialName, onChanged, onClose }: {
  passkey: PasskeySummary;
  /** The field's starting text; the dialog mounts fresh each time it opens, so it never follows later changes. */
  initialName: string;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const id = useId();
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureCopy>({});
  const trimmed = name.trim();

  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setName(event.target.value);
    setFailure({});
  }, []);

  const submit = useCallback(async () => {
    if (!trimmed) return;
    setBusy(true);
    setFailure({});
    try {
      await renamePasskey(passkey.id, trimmed);
      onChanged();
    } catch (err) {
      setBusy(false);
      const code = secondFactorFailureOf(err).code;
      if (code === "invalid_request") setFailure({ field: formatMessage({ id: "settings.passkeys.nameInvalid" }) });
      else if (code === "passkey_not_found") onChanged();
      else setFailure({ banner: formatMessage({ id: "common.confirm.somethingWentWrong" }) });
    }
  }, [formatMessage, onChanged, passkey.id, trimmed]);

  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);

  return (
    <StepDialog
      title={formatMessage({ id: "settings.passkeys.renameTitle" })}
      narrow="centered"
      size="sm"
      busy={busy}
      onClose={onClose}
      onSubmit={handleSubmit}
      testId="passkeys-rename-dialog"
      footer={(
        <>
          <CancelButton busy={busy} onClose={onClose} />
          <CommitButton label={formatMessage({ id: "settings.passkeys.renameSave" })} busy={busy} disabled={!trimmed} />
        </>
      )}
    >
      <FormField
        label={formatMessage({ id: "settings.passkeys.nameLabel" })}
        hint={formatMessage({ id: "settings.passkeys.nameHint" })}
        error={failure.field}
        htmlFor={id}
      >
        <Input id={id} type="text" autoFocus maxLength={NAME_MAX_LENGTH} value={name} onChange={handleChange} />
      </FormField>
      {failure.banner ? <Banner intent="warning" density="sm">{failure.banner}</Banner> : null}
    </StepDialog>
  );
}

// ── Delete (design dlg-delete, then dlg-stepup with two-step verification on) ──

function DeleteDialog({ passkey, onChanged, onClose }: {
  passkey: PasskeySummary;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState("");
  // Two-step verification is on: the server asked for a step-up answer.
  const [stepUpMethods, setStepUpMethods] = useState<SignInSecondFactorMethod[] | null>(null);

  const refused = useCallback((err: unknown) => {
    const failure = secondFactorFailureOf(err);
    if (failure.code === "passkey_not_found") {
      onChanged();
      return;
    }
    setBanner(failure.code === "last_factor"
      // Here the reason is plain text: the dialog is the delete step, not the place to turn it off.
      ? formatMessage({ id: "settings.passkeys.lastFactor" }, { turnOff: (chunks: string[]) => chunks.join("") })
      : formatMessage({ id: "common.confirm.somethingWentWrong" }));
  }, [formatMessage, onChanged]);

  const submit = useCallback(async () => {
    setBusy(true);
    setBanner("");
    try {
      await removePasskey(passkey.id);
      onChanged();
    } catch (err) {
      setBusy(false);
      const failure = secondFactorFailureOf(err);
      if (failure.code === "step_up_required") setStepUpMethods(failure.methods);
      else refused(err);
    }
  }, [onChanged, passkey.id, refused]);

  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);

  const answerDelete = useCallback(async (answer: StepUpAnswer) => {
    try {
      await removePasskey(passkey.id, answer);
    } catch (err) {
      const code = secondFactorFailureOf(err).code;
      if (code === "last_factor" || code === "passkey_not_found") {
        setStepUpMethods(null);
        refused(err);
        return;
      }
      throw err;
    }
    onChanged();
  }, [onChanged, passkey.id, refused]);

  if (stepUpMethods) {
    return (
      <VerifyItsYouDialog
        description={formatMessage({ id: "settings.passkeys.stepUpDelete" })}
        methods={stepUpMethods}
        onAnswer={answerDelete}
        onClose={onClose}
        testId="passkeys-verify-dialog"
      />
    );
  }

  return (
    <StepDialog
      title={formatMessage({ id: "settings.passkeys.deleteTitle" }, { name: passkey.name })}
      narrow="centered"
      size="sm"
      busy={busy}
      onClose={onClose}
      onSubmit={handleSubmit}
      testId="passkeys-delete-dialog"
      footer={(
        <>
          <CancelButton busy={busy} onClose={onClose} />
          <CommitButton label={formatMessage({ id: "settings.passkeys.deleteConfirm" })} variant="danger" busy={busy} />
        </>
      )}
    >
      <Banner intent="destructive" density="sm" live={false}>{formatMessage({ id: "settings.passkeys.deleteWarning" })}</Banner>
      {banner ? <Banner intent="warning" density="sm">{banner}</Banner> : null}
    </StepDialog>
  );
}
