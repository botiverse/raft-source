import { Button, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogTitle, Field, FieldDescription, FieldError, FieldLabel, Input, Spinner } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListGroup, ChoiceListItem } from "@botiverse/raft-ui/wip";
import { getRuntimeDisplayName, runtimeAuthChoosesOAuthMethod, runtimeAuthLiteralApiKeyFits } from "@botiverse/raft-shared";
import type { RuntimeAuthProvider, RuntimeAuthProviderOAuthFlow, RuntimeAuthRuntime } from "@botiverse/raft-shared";
import { CircleCheck } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages/en";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import Banner from "../../components/ui/Banner";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../../components/ui/NarrowDialog";
import { FIELD_MESSAGE, providerRequestFailure, providerResultFailure } from "./providerConnectFailure";
import type { ProviderFailure } from "./providerConnectFailure";
import { RuntimeSignInDialog } from "./RuntimeSignInDialog";
import { useComputerName } from "./useComputerName";
import { isLoopbackRequired } from "./loopbackRequiredMethods";

/**
 * Add a provider to a runtime that signs in per provider (Pi, OpenCode 2) on
 * a Computer (docs/contracts/runtime-auth.md §6b, §6c). Described for Pi;
 * OpenCode's differences: its providers are its integration registry, an
 * account may offer several sign-ins (one row each, device code first, the
 * chosen one named on the login start), a sign-in that ended as
 * `loopback_required` on this Computer is greyed out for the session, and
 * its key rule is OpenCode's (`runtimeAuthLiteralApiKeyFits`).
 *
 * Add a provider to the Pi runtime on a Computer:
 * every provider pi's own `/login` lists, read from the Computer, in two
 * groups as pi has them, "Sign in with an account" (OAuth) and "Use an API
 * key". An account goes on to the sign-in dialog, which runs the flow pi has
 * for it without asking the person which mode (a device code, or a code or
 * the landing page's address to paste). A key is typed here and saved in
 * Pi's sign-ins on the Computer. A provider that cannot be added from the web
 * (a flow that needs a browser on the Computer itself, a key login that asks
 * more than the key) is listed, unselectable, with why.
 *
 * The key lives in the password field until it is sent, and is dropped once
 * saved or when the dialog closes; it is never shown again, logged or traced.
 */

const FLOW_TEXT: Record<RuntimeAuthProviderOAuthFlow, MessageId> = {
  device_code: "machine.runtimeAuth.pi.flow.deviceCode",
  paste_code: "machine.runtimeAuth.pi.flow.pasteCode",
  paste_address: "machine.runtimeAuth.pi.flow.pasteAddress",
  computer_only: "machine.runtimeAuth.pi.flow.computerOnly",
  link: "machine.runtimeAuth.opencode.flow.link",
};

/** The words that name the runtime in the key step: Pi's, or OpenCode's. */
const RUNTIME_KEY_TEXT: Record<"pi" | "opencode", { refused: MessageId; outside: MessageId; success: MessageId }> = {
  pi: { refused: "machine.runtimeAuth.pi.key.refused", outside: "machine.runtimeAuth.pi.key.outside", success: "machine.runtimeAuth.pi.key.success" },
  opencode: { refused: "machine.runtimeAuth.opencode.key.refused", outside: "machine.runtimeAuth.opencode.key.outside", success: "machine.runtimeAuth.opencode.key.success" },
};

/** One OAuth sign-in of a provider: Pi's one, or each of OpenCode's. */
type OAuthMethod = { label: string; flow: RuntimeAuthProviderOAuthFlow };

function oauthMethodsOf(provider: RuntimeAuthProvider): readonly OAuthMethod[] {
  const signIn = provider.signIn;
  if (signIn?.oauthMethods) return signIn.oauthMethods;
  return signIn?.oauth ? [signIn.oauth] : [];
}

type ProviderList =
  | { kind: "loading" }
  | { kind: "failed"; failure: ProviderFailure }
  | { kind: "listed"; providers: readonly RuntimeAuthProvider[] };

