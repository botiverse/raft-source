// Create an external agent in one dialog (#wg-external-agent-ux:#2; design: Jasper's boards
// KzecuXzrKN6xHUQ4E6YKtM, approved by cindyz). Step 1: name, description and how it will run
// (an existing agent through the Raft CLI, or a program of your own with the SDK). Next makes the
// agent and its one agent credential, and step 2 shows how to connect it while it waits for the
// first sign-in. Both ways use the same credential (raft-design terminology.md); switching only
// changes the instructions. Cancel before it connects discards the agent and its credential.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import { Bot, Code } from "lucide-react";
import { Button, Input, SegmentedControl, SegmentedControlItem, Textarea, TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import api from "../../api/client";
import { AVATAR_KEYS } from "../../components/agent/PixelAvatar";
import { isSecondFactorStepUpCancelled, withSecondFactorStepUp } from "../../components/settings/secondFactorStepUp";
import DialogCard from "../../components/ui/DialogCard";
import FormField from "../../components/ui/FormField";
import { DialogCancel, DialogCardFooter, DialogCommit } from "../../components/ui/NarrowDialog";
import StatusDot from "../../components/ui/StatusDot";
import { opensInNewTabAriaLabel } from "../../components/ui/LeavingRaftMark";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useAgentStore } from "../../store/agentStore";
import { existingAgentPrompt, PAGE_CREDENTIAL_NAME, RAFT_SDK_DOCS_URL, SDK_INSTALL_COMMAND, sdkStarterCode, STATUS_POLL_MS } from "./externalAgentSetup";
import type { Created, ExternalSetupMethod } from "./externalAgentSetup";
import { CopyBlock, CopyField } from "./ExternalSetupCopy";

