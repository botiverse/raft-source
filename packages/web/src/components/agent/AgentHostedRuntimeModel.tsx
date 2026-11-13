import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Spinner } from "@botiverse/raft-ui";
import type { HostedAgentModelView } from "@botiverse/raft-shared";
import api from "../../api/client";
import SectionEyebrow from "../ui/SectionEyebrow";
import { RuntimeChoiceCombobox } from "./RuntimeChoiceCombobox";
import type { RuntimeOption } from "./RuntimeConfigFields";
import { hostedModelPickerShown } from "./HostedModelChoice";

/** Item value of "follow the provider's default"; stored as `model: null`. */
const DEFAULT_CHOICE = "__hosted_default__";

export function hostedRuntimeModelPath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}/hosted-runtime/model`;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error" }
  | { kind: "ready"; view: HostedAgentModelView };

type Notice = "saved" | "not_offered" | "locked" | "failed" | null;

function statusOf(err: unknown): number | undefined {
  return (err as { response?: { status?: number } }).response?.status;
}

/**
 * The model of a hosted (provider-backed) agent. The provider offers a fixed
 * list and a default; a pick is stored by the provider and used from the
 * agent's next turn (no restart). While an administrator decides the model
 * (`locked`), it is shown read-only. Hidden when the agent is not hosted or
 * the caller may not see it (4xx on load).
 */
export function AgentHostedRuntimeModel({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get<HostedAgentModelView>(hostedRuntimeModelPath(agentId));
      setState({ kind: "ready", view: data });
    } catch (err) {
      const status = statusOf(err);
      // 409 = not provisioned yet: show nothing until it is.
      setState(status && status < 500 && status !== 429 ? { kind: "hidden" } : { kind: "error" });
    }
  }, [agentId]);

  useEffect(() => {
    // Keyed by agent at the call site, so the state starts as loading per agent.
    void load();
  }, [load]);

  const view = state.kind === "ready" ? state.view : null;
  const options = useMemo((): RuntimeOption[] => (view?.models ?? []).map((model) => ({ value: model.id, label: model.label })), [view]);
  const emptyOption = useMemo((): RuntimeOption | undefined => view
    ? {
        value: DEFAULT_CHOICE,
        label: view.defaultLabel
          ? formatMessage({ id: "agent.detail.hostedModel.default" }, { label: view.defaultLabel })
          : formatMessage({ id: "agent.detail.hostedModel.defaultUnnamed" }),
      }
    : undefined, [view, formatMessage]);

  const handleChange = useCallback(async (next: string) => {
    if (!view) return;
    const model = next === "" ? null : next;
    const current = view.source === "default" ? null : view.model;
    if (model === current) return;
    setSaving(true);
    setNotice(null);
    // Show the pick at once (a save takes a few seconds); roll back if it is refused.
    const picked = model === null ? null : view.models.find((option) => option.id === model);
    setState({
      kind: "ready",
      view: model === null
        ? { ...view, model: view.default, label: view.defaultLabel, source: "default" }
        : { ...view, model, label: picked?.label ?? model, source: "chosen" },
    });
    try {
      const { data } = await api.put<HostedAgentModelView>(hostedRuntimeModelPath(agentId), { model });
      setState({ kind: "ready", view: data });
      setNotice("saved");
    } catch (err) {
      const status = statusOf(err);
      setState({ kind: "ready", view });
      setNotice(status === 422 ? "not_offered" : status === 409 ? "locked" : "failed");
      // The list or the lock changed under us: show what the provider has now.
      if (status === 422 || status === 409) await load();
    } finally {
      setSaving(false);
    }
  }, [agentId, view, load]);

  const handlePick = useCallback((next: string) => { void handleChange(next); }, [handleChange]);

  // Where the server may not pick (`antiproton_model_picker` off), Raft decides: no picker at all.
  if (state.kind === "hidden" || (state.kind === "ready" && !hostedModelPickerShown(view))) return null;
  return (
    <div className="border-t border-line-hairline px-(--surface-inset) py-4" data-testid="agent-hosted-runtime-model">
      <SectionEyebrow as="div" className="mb-2">
        {formatMessage({ id: "agent.detail.hostedModel.title" })}
      </SectionEyebrow>
      {state.kind === "loading" ? (
        <Spinner size="xs" aria-label={formatMessage({ id: "agent.workspace.loading" })} />
      ) : state.kind === "error" ? (
        <p className="text-footnote font-semibold text-warning-strong">
          {formatMessage({ id: "agent.detail.hostedModel.loadFailed" })}
        </p>
      ) : view!.locked ? (
        <div className="stack-y-1" data-testid="agent-hosted-runtime-model-locked">
          <p className={view!.label ? "text-callout text-foreground" : "break-all font-mono text-mono-meta text-foreground"}>{view!.label ?? view!.model}</p>
          <p className="text-caption text-foreground-hint">
            {formatMessage({ id: "agent.detail.hostedModel.locked" })}
          </p>
        </div>
      ) : (
        <div className="stack-y-1.5">
          <RuntimeChoiceCombobox
            options={options}
            value={view!.source === "default" ? "" : view!.model ?? ""}
            onValueChange={handlePick}
            emptyOption={emptyOption}
            allowCustom={false}
            placeholder={formatMessage({ id: "agent.detail.hostedModel.title" })}
            testId="agent-hosted-runtime-model-select"
          />
          {view!.source === "admin" && (
            <p className="text-caption text-foreground-hint">
              {formatMessage({ id: "agent.detail.hostedModel.adminDefault" })}
            </p>
          )}
          <p className={!saving && (notice === "failed" || notice === "not_offered") ? "text-caption font-semibold text-warning-strong" : "text-caption text-foreground-hint"} aria-live="polite" data-testid="agent-hosted-runtime-model-notice">
            {saving
              ? formatMessage({ id: "agent.detail.hostedModel.saving" })
              : notice === "saved"
                ? formatMessage({ id: "agent.detail.hostedModel.saved" })
                : notice === "not_offered"
                  ? formatMessage({ id: "agent.detail.hostedModel.notOffered" })
                  : notice === "locked"
                    ? formatMessage({ id: "agent.detail.hostedModel.lockedOnSave" })
                    : notice === "failed"
                      ? formatMessage({ id: "agent.detail.hostedModel.saveFailed" })
                      : formatMessage({ id: "agent.detail.hostedModel.hint" })}
          </p>
        </div>
      )}
    </div>
  );
}
