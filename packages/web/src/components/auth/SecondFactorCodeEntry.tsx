/**
 * Answering the second step on an auth page (#triage:#135, design v2): the
 * authenticator-code / backup-code field, the passkey prompt (design
 * step-passkey), the switch between them, and what a refused answer says.
 * Shared by the sign-in's second step
 * (SecondFactorSignInStep) and the step-up a device or app approval asks for
 * first (StepUpBeforeApproval, design device-stepup / applogin-stepup).
 *
 * The settings dialogs (settings/TwoStepVerificationSection.tsx) keep their
 * own field: they sit in a dialog and their copy talks about changing
 * settings; the API helpers and the failure parsing are shared
 * (settings/secondFactorApi.ts).
 */
import { Button, Input, Separator, TextLink, TextSans } from "@botiverse/raft-ui";
import { KeyRound, Smartphone, Ticket } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";

import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import {
  normalizeEnteredCode,
  secondFactorFailureOf,
  startStepUpPasskeyAssertion,
  stepUpThisSignIn,
} from "../settings/secondFactorApi";
import type { StepUpAnswer } from "../settings/secondFactorApi";
import Banner from "../ui/Banner";
import FormField from "../ui/FormField";
import { initialMethod, rememberSecondFactorMethod, usableMethodsOf } from "./secondFactorSignIn";
import type { CodeMethod, SignInSecondFactorMethod } from "./secondFactorSignIn";
import { getPasskeyAssertion, isPasskeyCancel } from "./webauthn";

/** What is typed, for which method, and the error under the field. */
export function useCodeEntry(methods: readonly SignInSecondFactorMethod[]) {
  const [method, setMethod] = useState<SignInSecondFactorMethod | null>(() => initialMethod(methods));
  const [value, setValue] = useState("");
  const [fieldError, setFieldError] = useState("");
  const change = useCallback((next: string) => {
    setValue(next);
    setFieldError("");
  }, []);
  const switchTo = useCallback((next: SignInSecondFactorMethod) => {
    setMethod(next);
    setValue("");
    setFieldError("");
  }, []);
  return { method, value, change, fieldError, setFieldError, switchTo, entered: normalizeEnteredCode(value) };
}

/** The one field for the current method (Forms: the error sits under it). */
export function CodeField({ method, value, onChange, error, disabled }: {
  method: CodeMethod;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  const { formatMessage } = useIntl();
  const id = useId();
  const totp = method === "totp";
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value), [onChange]);
  return (
    <FormField
      label={formatMessage({ id: totp ? "auth.secondFactor.totpLabel" : "auth.secondFactor.backupLabel" })}
      hint={formatMessage({ id: totp ? "auth.secondFactor.totpHint" : "auth.secondFactor.backupHint" })}
      error={error || undefined}
      htmlFor={id}
    >
      {/* A code is machine text: Space Mono, centred, like the device code. */}
      <Input
        key={method}
        id={id}
        type="text"
        name={totp ? "one-time-code" : "backup-code"}
        inputMode={totp ? "numeric" : "text"}
        autoComplete={totp ? "one-time-code" : "off"}
        autoCapitalize="off"
        spellCheck={false}
        autoFocus
        placeholder={formatMessage({ id: totp ? "auth.secondFactor.totpPlaceholder" : "auth.secondFactor.backupPlaceholder" })}
        value={value}
        onChange={handleChange}
        disabled={disabled}
        data-invalid={error ? true : undefined}
        className="w-full text-center font-mono"
      />
    </FormField>
  );
}

/**
 * The passkey method (design step-passkey / step-passkey-waiting): a hint
 * and one button that opens the browser's passkey prompt; while it is open
 * the button waits ("Waiting for your passkey…").
 */
export function PasskeyPrompt({ busy, onUse }: { busy: boolean; onUse: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <div className="stack-y-3">
      <TextSans size="small" variant="muted" className="text-center">
        {formatMessage({ id: "auth.secondFactor.passkeyHint" })}
      </TextSans>
      <Button type="button" size="xl" variant="accent" className="w-full gap-2" onClick={onUse} disabled={busy}>
        {busy ? null : <KeyRound aria-hidden="true" />}
        {formatMessage({ id: busy ? "auth.secondFactor.passkeyWaiting" : "auth.secondFactor.passkeyButton" })}
      </Button>
    </div>
  );
}

const SWITCH_LABEL_IDS = {
  passkey: "auth.secondFactor.usePasskey",
  totp: "auth.secondFactor.useTotp",
  backup_code: "auth.secondFactor.useBackupCode",
} as const;

const SWITCH_ICONS: Record<SignInSecondFactorMethod, ReactNode> = {
  passkey: <KeyRound aria-hidden="true" />,
  totp: <Smartphone aria-hidden="true" />,
  backup_code: <Ticket aria-hidden="true" />,
};

