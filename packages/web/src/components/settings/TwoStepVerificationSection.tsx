/**
 * Settings › Account › Two-step verification (#triage:#135, design v2 D1/D2):
 * turn on an authenticator app (TOTP), see / copy / download / regenerate the
 * backup codes, turn it off. People who never turn it on see only the offer
 * (design §0).
 *
 * The server (routes/secondFactor.ts) decides what proof each change needs:
 *   - Turning on (authenticator setup while it is off) needs a recent sign-in or
 *     the password again: POST /totp/setup answers 403 `reauth_required`, the
 *     dialog asks for the password (POST /reauth/password, its own lock:
 *     429 `reauth_locked` with `lockedUntil`), then sets up again.
 *   - One code turns it on: POST /enable { code } checks the code against the
 *     secret from /totp/setup (not yet confirmed), confirms it and turns two-step
 *     verification on in one request. /totp/confirm is only for re-binding the
 *     app while it is on, so turning on never calls it.
 *   - A passkey already registered turns it on by itself (design A9,
 *     dlg-choose-haspasskey): POST /enable { webauthn }, an assertion from
 *     POST /passkeys/assertion/options; no password again, no authenticator
 *     app. Only someone with a passkey this browser can use is asked to
 *     choose; everyone else goes straight to the authenticator app as before.
 *   - Regenerating backup codes and turning it off are inline step-up: a
 *     current code or a passkey in the same request (turning off also takes a
 *     backup code). "Use a Passkey" is offered only to someone with passkeys.
 * Wrong codes count toward the person's second-step lock (429
 * `second_factor_locked`, with `lockedUntil`). A closed passkey prompt is not
 * a failure: the dialog says so and stays.
 */
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  CodeBlockBody,
  CopyableCode,
  CopyableCodeAction,
  CopyableCodeRoot,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconTile,
  Input,
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowGroup,
  ListRowTitle,
  TextLink,
} from "@botiverse/raft-ui";
import { Copy, Download, KeyRound, ShieldCheck, Smartphone, Ticket } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { create } from "zustand";

import { useAuthStore } from "../../store/authStore";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { downloadBlob } from "../../utils/selectScreenshotArchive";
import type { SignInSecondFactorMethod } from "../auth/secondFactorSignIn";
import { canUsePasskeys, getPasskeyAssertion, isPasskeyCancel } from "../auth/webauthn";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../ui/NarrowDialog";
import type { DialogNarrow } from "../ui/NarrowDialog";
import SectionHeader from "../ui/SectionHeader";
import {
  BACKUP_CODE_SET_SIZE,
  LOW_BACKUP_CODES,
  disableSecondFactor,
  enableSecondFactor,
  fetchSecondFactorStatus,
  normalizeEnteredCode,
  reauthenticateWithPassword,
  regenerateBackupCodes,
  secondFactorFailureOf,
  startStepUpPasskeyAssertion,
  startTotpSetup,
} from "./secondFactorApi";
import type { SecondFactorStatus, StepUpAnswer } from "./secondFactorApi";
import { useAnswer, useFailureCopy } from "./secondFactorAnswer";
import type { AnswerKind } from "./secondFactorAnswer";

/**
 * What the Account page's Passkeys and Two-step verification sections share.
 * `revision`: either one changing reloads both (the passkey count here, the
 * last-passkey rule there). `turnOffRequested`: the Passkeys section's
 * last-passkey reason opens Turn Off here (design set-menu-last).
 */
export const useSecondFactorSettings = create<{ revision: number; turnOffRequested: boolean }>(() => ({
  revision: 0,
  turnOffRequested: false,
}));

export function secondFactorSettingsChanged(): void {
  useSecondFactorSettings.setState((state) => ({ revision: state.revision + 1 }));
}

export function requestTurnOff(): void {
  useSecondFactorSettings.setState({ turnOffRequested: true });
}

// The dialog parts below are shared with the Passkeys section (PasskeysSection.tsx).

/** The section (its `auth_second_factor_v1` gate is retired, #raft-architecture:#32). */
export default function TwoStepVerificationSection({ passwordConfigured }: { passwordConfigured: boolean | null }) {
  return <TwoStepVerificationCard passwordConfigured={passwordConfigured} />;
}

type TurnOnStart =
  /** design dlg-choose-haspasskey: the authenticator app, or a passkey already there. */
  | { kind: "choose"; passkeys: number; appConfirmed: boolean }
  | { kind: "password" }
  | { kind: "noPassword" }
  | { kind: "scan"; secret: string; otpauthUri: string }
  | { kind: "enable" };

type OpenDialog =
  | { kind: "turnOn"; start: TurnOnStart }
  | { kind: "regenerate"; status: SecondFactorStatus }
  | { kind: "turnOff"; status: SecondFactorStatus };

/** Someone with a passkey this browser can use (never Raft Desktop) is offered it. */
function usablePasskeys(status: SecondFactorStatus | null | undefined): number {
  const passkeys = status?.methods.passkeys ?? 0;
  return passkeys > 0 && canUsePasskeys() ? passkeys : 0;
}