export function CreateExternalAgentDialog({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const createAgent = useAgentStore((s) => s.createAgent);
  const deleteAgent = useAgentStore((s) => s.deleteAgent);
  const fetchExternalAgentStatus = useAgentStore((s) => s.fetchExternalAgentStatus);
  const nameId = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [method, setMethod] = useState<ExternalSetupMethod>("existing_agent");
  const [created, setCreated] = useState<Created | null>(null);
  const [credential, setCredential] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const discarded = useRef(false);

  // Step 2 asks until the agent signs in (any of its credentials used: GET /agents/:id/external-status).
  useEffect(() => {
    if (!created || connected) return undefined;
    let active = true;
    const tick = async () => {
      try {
        const status = await fetchExternalAgentStatus(created.id);
        if (active && status.setupState === "connected") setConnected(true);
      } catch {
        // A missed poll is retried on the next tick.
      }
    };
    const timer = setInterval(() => void tick(), STATUS_POLL_MS);
    void tick();
    return () => { active = false; clearInterval(timer); };
  }, [created, connected, fetchExternalAgentStatus]);

  const saveMethod = useCallback(async (agentId: string, next: ExternalSetupMethod) => {
    await api.put(`/agents/${encodeURIComponent(agentId)}/external-setup-method`, { method: next });
  }, []);

  const handleNext = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    let agent: Created | null = null;
    try {
      const avatarKey = AVATAR_KEYS[Math.floor(Math.random() * AVATAR_KEYS.length)];
      const made = await createAgent(name.trim(), { description: description.trim() || undefined, avatarUrl: `pixel:${avatarKey}`, external: true });
      agent = { id: made.id, name: made.name };
      await saveMethod(agent.id, method);
      // Two-step verification on: "Verify it's you" first, then the same request once more.
      const { data } = await withSecondFactorStepUp(() => api.post(`/agents/${encodeURIComponent(agent!.id)}/credentials`, { name: PAGE_CREDENTIAL_NAME }), "agentKey");
      if (typeof data?.apiKey !== "string" || !data.apiKey.startsWith("sk_agent_")) throw new Error("Invalid credential response");
      setCreated(agent);
      setCredential(data.apiKey);
    } catch (err) {
      // Nothing is left behind: an agent made before the failure is discarded (cindyz: Cancel leaves nothing).
      if (agent) await deleteAgent(agent.id).catch(() => undefined);
      if (!isSecondFactorStepUpCancelled(err)) {
        const body = (err as { response?: { data?: { error?: string } } }).response?.data;
        setError(body?.error ?? formatMessage({ id: "agent.createExternal.createFailed" }));
      }
    } finally {
      setBusy(false);
    }
  }, [busy, createAgent, deleteAgent, description, formatMessage, method, name, saveMethod]);

  const handleSwitch = useCallback(() => {
    if (!created) return;
    const next: ExternalSetupMethod = method === "sdk" ? "existing_agent" : "sdk";
    setMethod(next);
    // The same credential works both ways: only the instructions and the remembered method change.
    void saveMethod(created.id, next).catch(() => undefined);
  }, [created, method, saveMethod]);

  const finish = useCallback(() => {
    if (created) {
      try {
        nav.toAgent(created.id);
      } catch {
        // stay where the person is
      }
    }
    onClose();
  }, [created, nav, onClose]);

  const handleClose = useCallback(() => {
    // Once made, closing before it connects asks first; connected, closing is Done.
    if (created && !connected) setConfirmDiscard(true);
    else if (created) finish();
    else onClose();
  }, [connected, created, finish, onClose]);

  const handleSubmit = useCallback((event: FormEvent) => void handleNext(event), [handleNext]);
  const handleName = useCallback((event: ChangeEvent<HTMLInputElement>) => setName(event.target.value), []);
  const handleDescription = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value), []);
  const handleMethod = useCallback((value: unknown) => setMethod(value as ExternalSetupMethod), []);
  const handleAskDiscard = useCallback(() => setConfirmDiscard(true), []);
  const handleKeep = useCallback(() => setConfirmDiscard(false), []);

  const handleDiscard = useCallback(async () => {
    if (!created || discarded.current) return;
    discarded.current = true;
    setBusy(true);
    try {
      await deleteAgent(created.id);
      onClose();
    } catch {
      discarded.current = false;
      setError(formatMessage({ id: "agent.createExternal.discardFailed" }));
      setConfirmDiscard(false);
    } finally {
      setBusy(false);
    }
  }, [created, deleteAgent, formatMessage, onClose]);
  const handleDiscardClick = useCallback(() => void handleDiscard(), [handleDiscard]);

  if (!created) {
    return (
      <DialogCard title={formatMessage({ id: "agent.createExternal.title" })} onClose={onClose} narrow="sheet" testId="create-external-agent-dialog">
        <form onSubmit={handleSubmit} className="stack-y-4 md:pointer-fine:stack-y-3">
          {error ? <p className="text-callout text-danger" role="alert" data-testid="create-external-agent-error">{error}</p> : null}
          <FormField label={formatMessage({ id: "agent.createExternal.name" })} htmlFor={nameId}>
            <Input id={nameId} value={name} onChange={handleName} autoFocus data-testid="create-external-agent-name" />
          </FormField>
          <FormField label={formatMessage({ id: "agent.createExternal.description" })} optional>
            <Textarea value={description} onChange={handleDescription} placeholder={formatMessage({ id: "agent.createExternal.descriptionPlaceholder" })} />
          </FormField>
          <FormField label={formatMessage({ id: "agent.createExternal.howItRuns" })}>
            <div className="stack-y-2">
              <SegmentedControl value={method} onValueChange={handleMethod} aria-label={formatMessage({ id: "agent.createExternal.howItRuns" })}>
                <SegmentedControlItem value="existing_agent" data-testid="create-external-agent-existing"><Bot aria-hidden="true" />{formatMessage({ id: "agent.createExternal.existing" })}</SegmentedControlItem>
                <SegmentedControlItem value="sdk" data-testid="create-external-agent-sdk"><Code aria-hidden="true" />{formatMessage({ id: "agent.createExternal.sdk" })}</SegmentedControlItem>
              </SegmentedControl>
              <p className="text-callout text-foreground-muted">
                {formatMessage({ id: method === "sdk" ? "agent.createExternal.sdkHint" : "agent.createExternal.existingHint" })}
              </p>
            </div>
          </FormField>
          <DialogCardFooter>
            <Button size="lg" variant="ghost" type="button" onClick={onClose}>{formatMessage({ id: "common.confirm.cancel" })}</Button>
            <DialogCommit>
              {(inHead) => (
                <Button size={inHead ? "md" : "lg"} variant="primary" type="submit" disabled={!name.trim()} loading={busy} data-testid="create-external-agent-next">
                  {formatMessage({ id: "agent.createExternal.next" })}
                </Button>
              )}
            </DialogCommit>
          </DialogCardFooter>
        </form>
      </DialogCard>
    );
  }

  if (confirmDiscard) {
    return (
      <DialogCard title={formatMessage({ id: "agent.createExternal.discardTitle" }, { name: created.name })} onClose={handleKeep} testId="create-external-agent-discard">
        <div className="stack-y-4">
          <p className="text-callout text-foreground-muted">{formatMessage({ id: "agent.createExternal.discardBody" })}</p>
          <DialogCardFooter>
          <Button size="lg" variant="ghost" type="button" onClick={handleKeep}>{formatMessage({ id: "agent.createExternal.keep" })}</Button>
          <Button size="lg" variant="danger" type="button" loading={busy} onClick={handleDiscardClick} data-testid="create-external-agent-discard-confirm">
            {formatMessage({ id: "agent.createExternal.discard" })}
          </Button>
          </DialogCardFooter>
        </div>
      </DialogCard>
    );
  }

  return (
    <DialogCard title={formatMessage({ id: "agent.createExternal.setupTitle" }, { name: created.name })} onClose={handleClose} narrow="sheet" maxWidthClass="max-w-2xl" testId="create-external-agent-setup">
      <div className="stack-y-4">
        {error ? <p className="text-callout text-danger" role="alert">{error}</p> : null}
        <div className="flex items-start gap-3 rounded-control border border-line px-4 py-3" data-testid="create-external-agent-status" data-connected={connected ? "" : undefined}>
          {/* Waiting needs someone to act: orange, as every "needs action" state (raft-design status.md; cyan is another server's agent). */}
          <StatusDot presence={connected ? "online" : "error"} className="mt-1.5" />
          <div className="min-w-0">
            <p className="text-body font-semibold text-foreground">
              {formatMessage({ id: connected ? "agent.createExternal.online" : "agent.createExternal.waiting" }, { name: created.name })}
            </p>
            <p className="text-callout text-foreground-muted">
              {formatMessage({ id: connected ? "agent.createExternal.onlineHint" : "agent.createExternal.waitingHint" }, { name: created.name })}
            </p>
          </div>
        </div>
        {connected ? null : (
          <>
            <TextLink className="self-start text-callout" render={<button type="button" onClick={handleSwitch} />} data-testid="create-external-agent-switch">
              {formatMessage({ id: method === "sdk" ? "agent.createExternal.switchToExisting" : "agent.createExternal.switchToSdk" })}
            </TextLink>
            {method === "existing_agent" ? (
              <div className="stack-y-4" data-testid="create-external-agent-existing-steps">
                <section className="stack-y-2">
                  <h3 className="text-body font-semibold">{formatMessage({ id: "agent.createExternal.step1Existing" })}</h3>
                  <CopyBlock text={existingAgentPrompt(created, formatMessage)} label={formatMessage({ id: "agent.createExternal.copyPrompt" })} testId="create-external-agent-prompt" primary collapsed />
                </section>
                <section className="stack-y-2">
                  <h3 className="text-body font-semibold">{formatMessage({ id: "agent.createExternal.step2Existing" })}</h3>
                  <p className="text-callout text-foreground-muted">{formatMessage({ id: "agent.createExternal.credentialWarning" }, { name: created.name })}</p>
                  <CopyField text={credential ?? ""} testId="create-external-agent-credential" />
                  <p className="text-footnote text-foreground-muted">{formatMessage({ id: "agent.createExternal.shownOnce" })}</p>
                </section>
              </div>
            ) : (
              <div className="stack-y-4" data-testid="create-external-agent-sdk-steps">
                <section className="stack-y-2">
                  <h3 className="text-body font-semibold">{formatMessage({ id: "agent.createExternal.step1Sdk" })}</h3>
                  <p className="text-callout text-foreground-muted">{formatMessage({ id: "agent.createExternal.credentialWarning" }, { name: created.name })}</p>
                  <CopyField text={credential ?? ""} testId="create-external-agent-credential" />
                  <p className="text-footnote text-foreground-muted">{formatMessage({ id: "agent.createExternal.envHint" })}</p>
                </section>
                <section className="stack-y-2">
                  <h3 className="text-body font-semibold">{formatMessage({ id: "agent.createExternal.step2Sdk" })}</h3>
                  <CopyField text={SDK_INSTALL_COMMAND} testId="create-external-agent-install" />
                  <CopyField text={sdkStarterCode()} testId="create-external-agent-code" />
                  <p className="text-callout text-foreground-muted">
                    {formatMessage({ id: "agent.createExternal.sdkConnectsHint" }, { name: created.name })}
                    <TextLink variant="strong" className="ml-1" render={<a href={RAFT_SDK_DOCS_URL} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, formatMessage({ id: "agent.createExternal.sdkGuide" }))} />}>
                      {formatMessage({ id: "agent.createExternal.sdkGuide" })}
                      <TextLinkExternalIcon />
                    </TextLink>
                  </p>
                </section>
              </div>
            )}
          </>
        )}
        <DialogCardFooter>
          {connected ? null : (
            <>
              <p className="mr-auto self-center text-callout text-foreground-muted">{formatMessage({ id: "agent.createExternal.finishLater" })}</p>
              {/* On a phone the sheet's × is the way out (DialogCancel); Done moves into its head (DialogCommit). */}
              <DialogCancel>
                <Button size="lg" variant="ghost" type="button" onClick={handleAskDiscard} data-testid="create-external-agent-cancel">{formatMessage({ id: "common.confirm.cancel" })}</Button>
              </DialogCancel>
            </>
          )}
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"} variant={connected ? "primary" : "outline"} type="button" onClick={finish} data-testid="create-external-agent-done">
                {formatMessage({ id: "agent.createExternal.done" })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      </div>
    </DialogCard>
  );
}