/**
 * The other listed methods. `buttons`: under "or", one outline button each
 * (the sign-in step, like the third-party buttons under the sign-in form);
 * `links`: a row of text links (the approval pages, where the page's own
 * buttons follow). Nothing when there is no other method (design
 * step-code-totp-only).
 */
export function MethodSwitch({ methods, current, onSwitch, disabled, appearance }: {
  methods: readonly SignInSecondFactorMethod[];
  current: SignInSecondFactorMethod;
  onSwitch: (method: SignInSecondFactorMethod) => void;
  disabled?: boolean;
  appearance: "buttons" | "links";
}) {
  const { formatMessage } = useIntl();
  const others = methods.filter((method) => method !== current);
  if (others.length === 0) return null;
  if (appearance === "links") {
    return (
      <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-footnote">
        {others.map((method) => (
          <SwitchLink key={method} method={method} onSwitch={onSwitch} disabled={disabled} />
        ))}
      </div>
    );
  }
  return (
    <>
      <Separator className="my-1">{formatMessage({ id: "pages.login.or" })}</Separator>
      <div className="stack-y-2">
        {others.map((method) => (
          <SwitchButton key={method} method={method} onSwitch={onSwitch} disabled={disabled} />
        ))}
      </div>
    </>
  );
}

type SwitchProps = { method: SignInSecondFactorMethod; onSwitch: (method: SignInSecondFactorMethod) => void; disabled?: boolean };

function SwitchButton({ method, onSwitch, disabled }: SwitchProps) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onSwitch(method), [method, onSwitch]);
  return (
    <Button type="button" variant="outline" size="lg" className="w-full gap-3" onClick={handleClick} disabled={disabled}>
      {SWITCH_ICONS[method]}
      <span>{formatMessage({ id: SWITCH_LABEL_IDS[method] })}</span>
    </Button>
  );
}

function SwitchLink({ method, onSwitch, disabled }: SwitchProps) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onSwitch(method), [method, onSwitch]);
  return (
    <TextLink type="button" onClick={handleClick} disabled={disabled}>
      {formatMessage({ id: SWITCH_LABEL_IDS[method] })}
    </TextLink>
  );
}

/**
 * What a refused answer says. `field`: under the field (a wrong or used
 * code); `banner`: above the buttons (also a passkey that didn't verify);
 * `terminal`: this sign-in is over (expired, out of tries, locked), only
 * Back to Sign In is left. A closed passkey prompt is not a failure: callers
 * check isPasskeyCancel first.
 */
export type CodeFailure =
  | { kind: "field"; message: string }
  | { kind: "banner"; message: string }
  | { kind: "terminal"; message: string };

export function useCodeFailure() {
  const { formatMessage } = useIntl();
  const { formatClock } = useTimeFormatter();
  return useCallback((err: unknown, method: SignInSecondFactorMethod): CodeFailure => {
    const failure = secondFactorFailureOf(err);
    switch (failure.code) {
      case "second_factor_code_invalid":
        if (method === "passkey") return { kind: "banner", message: formatMessage({ id: "auth.secondFactor.passkeyInvalid" }) };
        return {
          kind: "field",
          message: formatMessage({ id: method === "backup_code" ? "auth.secondFactor.backupCodeInvalid" : "auth.secondFactor.codeInvalid" }),
        };
      case "backup_code_used":
        return { kind: "field", message: formatMessage({ id: "auth.secondFactor.backupCodeUsed" }) };
      case "challenge_expired":
        return { kind: "terminal", message: formatMessage({ id: "auth.secondFactor.expired" }) };
      case "challenge_attempts_exhausted":
        return { kind: "terminal", message: formatMessage({ id: "auth.secondFactor.attemptsExhausted" }) };
      case "second_factor_locked":
        return {
          kind: "terminal",
          message: formatMessage({ id: "auth.secondFactor.locked" }, { time: failure.lockedUntil ? formatClock(failure.lockedUntil) : "" }),
        };
      case "second_factor_unavailable":
        return { kind: "banner", message: formatMessage({ id: "auth.secondFactor.unavailable" }) };
      case "passkey_not_found":
        return { kind: "banner", message: formatMessage({ id: "auth.secondFactor.passkeyInvalid" }) };
      case "passkeys_unavailable":
        return { kind: "banner", message: formatMessage({ id: "auth.secondFactor.passkeyUnavailable" }) };
      default:
        return { kind: "banner", message: formatMessage({ id: "pages.login.failed" }) };
    }
  }, [formatClock, formatMessage]);
}

/**
 * Approving a device or app login when this sign-in hasn't passed the second
 * step (design device-stepup / applogin-stepup): asked up front when the
 * status says so (stepUpBeforeApproval), or after an approval answered 403
 * `second_factor_step_up_required` with the methods to use. A code or a
 * passkey here marks this sign-in verified (POST /auth/second-factor/step-up,
 * a passkey with options from POST /passkeys/assertion/options) and
 * `onVerified` goes on. Shown only to people with two-step verification on
 * (the server never refuses anyone else).
 */