function TwoStepVerificationCard({ passwordConfigured }: { passwordConfigured: boolean | null }) {
  const { formatMessage } = useIntl();
  const describeFailure = useFailureCopy();
  // undefined: loading; null: the server says the feature is not there (404).
  // One state for the read, so an answer sets it once (loadFailed keeps the section on screen).
  const [load, setLoad] = useState<{ status: SecondFactorStatus | null | undefined; loadFailed: boolean }>({ status: undefined, loadFailed: false });
  const { status, loadFailed } = load;
  const revision = useSecondFactorSettings((state) => state.revision);
  const turnOffRequested = useSecondFactorSettings((state) => state.turnOffRequested);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fetchSecondFactorStatus().then((next) => {
      if (cancelled) return;
      setLoad({ status: next, loadFailed: false });
    }, (err: unknown) => {
      if (cancelled) return;
      // The flag reads on here but the server evaluates it for the person
      // alone: its 404 is the final word, and the section stays away.
      const off = secondFactorFailureOf(err).status === 404;
      setLoad((current) => (off ? { ...current, status: null } : { ...current, loadFailed: true }));
    });
    return () => {
      cancelled = true;
    };
  }, [revision]);

  const closeDialog = useCallback(() => {
    setDialog(null);
    useSecondFactorSettings.setState({ turnOffRequested: false });
  }, []);

  const handleTurnOn = useCallback(async () => {
    if (starting) return;
    setStartError("");
    // A passkey already there can turn it on (design A9): first the choice.
    const passkeys = usablePasskeys(status);
    if (passkeys > 0) {
      setDialog({ kind: "turnOn", start: { kind: "choose", passkeys, appConfirmed: status?.methods.totp === true } });
      return;
    }
    // An app already confirmed while two-step verification is off only needs a
    // code on /enable. An unconfirmed secret from an earlier setup is not in the
    // status, so Turn On sets up again and shows the new QR code and key.
    if (status?.methods.totp) {
      setDialog({ kind: "turnOn", start: { kind: "enable" } });
      return;
    }
    setStarting(true);
    try {
      const setup = await startTotpSetup();
      setDialog({ kind: "turnOn", start: { kind: "scan", ...setup } });
    } catch (err) {
      const failure = secondFactorFailureOf(err);
      if (failure.code === "reauth_required") {
        setDialog({ kind: "turnOn", start: { kind: passwordConfigured === false ? "noPassword" : "password" } });
      } else if (failure.code === "step_up_required" || failure.code === "second_factor_already_enabled") {
        // Turned on from another sign-in meanwhile.
        secondFactorSettingsChanged();
      } else {
        setStartError(describeFailure(err, "totp").banner ?? formatMessage({ id: "common.confirm.somethingWentWrong" }));
      }
    } finally {
      setStarting(false);
    }
  }, [describeFailure, formatMessage, passwordConfigured, starting, status]);

  const handleTurnOnClick = useCallback(() => {
    void handleTurnOn();
  }, [handleTurnOn]);
  const handleTurnOffClick = useCallback(() => {
    if (status) setDialog({ kind: "turnOff", status });
  }, [status]);
  const handleRegenerateClick = useCallback(() => {
    if (status) setDialog({ kind: "regenerate", status });
  }, [status]);

  if (status === null) return null;
  // Still loading: nothing yet. A reload that fails keeps what was shown;
  // only a first load that fails says so.
  if (status === undefined && !loadFailed) return null;

  const on = status?.enabled === true;
  const remaining = status?.methods.backupCodesRemaining ?? 0;
  // Turn Off from its button, or from "turn off two-step verification" under the Passkeys section's last passkey.
  const turnOffStatus = dialog?.kind === "turnOff" ? dialog.status : turnOffRequested && on ? status : null;

  return (
    // id: /settings/account#two-step opens Account at this section (useScrollToSettingsSection).
    <div id="two-step" className="mb-6 scroll-mt-4" data-testid="two-step-verification-section">
      <SectionHeader
        className="mb-3"
        icon={<ShieldCheck size={16} />}
        label={formatMessage({ id: "settings.twoStep.sectionLabel" })}
      />
      {/* Settings rows (DS Forms › A setting's row; cindyz, #proj-raft-ui:#220): the
          setting with its state badge after the title and Turn On / Turn Off at its end
          (under the text where the row is under 32rem wide), then a row per method. */}
      {!status ? (
        <Banner intent="warning" density="sm">{formatMessage({ id: "settings.twoStep.loadFailed" })}</Banner>
      ) : (
        <ListRowGroup className="@container" data-testid="two-step-verification-rows">
          <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap">
            <ListRowBody>
              <span className="flex min-w-0 items-center gap-2">
                <ListRowTitle className="flex-initial">{formatMessage({ id: "settings.twoStep.title" })}</ListRowTitle>
                <Badge variant={on ? "success" : "default"} appearance="soft" data-testid="two-step-verification-state">
                  {formatMessage({ id: on ? "settings.twoStep.stateOn" : "settings.twoStep.stateOff" })}
                </Badge>
              </span>
              <ListRowDescription wrap>
                {formatMessage({ id: on ? "settings.twoStep.onDescription" : "settings.twoStep.offDescription" })}
              </ListRowDescription>
              {startError ? <Banner intent="warning" density="sm" className="mt-2">{startError}</Banner> : null}
            </ListRowBody>
            <div className="shrink-0 @max-lg:basis-full">
              {on ? (
                <Button variant="warning" size="md" type="button" onClick={handleTurnOffClick}>
                  {formatMessage({ id: "settings.twoStep.turnOff" })}
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="md"
                  type="button"
                  onClick={handleTurnOnClick}
                  loading={starting}
                >
                  {formatMessage({ id: "settings.twoStep.turnOn" })}
                </Button>
              )}
            </div>
          </ListRow>
          {on ? (
            <>
              {status.methods.totp ? (
                <MethodListRow
                  icon={<Smartphone />}
                  title={formatMessage({ id: "settings.twoStep.authenticatorTitle" })}
                />
              ) : null}
              {status.methods.passkeys > 0 ? (
                <MethodListRow
                  icon={<KeyRound />}
                  title={formatMessage({ id: "settings.twoStep.passkeysTitle" })}
                  description={formatMessage(
                    { id: "settings.twoStep.passkeysDescription" },
                    { count: status.methods.passkeys },
                  )}
                  testId="two-step-passkeys-row"
                />
              ) : null}
              <MethodListRow
                icon={<Ticket />}
                title={formatMessage({ id: "settings.twoStep.backupCodesTitle" })}
                description={formatMessage(
                  { id: "settings.twoStep.backupCodesRemaining" },
                  { remaining, total: BACKUP_CODE_SET_SIZE },
                )}
                notice={remaining <= LOW_BACKUP_CODES ? (
                  <Banner intent="warning" density="sm" live={false}>
                    {formatMessage({ id: "settings.twoStep.lowCodes" }, { count: remaining })}
                  </Banner>
                ) : null}
                action={(
                  <Button variant="outline" size="md" type="button" onClick={handleRegenerateClick} className="shrink-0">
                    {formatMessage({ id: "settings.twoStep.regenerate" })}
                  </Button>
                )}
              />
            </>
          ) : null}
        </ListRowGroup>
      )}

      {dialog?.kind === "turnOn" ? (
        <TurnOnDialog
          initialStep={dialog.start}
          passwordConfigured={passwordConfigured}
          onChanged={secondFactorSettingsChanged}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "regenerate" ? (
        <RegenerateDialog status={dialog.status} onChanged={secondFactorSettingsChanged} onClose={closeDialog} />
      ) : null}
      {turnOffStatus ? (
        <TurnOffDialog status={turnOffStatus} onChanged={secondFactorSettingsChanged} onClose={closeDialog} />
      ) : null}
    </div>
  );
}

