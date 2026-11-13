import { Button, CopyableCode, CopyableCodeAction, CopyableCodeRoot, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogTitle, Field, FieldDescription, FieldError, FieldLabel, Input, Spinner, TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import { RUNTIME_AUTH_LOGIN_REGION_CHOICES, getRuntimeDisplayName } from "@botiverse/raft-shared";
import type { RuntimeAuthAccount, RuntimeAuthLoginEvent, RuntimeAuthLoginId, RuntimeAuthLoginRegion, RuntimeAuthLoginResult, RuntimeAuthRuntime } from "@botiverse/raft-shared";
import { CircleCheck } from "lucide-react";
import LeavingRaftMark from "../../components/ui/LeavingRaftMark";
import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages/en";
import { runtimeAuthRequestError } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient, RuntimeAuthLoginEventMessage, RuntimeAuthLoginResultMessage } from "../../utils/runtimeAuthClient";
import Banner from "../../components/ui/Banner";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../../components/ui/NarrowDialog";
import { useComputerName } from "./useComputerName";
import { accountText } from "./accountText";
import { rememberLoopbackRequired } from "./loopbackRequiredMethods";
import { NewTabLink } from "./NewTabLink";

/**
 * task #17 (docs/contracts/runtime-auth.md): sign a Computer's runtime (Claude
 * Code, Codex, Kimi, Qoder) in from the web, and log it out. The login runs on
 * the Computer; this page only shows its link or device code and relays
 * Claude's pasted code.
 * The pasted code is never logged or traced, and is cleared once it is sent
 * or the login ends.
 */

/** Each region's name, as the person chooses it before Kimi's login starts. */
const REGION_LABEL: Record<RuntimeAuthLoginRegion, MessageId> = {
  "mainland-cn": "machine.runtimeAuth.signIn.region.mainlandChina",
  global: "machine.runtimeAuth.signIn.region.international",
};

/** Why a sign-in stopped, and whether starting it again could help. */
interface SignInFailure {
  messageId: MessageId;
  retryable: boolean;
}

/** The start request was refused. */
function startFailure(status: number | null, code: string | null): SignInFailure {
  if (code === "computer_offline") return { messageId: "machine.runtimeAuth.error.computerOffline", retryable: true };
  if (code === "computer_upgrade_required") return { messageId: "machine.runtimeAuth.upgradeRequired", retryable: false };
  if (code === "computer_not_attached") return { messageId: "machine.runtimeAuth.notAttached", retryable: false };
  if (code === "login_in_progress") return { messageId: "machine.runtimeAuth.error.busy", retryable: true };
  if (code === "rate_limited" || status === 429) return { messageId: "machine.runtimeAuth.error.rateLimited", retryable: true };
  if (status === 403) return { messageId: "machine.runtimeAuth.error.forbidden", retryable: false };
  if (status === 404) return { messageId: "machine.runtimeAuth.error.notFound", retryable: false };
  return { messageId: "machine.runtimeAuth.error.startFailed", retryable: true };
}

/** The Computer ended the login without signing in. */
function resultFailure(result: Exclude<RuntimeAuthLoginResult, { kind: "logged_in" }>): SignInFailure {
  if (result.kind === "busy") return { messageId: "machine.runtimeAuth.error.busy", retryable: true };
  if (result.kind === "cancelled") return { messageId: "machine.runtimeAuth.error.cancelled", retryable: true };
  if (result.kind === "unsupported") {
    if (result.reason === "version_unsupported") return { messageId: "machine.runtimeAuth.error.versionUnsupported", retryable: false };
    if (result.reason === "not_installed") return { messageId: "machine.runtimeAuth.error.notInstalled", retryable: false };
    return { messageId: "machine.runtimeAuth.error.unsupportedInstallation", retryable: false };
  }
  switch (result.reason) {
    case "timed_out": return { messageId: "machine.runtimeAuth.error.timedOut", retryable: true };
    case "rejected": return { messageId: "machine.runtimeAuth.error.rejected", retryable: true };
    case "not_logged_in": return { messageId: "machine.runtimeAuth.error.notLoggedIn", retryable: true };
    case "interaction_failed": return { messageId: "machine.runtimeAuth.error.interactionFailed", retryable: false };
    case "process_failed": return { messageId: "machine.runtimeAuth.error.processFailed", retryable: true };
    // OpenCode: the chosen sign-in returns to a browser on the Computer itself; another way, not a retry.
    case "loopback_required": return { messageId: "machine.runtimeAuth.error.loopbackRequired", retryable: false };
  }
}