export function StepUpBeforeApproval({ notice, methods: listed, onVerified }: {
  notice: string;
  methods: readonly SignInSecondFactorMethod[];
  onVerified: () => void | Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const { formatClock } = useTimeFormatter();
  const { methods, passkeyUnsupported } = useMemo(() => usableMethodsOf(listed), [listed]);
  const entry = useCodeEntry(methods);
  const { method, entered, setFieldError } = entry;
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ intent: "info" | "warning"; message: string } | null>(null);

  const stepUp = useCallback(async (answer: () => Promise<StepUpAnswer>, used: SignInSecondFactorMethod) => {
    setBusy(true);
    setBanner(null);
    try {
      await stepUpThisSignIn(await answer());
      rememberSecondFactorMethod(used);
    } catch (err) {
      if (isPasskeyCancel(err)) {
        setBusy(false);
        setBanner({ intent: "info", message: formatMessage({ id: "auth.secondFactor.passkeyCancelled" }) });
        return;
      }
      const failure = secondFactorFailureOf(err);
      // Turned off meanwhile: nothing to step up, so approving goes through.
      if (failure.code !== "second_factor_not_enabled") {
        setBusy(false);
        const warn = (message: string) => setBanner({ intent: "warning", message });
        if (failure.code === "second_factor_code_invalid") {
          if (used === "passkey") warn(formatMessage({ id: "auth.secondFactor.passkeyInvalid" }));
          else setFieldError(formatMessage({ id: used === "backup_code" ? "auth.secondFactor.backupCodeInvalid" : "auth.secondFactor.codeInvalid" }));
        } else if (failure.code === "backup_code_used") {
          setFieldError(formatMessage({ id: "auth.secondFactor.backupCodeUsed" }));
        } else if (failure.code === "second_factor_locked") {
          warn(formatMessage({ id: "auth.secondFactor.stepUpLocked" }, { time: failure.lockedUntil ? formatClock(failure.lockedUntil) : "" }));
        } else if (failure.code === "second_factor_unavailable") {
          warn(formatMessage({ id: "auth.secondFactor.unavailable" }));
        } else if (failure.code === "passkeys_unavailable") {
          warn(formatMessage({ id: "auth.secondFactor.passkeyUnavailable" }));
        } else if (failure.code === "passkey_not_found") {
          warn(formatMessage({ id: "auth.secondFactor.passkeyInvalid" }));
        } else {
          warn(formatMessage({ id: "common.confirm.somethingWentWrong" }));
        }
        return;
      }
    }
    try {
      await onVerified();
    } finally {
      setBusy(false);
    }
  }, [formatClock, formatMessage, onVerified, setFieldError]);

  const submit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!method || method === "passkey" || !entered || busy) return;
    await stepUp(async () => (method === "totp" ? { code: entered } : { backupCode: entered }), method);
  }, [busy, entered, method, stepUp]);

  const handleUsePasskey = useCallback(() => {
    if (busy) return;
    void stepUp(async () => ({ webauthn: await getPasskeyAssertion(await startStepUpPasskeyAssertion()) }), "passkey");
  }, [busy, stepUp]);

  const bannerNode = banner ? <Banner intent={banner.intent}>{banner.message}</Banner> : null;

  return (
    <div data-testid="second-factor-step-up">
      <Banner intent="info" withIcon className="mb-4">{notice}</Banner>
      {passkeyUnsupported && method ? (
        <Banner intent="info" className="mb-4">{formatMessage({ id: "auth.secondFactor.passkeyUnsupported" })}</Banner>
      ) : null}
      {method === "passkey" ? (
        <div className="stack-y-4">
          {bannerNode}
          <PasskeyPrompt busy={busy} onUse={handleUsePasskey} />
        </div>
      ) : method ? (
        <form onSubmit={submit} className="stack-y-4 md:pointer-fine:stack-y-3" noValidate>
          <CodeField method={method} value={entry.value} onChange={entry.change} error={entry.fieldError} disabled={busy} />
          {bannerNode}
          <Button type="submit" size="xl" variant="accent" className="w-full" loading={busy} disabled={!entered}>
            {formatMessage({ id: "auth.secondFactor.verify" })}
          </Button>
        </form>
      ) : (
        <Banner intent="warning">
          {formatMessage({ id: passkeyUnsupported ? "auth.secondFactor.passkeyUnsupported" : "auth.secondFactor.unavailable" })}
        </Banner>
      )}
      {method ? (
        <MethodSwitch methods={methods} current={method} onSwitch={entry.switchTo} disabled={busy} appearance="links" />
      ) : null}
    </div>
  );
}