/** A method of the Two-step verification card: a row of its ListRowGroup; `notice` (low backup codes) sits under its text.
 * `description` is its data (how many passkeys, codes left); a method with nothing to count has none (HelperText step 1). */
function MethodListRow({ icon, title, description, action, notice, testId }: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  notice?: ReactNode;
  testId?: string;
}) {
  return (
    <ListRow variant="plain" interactive={false} role="group" aria-label={title} data-testid={testId}>
      <IconTile>{icon}</IconTile>
      <ListRowBody>
        <ListRowTitle>{title}</ListRowTitle>
        {description ? <ListRowDescription>{description}</ListRowDescription> : null}
        {notice ? <div className="mt-2">{notice}</div> : null}
      </ListRowBody>
      {action}
    </ListRow>
  );
}

/** A method to choose in the Turn On dialog: a card of its own, its title and its Choose; `meta` is its data (how many
 * passkeys), never a describing line (HelperText step 1). */
function MethodRow({ icon, title, meta, action }: {
  icon: ReactNode;
  title: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <Card
      role="group"
      aria-label={title}
      className="min-h-11 flex-row items-center gap-3 px-4 py-3 text-left"
    >
      <IconTile>{icon}</IconTile>
      <div className="min-w-0 flex-1">
        <div className="truncate text-subhead font-semibold text-foreground">{title}</div>
        {meta ? <div className="text-footnote text-foreground-muted" data-testid="two-step-method-meta">{meta}</div> : null}
      </div>
      {action}
    </Card>
  );
}

// ── Dialog shell ──

/**
 * One raft-ui Dialog for each step: title and ×, a body, then Cancel and the
 * step's one commit (DialogCommit: in the head of a phone sheet). Closing is
 * refused while a request is in flight. Outside presses don't dismiss it.
 */
