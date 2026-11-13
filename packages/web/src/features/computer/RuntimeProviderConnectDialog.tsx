import { Button, Dialog, DialogBody, DialogClose, DialogFooter, DialogHeader, DialogTitle, Field, FieldDescription, FieldError, FieldLabel, Input, Select, SelectContent, SelectIcon, SelectItem, SelectItemIndicator, SelectItemText, SelectList, SelectTrigger, SelectValue, Spinner } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListGroup, ChoiceListItem } from "@botiverse/raft-ui/wip";
import { getRuntimeDisplayName } from "@botiverse/raft-shared";
import type { RuntimeAuthProvider, RuntimeAuthProviderConnectInput, RuntimeAuthRuntime } from "@botiverse/raft-shared";
import { CircleCheck } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages/en";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import { FIELD_MESSAGE, providerRequestFailure, providerResultFailure } from "./providerConnectFailure";
import type { ProviderFailure, ProviderField } from "./providerConnectFailure";
import Banner from "../../components/ui/Banner";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../../components/ui/NarrowDialog";
import { useComputerName } from "./useComputerName";

/**
 * Qwen Code has no sign-in: the person connects it to a model provider with
 * an API key, saved in Qwen's own settings on the Computer. The key lives in
 * the dialog's password field until it is sent, and is dropped once saved or
 * when the dialog closes; it is never shown again, logged or traced.
 */

/** Qwen's own menu groups that carry no name of their own. */
const PROVIDER_GROUP_LABEL: Record<string, MessageId> = {
  "third-party": "machine.runtimeAuth.provider.group.thirdParty",
  custom: "machine.runtimeAuth.provider.group.custom",
};
const UNGROUPED = "third-party";

type ProviderList =
  | { kind: "loading" }
  | { kind: "failed"; failure: ProviderFailure }
  | { kind: "listed"; providers: readonly RuntimeAuthProvider[] };

/**
 * Connect a provider-key runtime (Qwen Code) to a model provider: choose one
 * of the providers the Computer's Qwen offers (read from the Computer), then
 * give its API key, and its endpoint or model where it needs them. The key is
 * saved in Qwen's user settings on the Computer, for every agent of the
 * account that runs it; Qwen checks it only when an agent runs.
 */