type Choice = { way: "account" | "key"; provider: RuntimeAuthProvider; method: OAuthMethod | null };

/** `account:<provider id>#<method index>` or `key:<provider id>` (a provider id never holds `#`). */
function choiceOf(value: string | null, providers: readonly RuntimeAuthProvider[]): Choice | null {
  if (!value) return null;
  const [way, ...rest] = value.split(":");
  const [providerId, index] = rest.join(":").split("#");
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider || (way !== "account" && way !== "key")) return null;
  if (way === "key") return { way, provider, method: null };
  const method = oauthMethodsOf(provider)[Number(index ?? 0)];
  return method ? { way, provider, method } : null;
}

export function PiSignInDialog({
  serverId,
  machineId,
  runtimeId,
  runtime,
  client,
  onClose,
}: {
  serverId: string;
  machineId: string;
  /** The Raft runtime (`pi`, `opencode`), for its name. */
  runtimeId: string;
  /** The runtime whose sign-ins these are (`pi`, `opencode`). */
  runtime: RuntimeAuthRuntime;
  client: RuntimeAuthClient;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const runtimeName = getRuntimeDisplayName(runtimeId);
  const keyText = RUNTIME_KEY_TEXT[runtime === "opencode" ? "opencode" : "pi"];
  const choosesMethod = runtimeAuthChoosesOAuthMethod(runtime);
  const computer = useComputerName(machineId) ?? formatMessage({ id: "machine.runtimeAuth.thisComputer" });
  const [list, setList] = useState<ProviderList>({ kind: "loading" });
  const [chosenValue, setChosenValue] = useState<string | null>(null);
  const [step, setStep] = useState<"choose" | "account" | "key" | "done">("choose");
  /** The API key, only while the form is open and unsent. Never logged, never shown back. */
  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<ProviderFailure | null>(null);
  const [keyRefusedByServer, setKeyRefusedByServer] = useState(false);
  const promptId = useId();
  const mountedRef = useRef(false);
  const listAttemptRef = useRef(0);

  // Read once on open and again from Try Again, never by a re-run effect.
  const loadProviders = useCallback(() => {
    const attempt = ++listAttemptRef.current;
    setList({ kind: "loading" });
    client.listProviders(serverId, machineId, runtime).then((result) => {
      if (!mountedRef.current || listAttemptRef.current !== attempt) return;
      setList(result.kind === "listed" ? { kind: "listed", providers: result.providers } : { kind: "failed", failure: providerResultFailure(result, "list") });
    }, (error: unknown) => {
      if (!mountedRef.current || listAttemptRef.current !== attempt) return;
      const refused = providerRequestFailure(error, "list");
      setList({ kind: "failed", failure: "field" in refused ? { messageId: "machine.runtimeAuth.provider.error.invalidInput", retryable: true } : refused });
    });
  }, [client, machineId, runtime, serverId]);

  useEffect(() => {
    mountedRef.current = true;
    if (listAttemptRef.current === 0) loadProviders();
    return () => { mountedRef.current = false; };
  }, [loadProviders]);

  const providers = useMemo(() => (list.kind === "listed" ? list.providers : []), [list]);
  const chosen = choiceOf(chosenValue, providers);

  const { items, groups } = useMemo(() => {
    const signedIn = (provider: RuntimeAuthProvider, way: "oauth" | "api_key") => provider.signIn?.stored === way
      ? <span key="signed-in" className="text-success-strong" data-testid={`pi-provider-signed-in-${provider.id}`}>{formatMessage({ id: "machine.runtimeAuth.pi.signedIn" })}</span>
      : null;
    const accountRows: ChoiceListItem[] = [];
    const keyRows: ChoiceListItem[] = [];
    for (const provider of providers) {
      oauthMethodsOf(provider).forEach((method, index) => {
        // A sign-in that ended as loopback_required on this Computer: greyed out for the session.
        const needsComputer = method.flow === "computer_only" || isLoopbackRequired(machineId, runtime, provider.id, method.label);
        const how = formatMessage({ id: FLOW_TEXT[needsComputer ? "computer_only" : method.flow] });
        accountRows.push({
          value: `account:${provider.id}#${index}`,
          // OpenCode's method labels ("Login with GitHub (device)") do not name the provider.
          label: choosesMethod ? formatMessage({ id: "machine.runtimeAuth.opencode.methodLabel" }, { provider: provider.label, method: method.label }) : method.label,
          searchText: `${method.label} ${provider.label}`,
          description: [how, signedIn(provider, "oauth")],
          disabled: needsComputer,
          group: "account",
        });
      });
      const key = provider.signIn?.apiKey;
      if (key) {
        const why = key.entry === "more_fields"
          ? formatMessage({ id: "machine.runtimeAuth.pi.key.moreFields" })
          : key.entry === "outside" ? formatMessage({ id: keyText.outside }) : null;
        keyRows.push({
          value: `key:${provider.id}`,
          label: provider.label,
          searchText: `${provider.label} ${key.label}`,
          description: [why, signedIn(provider, "api_key")],
          disabled: key.entry !== "key",
          group: "key",
        });
      }
    }
    const shownGroups: ChoiceListGroup[] = [
      ...(accountRows.length > 0 ? [{ value: "account", label: formatMessage({ id: "machine.runtimeAuth.pi.group.account" }) }] : []),
      ...(keyRows.length > 0 ? [{ value: "key", label: formatMessage({ id: "machine.runtimeAuth.pi.group.apiKey" }) }] : []),
    ];
    return { items: [...accountRows, ...keyRows], groups: shownGroups };
  }, [choosesMethod, formatMessage, keyText, machineId, providers, runtime]);

  const handleChoose = useCallback((value: string) => setChosenValue(value), []);

  const handleContinue = useCallback(() => {
    if (!chosen) return;
    setFailure(null);
    setKeyRefusedByServer(false);
    setApiKey("");
    setStep(chosen.way === "account" ? "account" : "key");
  }, [chosen]);

  const handleBack = useCallback(() => {
    setFailure(null);
    setKeyRefusedByServer(false);
    setApiKey("");
    setStep("choose");
  }, []);

  const handleApiKey = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setApiKey(event.target.value);
    setKeyRefusedByServer(false);
  }, []);

  const trimmedKey = apiKey.trim();
  // Pi would run a key starting with ! as a command and fill in a $ name; OpenCode is not given
  // an {env:} or {file:} reference: said at once, never sent.
  const keyRefusedHere = trimmedKey !== "" && !runtimeAuthLiteralApiKeyFits(runtime, trimmedKey);

  const handleConnect = useCallback((event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!chosen || chosen.way !== "key" || !trimmedKey || keyRefusedHere || connecting) return;
    setConnecting(true);
    setFailure(null);
    setKeyRefusedByServer(false);
    client.connectProvider(serverId, machineId, runtime, { providerId: chosen.provider.id, apiKey: trimmedKey }).then((result) => {
      // A save, or one that may have happened: the card reads the new status.
      if (result.kind === "connected" || (result.kind === "failed" && result.reason === "timed_out")) client.invalidate(serverId, machineId);
      if (!mountedRef.current) return;
      setConnecting(false);
      if (result.kind === "connected") {
        setApiKey("");
        setStep("done");
        return;
      }
      // OpenCode's key save waits for no sign-in: one running or waiting on that Computer makes it busy.
      setFailure(result.kind === "busy" && runtime === "opencode"
        ? { messageId: "machine.runtimeAuth.opencode.error.signInInProgress", retryable: true }
        : providerResultFailure(result, "connect"));
    }, (error: unknown) => {
      if (!mountedRef.current) return;
      setConnecting(false);
      const refused = providerRequestFailure(error, "connect");
      if ("field" in refused) setKeyRefusedByServer(true);
      else setFailure(refused);
    });
  }, [chosen, client, connecting, keyRefusedHere, machineId, runtime, serverId, trimmedKey]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) onClose();
  }, [onClose]);

  // An account: the sign-in dialog takes over, named after the provider's sign-in.
  const accountOauth = step === "account" && chosen?.way === "account" ? chosen.method : null;
  const accountProviderId = chosen?.provider.id;
  const accountProviderLabel = chosen?.provider.label;
  const signInProvider = useMemo(() => (accountOauth && accountProviderId
    ? {
        id: accountProviderId,
        // Pi's sign-in names its provider ("Anthropic (Claude Pro/Max)"); OpenCode's method does not.
        label: choosesMethod ? accountProviderLabel ?? accountOauth.label : accountOauth.label,
        ...(accountOauth.flow === "paste_address" ? { paste: "address" as const } : accountOauth.flow === "paste_code" ? { paste: "code" as const } : {}),
        ...(choosesMethod ? { oauthMethod: accountOauth.label } : {}),
      }
    : null), [accountOauth, accountProviderId, accountProviderLabel, choosesMethod]);
  if (signInProvider) {
    return (
      <RuntimeSignInDialog
        serverId={serverId}
        machineId={machineId}
        runtimeId={runtimeId}
        runtime={runtime}
        client={client}
        onClose={onClose}
        provider={signInProvider}
      />
    );
  }

  const title = formatMessage({ id: "machine.runtimeAuth.pi.title" }, { runtime: runtimeName });
  const values = { runtime: chosen?.provider.label ?? runtimeName, piRuntime: runtimeName, computer };
  const keyInvalid = keyRefusedHere || keyRefusedByServer;

  return (
    <Dialog open disablePointerDismissal onOpenChange={handleOpenChange}>
      <NarrowDialogContent
        narrow="sheet"
        layer={1}
        className="max-w-md"
        data-testid={`runtime-pi-sign-in-dialog-${runtime}`}
        title={title}
        closeLabel={formatMessage({ id: "common.close" })}
        header={(
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogClose aria-label={formatMessage({ id: "common.close" })} />
          </DialogHeader>
        )}
      >
        <DialogBody className="grid gap-4 font-normal">
          {step === "done" ? (
            <Banner intent="success" icon={<CircleCheck size={20} aria-hidden="true" />} data-testid="pi-key-saved">
              {formatMessage({ id: keyText.success }, values)}
            </Banner>
          ) : list.kind === "loading" ? (
            <div className="flex items-center gap-2 text-subhead text-foreground-muted" role="status">
              <Spinner size="xs" aria-hidden="true" />
              {formatMessage({ id: "machine.runtimeAuth.provider.loading" }, { computer })}
            </div>
          ) : list.kind === "failed" ? (
            <Banner intent="warning" withIcon data-testid="pi-provider-list-failed">
              {formatMessage({ id: list.failure.messageId }, values)}
            </Banner>
          ) : step === "key" && chosen?.way === "key" ? (
            <form id={`${promptId}-form`} className="grid gap-4 md:pointer-fine:gap-3" onSubmit={handleConnect} noValidate data-testid="pi-key-form">
              <p className="text-subhead text-foreground" data-testid="pi-key-provider">
                {formatMessage({ id: "machine.runtimeAuth.pi.key.chosen" }, { provider: chosen.provider.label })}
              </p>
              <Field invalid={keyInvalid}>
                <FieldLabel required>{formatMessage({ id: "machine.runtimeAuth.provider.apiKeyLabel" })}</FieldLabel>
                {/* A password field that no password manager offers to keep: the key is
                    the provider's, not a sign-in to this site. */}
                <Input
                  type="password"
                  value={apiKey}
                  onChange={handleApiKey}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  suppressPasswordManager
                  disabled={connecting}
                  data-invalid={keyInvalid || undefined}
                  className="font-mono"
                  data-testid="pi-key-input"
                />
                {keyRefusedHere ? (
                  <FieldError match data-testid="pi-key-refused">{formatMessage({ id: keyText.refused })}</FieldError>
                ) : keyRefusedByServer ? (
                  <FieldError match>{formatMessage({ id: FIELD_MESSAGE.apiKey })}</FieldError>
                ) : (
                  <FieldDescription>{formatMessage({ id: "machine.runtimeAuth.pi.key.hint" }, { provider: chosen.provider.label })}</FieldDescription>
                )}
              </Field>
              <p className="text-caption text-foreground-hint" data-testid="pi-scope">
                {formatMessage({ id: "machine.runtimeAuth.pi.scopeNote" }, values)}
              </p>
              {failure ? (
                <Banner intent="warning" withIcon data-testid="pi-key-failed">
                  {formatMessage({ id: failure.messageId }, values)}
                </Banner>
              ) : null}
            </form>
          ) : (
            <div className="grid gap-3" data-testid="pi-provider-choose">
              <p id={promptId} className="text-subhead text-foreground-muted">
                {formatMessage({ id: "machine.runtimeAuth.pi.choosePrompt" }, values)}
              </p>
              <ChoiceList
                aria-labelledby={promptId}
                searchLabel={formatMessage({ id: "machine.runtimeAuth.provider.search" })}
                clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
                noMatchLabel={formatMessage({ id: "machine.runtimeAuth.provider.noMatch" })}
                empty={formatMessage({ id: "machine.runtimeAuth.provider.empty" }, values)}
                items={items}
                groups={groups}
                value={chosenValue}
                onValueChange={handleChoose}
                className="max-h-[420px]"
              />
              <p className="text-caption text-foreground-hint">
                {formatMessage({ id: "machine.runtimeAuth.pi.scopeNote" }, values)}
              </p>
            </div>
          )}
        </DialogBody>
        <DialogActions as={DialogFooter}>
          {step === "done" ? (
            <DialogCommit>
              {(inHead) => (
                <Button size={inHead ? "md" : "lg"} variant="primary" onClick={onClose}>
                  {formatMessage({ id: "machine.runtimeAuth.signIn.done" })}
                </Button>
              )}
            </DialogCommit>
          ) : list.kind === "failed" ? (
            <>
              <DialogClose render={<Button size="lg" variant="ghost" />}>{formatMessage({ id: "common.close" })}</DialogClose>
              {list.failure.retryable ? (
                <DialogCommit>
                  {(inHead) => (
                    <Button size={inHead ? "md" : "lg"} variant="primary" onClick={loadProviders}>
                      {formatMessage({ id: "machine.runtimeAuth.signIn.retry" })}
                    </Button>
                  )}
                </DialogCommit>
              ) : null}
            </>
          ) : step === "key" && chosen?.way === "key" ? (
            <>
              <Button size="lg" variant="ghost" onClick={handleBack} disabled={connecting}>
                {formatMessage({ id: "machine.runtimeAuth.provider.back" })}
              </Button>
              <DialogCommit>
                {(inHead) => (
                  <Button
                    size={inHead ? "md" : "lg"}
                    variant="primary"
                    type="submit"
                    form={`${promptId}-form`}
                    disabled={!trimmedKey || keyRefusedHere}
                    loading={connecting}
                    loadingLabel={formatMessage({ id: "machine.runtimeAuth.provider.connecting" })}
                  >
                    {formatMessage({ id: "machine.runtimeAuth.provider.connect" })}
                  </Button>
                )}
              </DialogCommit>
            </>
          ) : (
            <>
              <DialogClose render={<Button size="lg" variant="ghost" />}>{formatMessage({ id: "common.confirm.cancel" })}</DialogClose>
              {list.kind === "listed" ? (
                <DialogCommit>
                  {(inHead) => (
                    <Button size={inHead ? "md" : "lg"} variant="primary" disabled={!chosen} onClick={handleContinue}>
                      {formatMessage({ id: "machine.runtimeAuth.signIn.continue" })}
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