export function StepDialog({
  title,
  narrow,
  size,
  busy,
  onClose,
  onSubmit,
  testId,
  children,
  footer,
}: {
  title: string;
  narrow: DialogNarrow;
  size: "sm" | "md";
  busy: boolean;
  onClose: () => void;
  onSubmit: () => void;
  testId: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const closeLabel = formatMessage({ id: "common.close" });
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next && !busy) onClose();
  }, [busy, onClose]);
  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy) onSubmit();
  }, [busy, onSubmit]);

  return (
    <Dialog open disablePointerDismissal onOpenChange={handleOpenChange}>
      <NarrowDialogContent
        narrow={narrow}
        size={size}
        data-testid={testId}
        aria-busy={busy}
        title={title}
        closeLabel={closeLabel}
        closeDisabled={busy}
        render={<form onSubmit={handleSubmit} noValidate />}
        header={(
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogClose disabled={busy} aria-label={closeLabel} />
          </DialogHeader>
        )}
      >
        <DialogBody className="grid gap-4">{children}</DialogBody>
        <DialogActions as={DialogFooter}>{footer}</DialogActions>
      </NarrowDialogContent>
    </Dialog>
  );
}

export function CancelButton({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <Button type="button" variant="ghost" size="lg" onClick={onClose} disabled={busy}>
      {formatMessage({ id: "common.confirm.cancel" })}
    </Button>
  );
}

export function CommitButton({ label, busy, disabled, variant = "accent", testId }: {
  label: string;
  busy: boolean;
  disabled?: boolean;
  variant?: "accent" | "warning" | "danger";
  testId?: string;
}) {
  return (
    <DialogCommit>
      {(inHead) => (
        <Button
          type="submit"
          variant={variant}
          size={inHead ? "md" : "lg"}
          loading={busy}
          disabled={disabled}
          data-testid={testId}
        >
          {label}
        </Button>
      )}
    </DialogCommit>
  );
}

/** A code or password field; its error sits under it (Forms: validation). */
export function AnswerField({ label, value, onChange, error, hint, kind }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  kind: AnswerKind;
}) {
  const id = useId();
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value), [onChange]);
  return (
    <FormField label={label} htmlFor={id} error={error} hint={hint}>
      {kind === "password" ? (
        <Input
          id={id}
          type="password"
          name="current-password"
          autoComplete="current-password"
          autoFocus
          value={value}
          onChange={handleChange}
        />
      ) : (
        <Input
          id={id}
          type="text"
          inputMode={kind === "totp" ? "numeric" : "text"}
          autoComplete={kind === "totp" ? "one-time-code" : "off"}
          autoCapitalize="off"
          spellCheck={false}
          autoFocus
          value={value}
          onChange={handleChange}
        />
      )}
    </FormField>
  );
}

// ── Confirming with a code, a backup code or a passkey ──

const SWITCH_LABEL_IDS = {
  passkey: "settings.twoStep.usePasskey",
  totp: "settings.twoStep.useAuthenticatorCode",
  backup_code: "settings.twoStep.useBackupCode",
} as const;

/** "Use a Passkey" / "Use Authenticator Code" / "Use a Backup Code": switch to another way to confirm. */
export function MethodLink({ method, onSwitch, disabled }: {
  method: SignInSecondFactorMethod;
  onSwitch: (method: SignInSecondFactorMethod) => void;
  disabled: boolean;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onSwitch(method), [method, onSwitch]);
  return (
    <TextLink type="button" onClick={handleClick} disabled={disabled}>
      {formatMessage({ id: SWITCH_LABEL_IDS[method] })}
    </TextLink>
  );
}

/** The step-up answer for `method`: what was typed, or the browser's passkey prompt (rejects when closed: isPasskeyCancel). */
export async function stepUpAnswerFor(method: SignInSecondFactorMethod, entered: string): Promise<StepUpAnswer> {
  if (method === "passkey") return { webauthn: await getPasskeyAssertion(await startStepUpPasskeyAssertion()) };
  return method === "totp" ? { code: entered } : { backupCode: entered };
}

/**
 * The ways Regenerate and Turn Off can confirm with, from the status: an
 * authenticator code first (as before passkeys), then a passkey where this
 * browser can use one, then a backup code where the change takes one.
 * Without passkeys nothing changes.
 */
function confirmMethodsOf(status: SecondFactorStatus, allowBackupCode: boolean): SignInSecondFactorMethod[] {
  return [
    ...(status.methods.totp ? ["totp" as const] : []),
    ...(usablePasskeys(status) > 0 ? ["passkey" as const] : []),
    ...(allowBackupCode ? ["backup_code" as const] : []),
  ];
}

/** One confirm method at a time, the others as links under it; what was typed resets on a switch. */
function useConfirmMethod(methods: readonly SignInSecondFactorMethod[]) {
  const answer = useAnswer();
  const { reset } = answer;
  const [method, setMethod] = useState<SignInSecondFactorMethod | null>(methods[0] ?? null);
  // A closed passkey prompt: said in an info banner, not as a failure.
  const [notice, setNotice] = useState("");
  const switchTo = useCallback((next: SignInSecondFactorMethod) => {
    reset();
    setNotice("");
    setMethod(next);
  }, [reset]);
  const ready = method !== null && (method === "passkey" || normalizeEnteredCode(answer.value) !== "");
  return { answer, method, switchTo, notice, setNotice, ready, others: methods.filter((other) => other !== method) };
}