export function RuntimeProviderConnectDialog({
  serverId,
  machineId,
  runtimeId,
  runtime,
  client,
  onClose,
}: {
  serverId: string;
  machineId: string;
  /** The Raft runtime the person picked (Qwen Code), for its name. */
  runtimeId: string;
  /** The runtime whose provider settings these are (OAR's `qwen`). */
  runtime: RuntimeAuthRuntime;
  client: RuntimeAuthClient;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const runtimeName = getRuntimeDisplayName(runtimeId);
  const computer = useComputerName(machineId) ?? formatMessage({ id: "machine.runtimeAuth.thisComputer" });
  const [list, setList] = useState<ProviderList>({ kind: "loading" });
  const [step, setStep] = useState<"choose" | "details" | "done">("choose");
  const [chosenId, setChosenId] = useState<string | null>(null);
  /** The provider the details below were entered for; another choice starts them over. */
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const [endpointId, setEndpointId] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  /** The API key, only while the form is open and unsent. Never logged, never shown back. */
  const [apiKey, setApiKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<ProviderFailure | null>(null);
  const [fieldError, setFieldError] = useState<ProviderField | null>(null);
  const promptId = useId();
  const mountedRef = useRef(false);
  const listAttemptRef = useRef(0);
  // The endpoint list opens inside the dialog's form: portalled to the page it would sit under the dialog.
  const formRef = useRef<HTMLFormElement>(null);
  const selectPortalProps = useMemo(() => ({ container: formRef }), []);

  // Read once on open and again from Try Again, never by a re-run effect
  // (StrictMode's second pass would read twice; each read starts Qwen on the Computer).
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
  const chosen = providers.find((provider) => provider.id === chosenId) ?? null;
  const groupLabel = useCallback((provider: RuntimeAuthProvider): string => {
    const id = provider.group?.id ?? UNGROUPED;
    if (provider.group?.label) return provider.group.label;
    const messageId = PROVIDER_GROUP_LABEL[id];
    return messageId ? formatMessage({ id: messageId }) : id;
  }, [formatMessage]);

  const { items, groups } = useMemo(() => {
    const groupRows = new Map<string, ChoiceListGroup>();
    const rows: ChoiceListItem[] = providers.map((provider) => {
      const group = provider.group?.id ?? UNGROUPED;
      if (!groupRows.has(group)) groupRows.set(group, { value: group, label: groupLabel(provider) });
      return {
        value: provider.id,
        label: provider.label,
        searchText: [provider.label, provider.description, groupLabel(provider)].filter(Boolean).join(" "),
        description: [
          provider.description ?? null,
          provider.configured
            ? <span key="configured" data-testid={`runtime-provider-configured-${provider.id}`}>{formatMessage({ id: "machine.runtimeAuth.provider.alreadyConfigured" })}</span>
            : null,
        ],
        group,
      };
    });
    return { items: rows, groups: [...groupRows.values()] };
  }, [formatMessage, groupLabel, providers]);

  const handleChoose = useCallback((value: string) => {
    setChosenId(value);
  }, []);

  const handleContinue = useCallback(() => {
    if (!chosen) return;
    if (detailsFor !== chosen.id) {
      setDetailsFor(chosen.id);
      setEndpointId(null);
      setBaseUrl("");
      setModel("");
      setApiKey("");
    }
    setFailure(null);
    setFieldError(null);
    setStep("details");
  }, [chosen, detailsFor]);

  const handleBack = useCallback(() => {
    setFailure(null);
    setFieldError(null);
    setStep("choose");
  }, []);

  const endpointItems = useMemo(
    () => (chosen?.endpoint.kind === "choice" ? chosen.endpoint.options.map((option) => ({ value: option.id, label: option.label })) : []),
    [chosen],
  );
  const handleEndpoint = useCallback((value: string | null) => {
    setEndpointId(value);
  }, []);
  const handleBaseUrl = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setBaseUrl(event.target.value);
    setFieldError((current) => (current === "baseUrl" ? null : current));
  }, []);
  const handleModel = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setModel(event.target.value);
    setFieldError((current) => (current === "model" ? null : current));
  }, []);
  const handleApiKey = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setApiKey(event.target.value);
    setFieldError((current) => (current === "apiKey" ? null : current));
  }, []);

  const needsEndpoint = chosen?.endpoint.kind === "choice";
  const needsBaseUrl = chosen?.endpoint.kind === "custom";
  const needsModel = chosen?.needsModelIds === true;
  const ready = chosen !== null
    && apiKey.trim() !== ""
    && (!needsEndpoint || endpointId !== null)
    && (!needsBaseUrl || baseUrl.trim() !== "")
    && (!needsModel || model.trim() !== "");

  const handleConnect = useCallback((event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!chosen || !ready || connecting) return;
    const endpoint = chosen.endpoint.kind === "choice" ? chosen.endpoint.options.find((option) => option.id === endpointId) : undefined;
    const input: RuntimeAuthProviderConnectInput = {
      providerId: chosen.id,
      apiKey: apiKey.trim(),
      ...(endpoint ? { baseUrl: endpoint.url } : {}),
      ...(chosen.endpoint.kind === "custom" ? { baseUrl: baseUrl.trim() } : {}),
      ...(chosen.needsModelIds ? { modelIds: [model.trim()] } : {}),
    };
    setConnecting(true);
    setFailure(null);
    setFieldError(null);
    client.connectProvider(serverId, machineId, runtime, input).then((result) => {
      // A save, or one that may have happened: the card reads the new status.
      if (result.kind === "connected" || (result.kind === "failed" && result.reason === "timed_out")) client.invalidate(serverId, machineId);
      if (!mountedRef.current) return;
      setConnecting(false);
      if (result.kind === "connected") {
        setApiKey("");
        setStep("done");
        return;
      }
      setFailure(providerResultFailure(result, "connect"));
    }, (error: unknown) => {
      if (!mountedRef.current) return;
      setConnecting(false);
      const refused = providerRequestFailure(error, "connect");
      if ("field" in refused) setFieldError(refused.field);
      else setFailure(refused);
    });
  }, [apiKey, baseUrl, chosen, client, connecting, endpointId, machineId, model, ready, runtime, serverId]);

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) onClose();
  }, [onClose]);

  const title = formatMessage({ id: "machine.runtimeAuth.provider.title" }, { runtime: runtimeName });
  const values = { runtime: runtimeName, computer };

  return (
    <Dialog open disablePointerDismissal onOpenChange={handleOpenChange}>
      <NarrowDialogContent
        narrow="sheet"
        layer={1}
        className="max-w-md"
        data-testid={`runtime-provider-dialog-${runtime}`}
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
            <Banner intent="success" icon={<CircleCheck size={20} aria-hidden="true" />} data-testid="runtime-provider-saved">
              {formatMessage({ id: "machine.runtimeAuth.provider.success" }, values)}
            </Banner>
          ) : list.kind === "loading" ? (
            <div className="flex items-center gap-2 text-subhead text-foreground-muted" role="status">
              <Spinner size="xs" aria-hidden="true" />
              {formatMessage({ id: "machine.runtimeAuth.provider.loading" }, { computer })}
            </div>
          ) : list.kind === "failed" ? (
            <Banner intent="warning" withIcon data-testid="runtime-provider-list-failed">
              {formatMessage({ id: list.failure.messageId }, values)}
            </Banner>
          ) : step === "choose" || !chosen ? (
            <div className="grid gap-3" data-testid="runtime-provider-choose">
              <p id={promptId} className="text-subhead text-foreground-muted">
                {formatMessage({ id: "machine.runtimeAuth.provider.choosePrompt" })}
              </p>
              <ChoiceList
                aria-labelledby={promptId}
                searchLabel={formatMessage({ id: "machine.runtimeAuth.provider.search" })}
                clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
                noMatchLabel={formatMessage({ id: "machine.runtimeAuth.provider.noMatch" })}
                empty={formatMessage({ id: "machine.runtimeAuth.provider.empty" }, values)}
                items={items}
                groups={groups}
                value={chosenId}
                onValueChange={handleChoose}
              />
            </div>
          ) : (
            <form ref={formRef} id={`${promptId}-form`} className="grid gap-4 md:pointer-fine:gap-3" onSubmit={handleConnect} noValidate data-testid="runtime-provider-details">
              <p className="text-subhead text-foreground" data-testid="runtime-provider-chosen">
                {groupLabel(chosen)} · {chosen.label}
              </p>
              {needsEndpoint ? (
                <Field>
                  <FieldLabel required>{formatMessage({ id: "machine.runtimeAuth.provider.endpointLabel" })}</FieldLabel>
                  <Select chrome="field" items={endpointItems} value={endpointId} onValueChange={handleEndpoint}>
                    <SelectTrigger className="w-full" data-testid="runtime-provider-endpoint">
                      <SelectValue placeholder={formatMessage({ id: "machine.runtimeAuth.provider.endpointPlaceholder" })} />
                      <SelectIcon />
                    </SelectTrigger>
                    <SelectContent portalProps={selectPortalProps}>
                      <SelectList>
                        {endpointItems.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            <SelectItemText>{item.label}</SelectItemText>
                            <SelectItemIndicator />
                          </SelectItem>
                        ))}
                      </SelectList>
                    </SelectContent>
                  </Select>
                  <FieldDescription>{formatMessage({ id: "machine.runtimeAuth.provider.endpointHint" })}</FieldDescription>
                </Field>
              ) : null}
              {needsBaseUrl ? (
                <Field invalid={fieldError === "baseUrl"}>
                  <FieldLabel required>{formatMessage({ id: "machine.runtimeAuth.provider.baseUrlLabel" })}</FieldLabel>
                  <Input
                    type="url"
                    value={baseUrl}
                    onChange={handleBaseUrl}
                    placeholder={chosen.endpoint.kind === "custom" ? chosen.endpoint.placeholder : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={connecting}
                    data-invalid={fieldError === "baseUrl" || undefined}
                    data-testid="runtime-provider-base-url"
                  />
                  {fieldError === "baseUrl"
                    ? <FieldError match>{formatMessage({ id: FIELD_MESSAGE.baseUrl })}</FieldError>
                    : <FieldDescription>{formatMessage({ id: "machine.runtimeAuth.provider.baseUrlHint" })}</FieldDescription>}
                </Field>
              ) : null}
              {needsModel ? (
                <Field invalid={fieldError === "model"}>
                  <FieldLabel required>{formatMessage({ id: "machine.runtimeAuth.provider.modelLabel" })}</FieldLabel>
                  <Input
                    value={model}
                    onChange={handleModel}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={connecting}
                    data-invalid={fieldError === "model" || undefined}
                    data-testid="runtime-provider-model"
                  />
                  {fieldError === "model"
                    ? <FieldError match>{formatMessage({ id: FIELD_MESSAGE.model })}</FieldError>
                    : <FieldDescription>{formatMessage({ id: "machine.runtimeAuth.provider.modelHint" })}</FieldDescription>}
                </Field>
              ) : null}
              <Field invalid={fieldError === "apiKey"}>
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
                  data-invalid={fieldError === "apiKey" || undefined}
                  className="font-mono"
                  data-testid="runtime-provider-api-key"
                />
                {fieldError === "apiKey" ? <FieldError match>{formatMessage({ id: FIELD_MESSAGE.apiKey })}</FieldError> : null}
              </Field>
              <p className="text-caption text-foreground-hint" data-testid="runtime-provider-scope">
                {formatMessage({ id: "machine.runtimeAuth.provider.scopeNote" }, values)}
              </p>
              {failure ? (
                <Banner intent="warning" withIcon data-testid="runtime-provider-failed">
                  {formatMessage({ id: failure.messageId }, values)}
                </Banner>
              ) : null}
            </form>
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
          ) : step === "details" && chosen ? (
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
                    disabled={!ready}
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