/**
 * A failure's words for this runtime: a per-provider runtime's busy names it
 * (another of its sign-ins may be for another provider), and OpenCode's
 * "too old" says it needs OpenCode 2.
 */
function failureMessageFor(runtime: RuntimeAuthRuntime, perProvider: boolean, messageId: MessageId): MessageId {
  if (messageId === "machine.runtimeAuth.error.busy" && perProvider) {
    return runtime === "opencode" ? "machine.runtimeAuth.opencode.error.busy" : "machine.runtimeAuth.pi.error.busy";
  }
  if (messageId === "machine.runtimeAuth.error.versionUnsupported" && runtime === "opencode") return "machine.runtimeAuth.opencode.versionUnsupported";
  return messageId;
}

/** `invalid`: the server refused the value; `sendFailed`: it never got there (the value is kept to resend). */
type CodeState = "idle" | "submitting" | "sent" | "invalid" | "sendFailed";

interface SignInState {
  /** True once the Computer sent its first event; until then the dialog says it is starting. */
  started: boolean;
  authUrl: Extract<RuntimeAuthLoginEvent, { kind: "auth_url" }> | null;
  deviceCode: Extract<RuntimeAuthLoginEvent, { kind: "device_code" }> | null;
  info: string | null;
  codePrompt: Extract<RuntimeAuthLoginEvent, { kind: "code_prompt" }> | null;
  /** The pasted code, until it is sent or the login ends. Never logged. */
  code: string;
  codeState: CodeState;
  done: { account?: RuntimeAuthAccount } | null;
  failure: SignInFailure | null;
}

type SignInAction =
  | { type: "retry" }
  | { type: "event"; event: RuntimeAuthLoginEvent }
  | { type: "result"; result: RuntimeAuthLoginResult }
  | { type: "failed"; failure: SignInFailure }
  | { type: "codeChanged"; code: string }
  | { type: "codeState"; state: CodeState };

const INITIAL_SIGN_IN: SignInState = {
  started: false,
  authUrl: null,
  deviceCode: null,
  info: null,
  codePrompt: null,
  code: "",
  codeState: "idle",
  done: null,
  failure: null,
};

function signInReducer(state: SignInState, action: SignInAction): SignInState {
  switch (action.type) {
    case "retry":
      return INITIAL_SIGN_IN;
    case "event": {
      if (state.done || state.failure) return state;
      const next = { ...state, started: true };
      const { event } = action;
      if (event.kind === "auth_url") return { ...next, authUrl: event };
      if (event.kind === "device_code") return { ...next, deviceCode: event };
      if (event.kind === "info") return { ...next, info: event.message };
      // A new prompt (first, or after a code the runtime did not accept) asks again.
      return { ...next, codePrompt: event, codeState: "idle" };
    }
    case "result":
      if (state.done || state.failure) return state;
      return action.result.kind === "logged_in"
        ? { ...state, started: true, code: "", done: { account: action.result.account } }
        : { ...state, started: true, code: "", failure: resultFailure(action.result) };
    case "failed":
      return { ...state, code: "", failure: action.failure };
    case "codeChanged":
      return { ...state, code: action.code, codeState: state.codeState === "submitting" ? state.codeState : "idle" };
    case "codeState":
      // Sent: the code has left this page, so it is not kept.
      return { ...state, codeState: action.state, code: action.state === "sent" ? "" : state.code };
  }
}

/** Keeps at most this many events that arrive before the start request answers. */
const EARLY_EVENT_LIMIT = 16;

type EarlyMessage =
  | { kind: "event"; message: RuntimeAuthLoginEventMessage }
  | { kind: "result"; message: RuntimeAuthLoginResultMessage };

/** The login this dialog shows; `running` until its result arrives or it is cancelled. */
type ShownLogin = { id: RuntimeAuthLoginId; running: boolean };