function ConfirmMethodField({ method, value, onChange, error }: {
  method: SignInSecondFactorMethod | null;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const { formatMessage } = useIntl();
  if (method === null) {
    return <Banner intent="warning" density="sm">{formatMessage({ id: "auth.secondFactor.passkeyUnsupported" })}</Banner>;
  }
  // Kept (HelperText step 1, CUT* kept for Kirby): here the commit button is the action (Turn off, Regenerate), so
  // this line is the only sign that a passkey will be asked for.
  if (method === "passkey") {
    return <p className="text-footnote text-foreground-muted">{formatMessage({ id: "auth.secondFactor.passkeyHint" })}</p>;
  }
  return (
    <AnswerField
      kind={method}
      label={formatMessage({
        id: method === "backup_code" ? "settings.twoStep.backupCodeLabel" : "settings.twoStep.authenticatorCodeLabel",
      })}
      value={value}
      onChange={onChange}
      error={error}
    />
  );
}

function MethodLinks({ methods, onSwitch, disabled }: {
  methods: readonly SignInSecondFactorMethod[];
  onSwitch: (method: SignInSecondFactorMethod) => void;
  disabled: boolean;
}) {
  if (methods.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {methods.map((method) => <MethodLink key={method} method={method} onSwitch={onSwitch} disabled={disabled} />)}
    </div>
  );
}

// ── Backup codes, shown once ──

function BackupCodesPanel({ codes }: { codes: string[] }) {
  const { formatMessage } = useIntl();
  const email = useAuthStore((s) => s.user?.email ?? "");
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const handleCopy = useCallback(() => {
    setCopyFailed(false);
    void copyTextToClipboard(codes.join("\n"), formatMessage).then(() => {
      setCopied(true);
    }, () => {
      setCopied(false);
      setCopyFailed(true);
    });
  }, [codes, formatMessage]);

  const handleDownload = useCallback(() => {
    const heading = formatMessage({ id: "settings.twoStep.codesFileHeading" }, { email });
    const text = `${heading}\n\n${codes.join("\n")}\n`;
    downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), "raft-backup-codes.txt");
  }, [codes, email, formatMessage]);

  return (
    <>
      <p className="text-subhead text-foreground-muted">{formatMessage({ id: "settings.twoStep.codesDescription" })}</p>
      <CodeBlock data-testid="two-step-backup-codes">
        <CodeBlockBody>
          <pre className="grid grid-cols-2 gap-x-6 gap-y-1">
            {codes.map((code) => <span key={code}>{code}</span>)}
          </pre>
        </CodeBlockBody>
      </CodeBlock>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="md" onClick={handleCopy}>
          <Copy size={14} aria-hidden="true" />
          {formatMessage({ id: copied ? "settings.twoStep.codesCopied" : "settings.twoStep.copyCodes" })}
        </Button>
        <Button type="button" variant="outline" size="md" onClick={handleDownload}>
          <Download size={14} aria-hidden="true" />
          {formatMessage({ id: "settings.twoStep.downloadCodes" })}
        </Button>
      </div>
      {copyFailed ? (
        <Banner intent="warning" density="sm">{formatMessage({ id: "settings.twoStep.copyFailed" })}</Banner>
      ) : null}
    </>
  );
}

export function DoneButton({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <DialogCommit>
      {(inHead) => (
        <Button type="button" variant="accent" size={inHead ? "md" : "lg"} onClick={onClose}>
          {formatMessage({ id: "settings.twoStep.done" })}
        </Button>
      )}
    </DialogCommit>
  );
}

// ── Turn on ──

type TurnOnStep = TurnOnStart | { kind: "codes"; codes: string[] };

/** The choice has no submit: each option is its own button. */
function ignoreSubmit() {}