export function RuntimeSignInDialog({
  serverId,
  machineId,
  runtimeId,
  runtime,
  client,
  onClose,
  provider,
}: {
  serverId: string;
  machineId: string;
  /** The Raft runtime the person picked (Kimi Code), for its name. */
  runtimeId: string;
  /** The runtime whose sign-in it uses (OAR's `kimi`). */
  runtime: RuntimeAuthRuntime;
  client: RuntimeAuthClient;
  onClose: () => void;
  /**
   * The provider to sign in, for a runtime that signs in per provider (Pi,
   * OpenCode): the dialog is named after it, and `paste` says what its paste
   * step takes (`code`: a code the sign-in page shows; `address`: the address
   * of the page the browser lands on, which will not load). `oauthMethod`:
   * the OAuth sign-in the person chose, by its label (OpenCode); one that
   * ends as `loopback_required` is remembered for this Computer.
   */
  provider?: { id: string; label: string; paste?: "code" | "address"; oauthMethod?: string };
}) {
  const { formatMessage } = useIntl();
  const runtimeName = provider?.label ?? getRuntimeDisplayName(runtimeId);
  const providerId = provider?.id;
  const oauthMethod = provider?.oauthMethod;
  const computer = useComputerName(machineId) ?? formatMessage({ id: "machine.runtimeAuth.thisComputer" });
  const [state, dispatch] = useReducer(signInReducer, INITIAL_SIGN_IN);
  // A runtime whose login needs a region (Kimi) asks for it first, with
  // nothing chosen, and starts only once the person continues (xxchan: no
  // default, no guess). `region` is the choice; `startedRegion` the one the
  // login runs with, which Try Again keeps.
  const regionChoices = RUNTIME_AUTH_LOGIN_REGION_CHOICES[runtime];
  const asksRegion = regionChoices.length > 0;
  const [region, setRegion] = useState<RuntimeAuthLoginRegion | null>(null);
  const [startedRegion, setStartedRegion] = useState<RuntimeAuthLoginRegion | null>(null);
  const choosingRegion = asksRegion && startedRegion === null;
  const regionPromptId = useId();
  // Null while a start request runs (or before the first); a running login is cancelled on close.
  const loginRef = useRef<ShownLogin | null>(null);
  // Events that arrive before the start request answers; non-null only while it runs.
  const earlyRef = useRef<EarlyMessage[] | null>(null);
  const attemptRef = useRef(0);
  const mountedRef = useRef(false);
  const closedRef = useRef(false);

  const cancelLogin = useCallback((loginId: RuntimeAuthLoginId) => {
    void client.cancelLogin(serverId, machineId, runtime, loginId).catch(() => undefined);
  }, [client, machineId, runtime, serverId]);

  /** Stops the shown login, if it still runs; returns its id when it did. */
  const releaseLogin = useCallback((): RuntimeAuthLoginId | null => {
    const login = loginRef.current;
    if (!login?.running) return null;
    login.running = false;
    return login.id;
  }, []);

  const apply = useCallback((item: EarlyMessage) => {
    if (item.kind === "event") {
      dispatch({ type: "event", event: item.message.event });
      return;
    }
    releaseLogin();
    const { result } = item.message;
    if (result.kind === "failed" && result.reason === "loopback_required" && providerId && oauthMethod) {
      rememberLoopbackRequired(machineId, runtime, providerId, oauthMethod);
    }
    dispatch({ type: "result", result });
    client.invalidate(serverId, machineId);
  }, [client, machineId, oauthMethod, providerId, releaseLogin, runtime, serverId]);

  // Started once on open and again from Retry, never by a re-run effect:
  // StrictMode's second effect pass would start a second login.
  const begin = useCallback((loginRegion?: RuntimeAuthLoginRegion) => {
    const attempt = ++attemptRef.current;
    loginRef.current = null;
    earlyRef.current = [];
    client.startLogin(serverId, machineId, runtime, loginRegion, providerId, oauthMethod).then(({ loginId }) => {
      if (attemptRef.current !== attempt) return;
      const early = earlyRef.current ?? [];
      earlyRef.current = null;
      if (!mountedRef.current || closedRef.current) {
        // Closed while starting: the login began anyway, so end it.
        cancelLogin(loginId);
        return;
      }
      loginRef.current = { id: loginId, running: true };
      for (const item of early) {
        if (item.message.loginId === loginId) apply(item);
      }
    }, (error: unknown) => {
      if (attemptRef.current !== attempt) return;
      earlyRef.current = null;
      if (!mountedRef.current) return;
      const { status, code } = runtimeAuthRequestError(error);
      dispatch({ type: "failed", failure: startFailure(status, code) });
    });
  }, [apply, cancelLogin, client, machineId, oauthMethod, providerId, runtime, serverId]);

  // Only this login's events are shown; the ones that arrive before its id is
  // known wait in `earlyRef` and are replayed (or dropped) once it is.
  useEffect(() => {
    const route = (item: EarlyMessage) => {
      const { message } = item;
      if (message.serverId !== serverId || message.machineId !== machineId || message.runtime !== runtime) return;
      const login = loginRef.current;
      if (!login) {
        const early = earlyRef.current;
        if (early && early.length < EARLY_EVENT_LIMIT) early.push(item);
        return;
      }
      if (message.loginId === login.id) apply(item);
    };
    return client.onLogin({
      event: (message) => route({ kind: "event", message }),
      result: (message) => route({ kind: "result", message }),
    });
  }, [apply, client, machineId, runtime, serverId]);

  useEffect(() => {
    mountedRef.current = true;
    if (attemptRef.current === 0 && !asksRegion) begin();
    return () => {
      mountedRef.current = false;
      // Unmounted without the close button (the page went away): end the login too.
      const running = releaseLogin();
      if (running) cancelLogin(running);
    };
  }, [asksRegion, begin, cancelLogin, releaseLogin]);

  const handleClose = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    const running = releaseLogin();
    if (running) cancelLogin(running);
    onClose();
  }, [cancelLogin, onClose, releaseLogin]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) handleClose();
  }, [handleClose]);

  const handleRetry = useCallback(() => {
    dispatch({ type: "retry" });
    begin(startedRegion ?? undefined);
  }, [begin, startedRegion]);

  const handleRegionChange = useCallback((value: string) => {
    setRegion(regionChoices.find((choice) => choice === value) ?? null);
  }, [regionChoices]);

  const handleContinue = useCallback(() => {
    if (!region) return;
    setStartedRegion(region);
    begin(region);
  }, [begin, region]);

  const regionItems = useMemo(
    () => regionChoices.map((choice) => ({ value: choice, label: formatMessage({ id: REGION_LABEL[choice] }) })),
    [formatMessage, regionChoices],
  );

  const handleCodeChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    dispatch({ type: "codeChanged", code: event.target.value });
  }, []);

  const code = state.code;
  const handleSubmitCode = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = code.trim();
    const login = loginRef.current;
    if (!login?.running || !trimmed) return;
    dispatch({ type: "codeState", state: "submitting" });
    client.submitCode(serverId, machineId, runtime, login.id, trimmed).then(() => {
      dispatch({ type: "codeState", state: "sent" });
    }, (error: unknown) => {
      // Only the status and the server's code are read: never the request or the value.
      const { status, code: errorCode } = runtimeAuthRequestError(error);
      if (errorCode === "invalid_code" || status === 400) {
        dispatch({ type: "codeState", state: "invalid" });
      } else if (status === 404) {
        releaseLogin();
        dispatch({ type: "failed", failure: { messageId: "machine.runtimeAuth.error.loginGone", retryable: true } });
      } else if (errorCode === "computer_offline") {
        // An offline Computer has already ended the login on its side.
        releaseLogin();
        dispatch({ type: "failed", failure: { messageId: "machine.runtimeAuth.error.computerOffline", retryable: true } });
      } else {
        dispatch({ type: "codeState", state: "sendFailed" });
      }
    });
  }, [client, code, machineId, releaseLogin, runtime, serverId]);

  const ended = state.done !== null || state.failure !== null;
  const codeBusy = state.codeState === "submitting" || state.codeState === "sent";
  const codeRejected = state.codeState === "invalid" || (state.codeState === "idle" && state.codePrompt?.retry === true);
  // One pink button per screen (Raft DS Button): opening the sign-in page
  // leads until a code is pasted, then sending it does.
  const codeEntered = state.codePrompt !== null && code.trim() !== "";
  // Pi's pasted step is ours to word (its prompt's own message is pi's English), and so is
  // OpenCode's (its provider's English); the others keep theirs.
  const pastesAddress = provider?.paste === "address";
  const codeHint = provider
    ? formatMessage({ id: runtime === "pi" ? (pastesAddress ? "machine.runtimeAuth.pi.paste.addressHint" : "machine.runtimeAuth.pi.paste.codeHint") : "machine.runtimeAuth.signIn.codeHint" })
    : state.codePrompt?.message ?? formatMessage({ id: runtime === "antigravity" ? "machine.runtimeAuth.signIn.codeHintAntigravity" : "machine.runtimeAuth.signIn.codeHint" });

  return (
    <Dialog open disablePointerDismissal onOpenChange={handleOpenChange}>
      <NarrowDialogContent
        narrow="sheet"
        layer={1}
        className="max-w-md"
        data-testid={`runtime-sign-in-dialog-${runtime}`}
        title={formatMessage({ id: "machine.runtimeAuth.signIn.title" }, { runtime: runtimeName })}
        closeLabel={formatMessage({ id: "common.close" })}
        header={(
          <DialogHeader>
            <DialogTitle>{formatMessage({ id: "machine.runtimeAuth.signIn.title" }, { runtime: runtimeName })}</DialogTitle>
            <DialogClose aria-label={formatMessage({ id: "common.close" })} />
          </DialogHeader>
        )}
      >
        <DialogBody className="grid gap-4 font-normal">
          {choosingRegion ? (
            <div className="grid gap-3" data-testid="runtime-sign-in-region">
              <p id={regionPromptId} className="text-subhead text-foreground-muted">
                {formatMessage({ id: "machine.runtimeAuth.signIn.regionPrompt" }, { runtime: runtimeName })}
              </p>
              <ChoiceList
                aria-labelledby={regionPromptId}
                searchLabel={formatMessage({ id: "machine.runtimeAuth.signIn.regionSearch" })}
                clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
                items={regionItems}
                value={region}
                onValueChange={handleRegionChange}
              />
            </div>
          ) : state.done ? (
            <Banner
              intent="success"
              icon={<CircleCheck size={20} aria-hidden="true" />}
              title={formatMessage({ id: "machine.runtimeAuth.signIn.success" }, { runtime: runtimeName, computer })}
            >
              {accountText(state.done.account) ? (
                <span className="font-mono text-mono-meta" data-testid="runtime-sign-in-account">{accountText(state.done.account)}</span>
              ) : null}
            </Banner>
          ) : state.failure ? (
            <Banner intent="warning" withIcon data-testid="runtime-sign-in-failed">
              {formatMessage({ id: failureMessageFor(runtime, provider !== undefined, state.failure.messageId) }, { runtime: runtimeName, computer })}
            </Banner>
          ) : !state.started ? (
            <div className="flex items-center gap-2 text-subhead text-foreground-muted" role="status">
              <Spinner size="xs" aria-hidden="true" />
              {formatMessage({ id: "machine.runtimeAuth.signIn.starting" }, { computer })}
            </div>
          ) : (
            <>
              {state.authUrl ? (
                <div className="grid justify-items-start gap-3">
                  {/* Our own words for the prompt's kind, never the runtime's: OAR's
                      `instructions` are an English line ("Open this URL to sign in
                      to Qoder."), and the code field below says the rest for Claude. */}
                  <p className="text-subhead text-foreground-muted" data-testid="runtime-sign-in-hint">
                    {formatMessage({ id: "machine.runtimeAuth.signIn.authUrlHint" }, { runtime: runtimeName })}
                  </p>
                  {/* An <a> drawn as a button (nativeButton off, as elsewhere in the app); it opens the sign-in page in a new tab. */}
                  <Button variant={codeEntered ? "default" : "primary"} nativeButton={false} render={<NewTabLink href={state.authUrl.url} />}>
                    {formatMessage({ id: "machine.runtimeAuth.signIn.openPage" })}
                    <LeavingRaftMark data-icon="inline-end" />
                  </Button>
                </div>
              ) : null}
              {state.deviceCode ? (
                <div className="grid justify-items-stretch gap-2">
                  <p className="text-subhead text-foreground-muted">
                    {formatMessage({ id: "machine.runtimeAuth.signIn.deviceCodeHint" })}
                  </p>
                  <TextLink
                    variant="strong"
                    className="justify-self-start break-all text-subhead"
                    render={<NewTabLink href={state.deviceCode.verificationUri} />}
                  >
                    {state.deviceCode.verificationUri}
                    <TextLinkExternalIcon label={formatMessage({ id: "common.opensInNewTab" })} />
                  </TextLink>
                  <CopyableCodeRoot size="md">
                    <CopyableCode className="text-title tracking-widest" data-testid="runtime-sign-in-device-code">
                      {state.deviceCode.userCode}
                    </CopyableCode>
                    <CopyableCodeAction aria-label={formatMessage({ id: "machine.runtimeAuth.signIn.copyCode" })} />
                  </CopyableCodeRoot>
                  {state.deviceCode.expiresInSeconds ? (
                    <p className="text-caption text-foreground-hint">
                      {formatMessage(
                        { id: "machine.runtimeAuth.signIn.deviceCodeExpiry" },
                        { minutes: Math.max(1, Math.round(state.deviceCode.expiresInSeconds / 60)) },
                      )}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {state.info ? <p className="text-caption text-foreground-hint">{state.info}</p> : null}
              {state.codePrompt ? (
                <form className="grid gap-2" onSubmit={handleSubmitCode}>
                  <Field invalid={codeRejected}>
                    <FieldLabel>{formatMessage({ id: pastesAddress ? "machine.runtimeAuth.pi.paste.addressLabel" : "machine.runtimeAuth.signIn.codeLabel" })}</FieldLabel>
                    <div className="flex items-start gap-2">
                      <Input
                        value={code}
                        onChange={handleCodeChange}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={codeBusy}
                        data-invalid={codeRejected || undefined}
                        className="min-w-0 flex-1 font-mono"
                        data-testid="runtime-sign-in-code"
                      />
                      <Button
                        type="submit"
                        variant={codeEntered ? "primary" : "default"}
                        loading={state.codeState === "submitting"}
                        loadingLabel={formatMessage({ id: "machine.runtimeAuth.signIn.sendingCode" })}
                        disabled={state.codeState === "sent" || !code.trim()}
                      >
                        {formatMessage({ id: "machine.runtimeAuth.signIn.submitCode" })}
                      </Button>
                    </div>
                    {codeRejected ? (
                      <FieldError match>
                        {formatMessage({ id: state.codeState === "invalid" ? "machine.runtimeAuth.signIn.codeInvalid" : "machine.runtimeAuth.signIn.codeRetry" })}
                      </FieldError>
                    ) : (
                      <FieldDescription data-testid="runtime-sign-in-code-hint">{codeHint}</FieldDescription>
                    )}
                  </Field>
                  {state.codeState === "sendFailed" ? (
                    <Banner intent="warning" withIcon>
                      {formatMessage({ id: "machine.runtimeAuth.signIn.codeSendFailed" })}
                    </Banner>
                  ) : null}
                  {state.codeState === "sent" ? (
                    <div className="flex items-center gap-2 text-caption text-foreground-hint" role="status">
                      <Spinner size="xs" aria-hidden="true" />
                      {formatMessage({ id: "machine.runtimeAuth.signIn.checkingCode" })}
                    </div>
                  ) : null}
                </form>
              ) : null}
            </>
          )}
        </DialogBody>
        <DialogActions as={DialogFooter}>
          {choosingRegion ? (
            <>
              <Button size="lg" variant="ghost" onClick={handleClose}>
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <DialogCommit>
                {(inHead) => (
                  <Button size={inHead ? "md" : "lg"} variant="primary" disabled={!region} onClick={handleContinue}>
                    {formatMessage({ id: "machine.runtimeAuth.signIn.continue" })}
                  </Button>
                )}
              </DialogCommit>
            </>
          ) : state.done ? (
            <DialogCommit>
              {(inHead) => (
                <Button size={inHead ? "md" : "lg"} variant="primary" onClick={handleClose}>
                  {formatMessage({ id: "machine.runtimeAuth.signIn.done" })}
                </Button>
              )}
            </DialogCommit>
          ) : (
            <>
              <Button size="lg" variant="ghost" onClick={handleClose}>
                {formatMessage({ id: ended ? "common.close" : "common.confirm.cancel" })}
              </Button>
              {state.failure?.retryable ? (
                <DialogCommit>
                  {(inHead) => (
                    <Button size={inHead ? "md" : "lg"} variant="primary" onClick={handleRetry}>
                      {formatMessage({ id: "machine.runtimeAuth.signIn.retry" })}
                    </Button>
                  )}
                </DialogCommit>
              ) : null}
            </>
          )}
        </DialogActions>
      </NarrowDialogContent>
    </Dialog>
  );
}