function TotpQrCode({ uri }: { uri: string }) {
  const [code, setCode] = useState<{ size: number; path: string } | null>(null);
  // Same encoder and drawing as MobileDownloadQr: the module matrix into one
  // <path>, the encoder loaded only when a QR is shown.
  useEffect(() => {
    let cancelled = false;
    void import("uqr").then(({ encode }) => {
      const result = encode(uri, { border: 1 });
      const path = result.data
        .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x},${y}h1v1h-1z` : "")))
        .join("");
      if (!cancelled) setCode({ size: result.size, path });
    }, () => {
      // The key under the QR is the way in without it.
    });
    return () => {
      cancelled = true;
    };
  }, [uri]);

  const frame = "mx-auto size-40 rounded-sticker border border-line-hairline bg-sticker-paper p-1 text-sticker-ink";
  if (!code) return <div className={frame} aria-hidden="true" />;
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${code.size} ${code.size}`}
      className={frame}
      shapeRendering="crispEdges"
      data-testid="two-step-totp-qr"
    >
      <path d={code.path} fill="currentColor" />
    </svg>
  );
}

function TurnOnDialog({ initialStep, passwordConfigured, onChanged, onClose }: {
  /** Where the dialog opens; it moves on by itself from there. */
  initialStep: TurnOnStart;
  passwordConfigured: boolean | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const describeFailure = useFailureCopy();
  const [step, setStep] = useState<TurnOnStep>(initialStep);
  const answer = useAnswer();
  const { value, reset, setFailure, setBusy } = answer;
  // The choice (design dlg-choose-haspasskey): which one is in flight, and a closed passkey prompt.
  const [choosing, setChoosing] = useState<"app" | "passkey" | null>(null);
  const [notice, setNotice] = useState("");
  const setupTitle = formatMessage({ id: "settings.twoStep.setupTitle" });

  const submit = useCallback(async () => {
    const entered = step.kind === "password" ? value : normalizeEnteredCode(value);
    if (!entered) return;
    setBusy(true);
    setFailure({});
    try {
      if (step.kind === "password") {
        await reauthenticateWithPassword(entered);
        const setup = await startTotpSetup();
        reset();
        setStep({ kind: "scan", ...setup });
      } else if (step.kind === "scan" || step.kind === "enable") {
        // One code on /enable confirms the app and turns it on.
        const codes = await enableSecondFactor({ code: entered });
        reset();
        setStep({ kind: "codes", codes });
        onChanged();
      }
    } catch (err) {
      const failure = secondFactorFailureOf(err);
      if (failure.code === "second_factor_already_enabled") {
        onChanged();
        onClose();
        return;
      }
      setFailure(describeFailure(err, step.kind === "password" ? "password" : "totp"));
    } finally {
      setBusy(false);
    }
  }, [describeFailure, onChanged, onClose, reset, setBusy, setFailure, step.kind, value]);

  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);

  /** The authenticator app: as Turn On goes without passkeys (a code for an app already there, else setup). */
  const chooseApp = useCallback(async () => {
    if (step.kind !== "choose") return;
    setFailure({});
    setNotice("");
    if (step.appConfirmed) {
      setStep({ kind: "enable" });
      return;
    }
    setChoosing("app");
    setBusy(true);
    try {
      const setup = await startTotpSetup();
      setStep({ kind: "scan", ...setup });
    } catch (err) {
      const failure = secondFactorFailureOf(err);
      if (failure.code === "reauth_required") {
        setStep({ kind: passwordConfigured === false ? "noPassword" : "password" });
      } else if (failure.code === "step_up_required" || failure.code === "second_factor_already_enabled") {
        // Turned on from another sign-in meanwhile.
        onChanged();
        onClose();
      } else {
        setFailure(describeFailure(err, "totp"));
      }
    } finally {
      setChoosing(null);
      setBusy(false);
    }
  }, [describeFailure, onChanged, onClose, passwordConfigured, setBusy, setFailure, step]);

  /** A passkey already there (design A9): the browser's prompt, then /enable { webauthn }, then the backup codes. */
  const choosePasskey = useCallback(async () => {
    setFailure({});
    setNotice("");
    setChoosing("passkey");
    setBusy(true);
    try {
      const webauthn = await getPasskeyAssertion(await startStepUpPasskeyAssertion());
      const codes = await enableSecondFactor({ webauthn });
      setStep({ kind: "codes", codes });
      onChanged();
    } catch (err) {
      if (isPasskeyCancel(err)) {
        setNotice(formatMessage({ id: "auth.secondFactor.passkeyCancelled" }));
      } else if (secondFactorFailureOf(err).code === "second_factor_already_enabled") {
        onChanged();
        onClose();
      } else {
        setFailure(describeFailure(err, "passkey"));
      }
    } finally {
      setChoosing(null);
      setBusy(false);
    }
  }, [describeFailure, formatMessage, onChanged, onClose, setBusy, setFailure]);

  const handleChooseApp = useCallback(() => {
    void chooseApp();
  }, [chooseApp]);
  const handleChoosePasskey = useCallback(() => {
    void choosePasskey();
  }, [choosePasskey]);

  if (step.kind === "codes") {
    return (
      <StepDialog
        title={setupTitle}
        narrow="sheet"
        size="md"
        busy={false}
        onClose={onClose}
        onSubmit={onClose}
        testId="two-step-turn-on-dialog"
        footer={<DoneButton onClose={onClose} />}
      >
        <Banner intent="success" density="sm">{formatMessage({ id: "settings.twoStep.enabledNotice" })}</Banner>
        <BackupCodesPanel codes={step.codes} />
      </StepDialog>
    );
  }

  if (step.kind === "noPassword") {
    return (
      <StepDialog
        title={formatMessage({ id: "settings.twoStep.reauthTitle" })}
        narrow="centered"
        size="md"
        busy={false}
        onClose={onClose}
        onSubmit={onClose}
        testId="two-step-turn-on-dialog"
        footer={<DoneButton onClose={onClose} />}
      >
        <DialogDescription>{formatMessage({ id: "settings.twoStep.reauthNoPassword" })}</DialogDescription>
      </StepDialog>
    );
  }

  const banner = answer.failure.banner ? (
    <Banner intent="warning" density="sm">{answer.failure.banner}</Banner>
  ) : null;
  const footer = (commit: ReactNode) => (
    <>
      <CancelButton busy={answer.busy} onClose={onClose} />
      {commit}
    </>
  );
  const signsOut = (
    <Banner intent="info" density="sm" live={false}>{formatMessage({ id: "settings.twoStep.signsOutNotice" })}</Banner>
  );

  if (step.kind === "choose") {
    const chooseLabel = formatMessage({ id: "settings.twoStep.choose" });
    return (
      <StepDialog
        title={setupTitle}
        narrow="sheet"
        size="md"
        busy={answer.busy}
        onClose={onClose}
        onSubmit={ignoreSubmit}
        testId="two-step-turn-on-dialog"
        footer={<CancelButton busy={answer.busy} onClose={onClose} />}
      >
        <div className="grid gap-2">
          <MethodRow
            icon={<Smartphone />}
            title={formatMessage({ id: "settings.twoStep.authenticatorTitle" })}
            action={(
              <Button
                type="button"
                variant="outline"
                size="md"
                onClick={handleChooseApp}
                loading={choosing === "app"}
                disabled={answer.busy}
                className="shrink-0"
              >
                {chooseLabel}
              </Button>
            )}
          />
          <MethodRow
            icon={<KeyRound />}
            title={formatMessage({ id: "settings.twoStep.choosePasskeyTitle" })}
            meta={formatMessage({ id: "settings.twoStep.passkeyCount" }, { count: step.passkeys })}
            action={(
              <Button
                type="button"
                variant="outline"
                size="md"
                onClick={handleChoosePasskey}
                loading={choosing === "passkey"}
                disabled={answer.busy}
                className="shrink-0"
              >
                {chooseLabel}
              </Button>
            )}
          />
        </div>
        {notice ? <Banner intent="info" density="sm">{notice}</Banner> : null}
        {banner}
        {signsOut}
      </StepDialog>
    );
  }

  if (step.kind === "password") {
    return (
      <StepDialog
        title={formatMessage({ id: "settings.twoStep.reauthTitle" })}
        narrow="centered"
        size="md"
        busy={answer.busy}
        onClose={onClose}
        onSubmit={handleSubmit}
        testId="two-step-turn-on-dialog"
        footer={footer(
          <CommitButton
            label={formatMessage({ id: "settings.twoStep.verify" })}
            busy={answer.busy}
            disabled={!value}
          />,
        )}
      >
        <DialogDescription>{formatMessage({ id: "settings.twoStep.reauthDescription" })}</DialogDescription>
        <AnswerField
          kind="password"
          label={formatMessage({ id: "settings.twoStep.passwordLabel" })}
          value={value}
          onChange={answer.change}
          error={answer.failure.field}
        />
        {banner}
      </StepDialog>
    );
  }

  if (step.kind === "scan") {
    return (
      <StepDialog
        title={formatMessage({ id: "settings.twoStep.scanTitle" })}
        narrow="sheet"
        size="md"
        busy={answer.busy}
        onClose={onClose}
        onSubmit={handleSubmit}
        testId="two-step-turn-on-dialog"
        footer={footer(
          <CommitButton
            label={formatMessage({ id: "settings.twoStep.turnOn" })}
            busy={answer.busy}
            disabled={!normalizeEnteredCode(value)}
            testId="two-step-enable-submit"
          />,
        )}
      >
        {/* The QR code, its key and a field named for the app: no instruction line (HelperText step 1). */}
        <TotpQrCode uri={step.otpauthUri} />
        <div className="grid gap-1.5">
          <p className="text-footnote text-foreground-muted">{formatMessage({ id: "settings.twoStep.manualKey" })}</p>
          <CopyableCodeRoot size="sm">
            <CopyableCode truncate data-testid="two-step-totp-secret">{step.secret}</CopyableCode>
            <CopyableCodeAction aria-label={formatMessage({ id: "settings.twoStep.copyKeyAria" })} />
          </CopyableCodeRoot>
        </div>
        <AnswerField
          kind="totp"
          label={formatMessage({ id: "settings.twoStep.authenticatorCodeLabel" })}
          value={value}
          onChange={answer.change}
          error={answer.failure.field}
        />
        {banner}
        {signsOut}
      </StepDialog>
    );
  }

  return (
    <StepDialog
      title={setupTitle}
      narrow="centered"
      size="md"
      busy={answer.busy}
      onClose={onClose}
      onSubmit={handleSubmit}
      testId="two-step-turn-on-dialog"
      footer={footer(
        <CommitButton
          label={formatMessage({ id: "settings.twoStep.turnOn" })}
          busy={answer.busy}
          disabled={!normalizeEnteredCode(value)}
          testId="two-step-enable-submit"
        />,
      )}
    >
      {/* The field names where the code comes from; no instruction line (HelperText step 1). */}
      <AnswerField
        kind="totp"
        label={formatMessage({ id: "settings.twoStep.authenticatorCodeLabel" })}
        value={value}
        onChange={answer.change}
        error={answer.failure.field}
      />
      {banner}
      {signsOut}
    </StepDialog>
  );
}

// ── Regenerate backup codes ──

function RegenerateDialog({ status, onChanged, onClose }: {
  status: SecondFactorStatus;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const describeFailure = useFailureCopy();
  // An authenticator code or a passkey: the server refuses a backup code here.
  const methods = useMemo(() => confirmMethodsOf(status, false), [status]);
  const { answer, method, switchTo, notice, setNotice, ready, others } = useConfirmMethod(methods);
  const { value, setBusy, setFailure } = answer;
  const [codes, setCodes] = useState<string[] | null>(null);

  const submit = useCallback(async () => {
    if (!method || !ready) return;
    setBusy(true);
    setFailure({});
    setNotice("");
    try {
      const given = await stepUpAnswerFor(method, normalizeEnteredCode(value));
      if ("backupCode" in given) return;
      setCodes(await regenerateBackupCodes(given));
      onChanged();
    } catch (err) {
      if (isPasskeyCancel(err)) setNotice(formatMessage({ id: "auth.secondFactor.passkeyCancelled" }));
      else setFailure(describeFailure(err, method));
    } finally {
      setBusy(false);
    }
  }, [describeFailure, formatMessage, method, onChanged, ready, setBusy, setFailure, setNotice, value]);

  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);

  if (codes) {
    return (
      <StepDialog
        title={formatMessage({ id: "settings.twoStep.newCodesTitle" })}
        narrow="sheet"
        size="md"
        busy={false}
        onClose={onClose}
        onSubmit={onClose}
        testId="two-step-regenerate-dialog"
        footer={<DoneButton onClose={onClose} />}
      >
        <BackupCodesPanel codes={codes} />
      </StepDialog>
    );
  }

  return (
    <StepDialog
      title={formatMessage({ id: "settings.twoStep.regenerateTitle" })}
      narrow="centered"
      size="sm"
      busy={answer.busy}
      onClose={onClose}
      onSubmit={handleSubmit}
      testId="two-step-regenerate-dialog"
      footer={(
        <>
          <CancelButton busy={answer.busy} onClose={onClose} />
          {method ? (
            <CommitButton
              label={formatMessage({ id: "settings.twoStep.regenerate" })}
              variant="warning"
              busy={answer.busy}
              disabled={!ready}
            />
          ) : null}
        </>
      )}
    >
      <DialogDescription>{formatMessage({ id: "settings.twoStep.regenerateDescription" })}</DialogDescription>
      <ConfirmMethodField
        key={method ?? "none"}
        method={method}
        value={value}
        onChange={answer.change}
        error={answer.failure.field}
      />
      <MethodLinks methods={others} onSwitch={switchTo} disabled={answer.busy} />
      {notice ? <Banner intent="info" density="sm">{notice}</Banner> : null}
      {answer.failure.banner ? <Banner intent="warning" density="sm">{answer.failure.banner}</Banner> : null}
    </StepDialog>
  );
}

// ── Turn off ──

function TurnOffDialog({ status, onChanged, onClose }: {
  status: SecondFactorStatus;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const describeFailure = useFailureCopy();
  const methods = useMemo(() => confirmMethodsOf(status, true), [status]);
  const { answer, method, switchTo, notice, setNotice, ready, others } = useConfirmMethod(methods);
  const { value, setBusy, setFailure } = answer;

  const submit = useCallback(async () => {
    if (!method || !ready) return;
    setBusy(true);
    setFailure({});
    setNotice("");
    try {
      await disableSecondFactor(await stepUpAnswerFor(method, normalizeEnteredCode(value)));
      onChanged();
      onClose();
    } catch (err) {
      if (isPasskeyCancel(err)) {
        setNotice(formatMessage({ id: "auth.secondFactor.passkeyCancelled" }));
        return;
      }
      if (secondFactorFailureOf(err).code === "second_factor_not_enabled") {
        onChanged();
        onClose();
        return;
      }
      setFailure(describeFailure(err, method));
    } finally {
      setBusy(false);
    }
  }, [describeFailure, formatMessage, method, onChanged, onClose, ready, setBusy, setFailure, setNotice, value]);

  const handleSubmit = useCallback(() => {
    void submit();
  }, [submit]);

  return (
    <StepDialog
      title={formatMessage({ id: "settings.twoStep.turnOffTitle" })}
      narrow="centered"
      size="sm"
      busy={answer.busy}
      onClose={onClose}
      onSubmit={handleSubmit}
      testId="two-step-turn-off-dialog"
      footer={(
        <>
          <CancelButton busy={answer.busy} onClose={onClose} />
          {method ? (
            <CommitButton
              label={formatMessage({ id: "settings.twoStep.turnOff" })}
              variant="warning"
              busy={answer.busy}
              disabled={!ready}
            />
          ) : null}
        </>
      )}
    >
      <DialogDescription>
        {formatMessage({
          id: status.methods.passkeys > 0 ? "settings.twoStep.turnOffDescriptionPasskeys" : "settings.twoStep.turnOffDescription",
        })}
      </DialogDescription>
      <ConfirmMethodField
        key={method ?? "none"}
        method={method}
        value={value}
        onChange={answer.change}
        error={answer.failure.field}
      />
      <MethodLinks methods={others} onSwitch={switchTo} disabled={answer.busy} />
      {notice ? <Banner intent="info" density="sm">{notice}</Banner> : null}
      {answer.failure.banner ? <Banner intent="warning" density="sm">{answer.failure.banner}</Banner> : null}
    </StepDialog>
  );
}
