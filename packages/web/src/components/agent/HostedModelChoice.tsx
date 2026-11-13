import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Spinner, TextLink } from "@botiverse/raft-ui";
import type { AgentRuntimeProviderKind, HostedRuntimeModelsView } from "@botiverse/raft-shared";
import api from "../../api/client";
import { RuntimeChoiceCombobox } from "./RuntimeChoiceCombobox";
import type { RuntimeOption } from "./RuntimeConfigFields";

export function hostedRuntimeModelsPath(kind: AgentRuntimeProviderKind): string {
  return `/agent-runtime-providers/${encodeURIComponent(kind)}/models`;
}

export type HostedModelsState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; view: HostedRuntimeModelsView };

/** The models a new hosted agent can start on; fetched once per mount while `enabled`. */
export function useHostedRuntimeModels(kind: AgentRuntimeProviderKind, enabled: boolean) {
  const [state, setState] = useState<HostedModelsState>({ kind: "loading" });
  const load = useCallback(async () => {
    if (!enabled) return;
    setState({ kind: "loading" });
    try {
      const { data } = await api.get<HostedRuntimeModelsView>(hostedRuntimeModelsPath(kind));
      setState({ kind: "ready", view: data });
    } catch {
      setState({ kind: "error" });
    }
  }, [kind, enabled]);
  useEffect(() => {
    void load();
  }, [load]);
  return { state, reload: load };
}

/**
 * The first pick for a new hosted agent: the provider's default (`null`), which
 * is DeepSeek Flash (tygg). No pick is sent while an administrator decides
 * (`locked`) or the server may not pick (`picker` off).
 */
export function initialHostedModel(_view: HostedRuntimeModelsView): string | null {
  return null;
}

/** Whether this server shows a model picker for hosted agents (`antiproton_model_picker`). */
export function hostedModelPickerShown(view: { picker?: boolean } | null | undefined): boolean {
  return view?.picker !== false;
}

/**
 * Picks the model a hosted agent starts on: an offered id, or `null` for the
 * provider's default, named as such. Read-only while an administrator decides
 * the model.
 */
export function HostedModelChoice({
  state,
  value,
  onChange,
  onReload,
  testId,
}: {
  state: HostedModelsState;
  value: string | null;
  onChange: (model: string | null) => void;
  onReload: () => void;
  testId: string;
}) {
  const { formatMessage } = useIntl();
  const view = state.kind === "ready" ? state.view : null;
  const options = useMemo((): RuntimeOption[] => (view?.models ?? []).map((model) => ({ value: model.id, label: model.label })), [view]);
  const defaultLabel = view?.defaultLabel
    ? formatMessage({ id: "agent.detail.hostedModel.default" }, { label: view.defaultLabel })
    : formatMessage({ id: "agent.detail.hostedModel.defaultUnnamed" });
  const emptyOption = useMemo((): RuntimeOption => ({ value: "", label: defaultLabel }), [defaultLabel]);
  const handlePick = useCallback((next: string) => onChange(next === "" ? null : next), [onChange]);

  if (state.kind === "loading") {
    return <Spinner size="xs" aria-label={formatMessage({ id: "agent.workspace.loading" })} />;
  }
  if (state.kind === "error") {
    return (
      <div className="flex flex-wrap items-baseline gap-x-1 text-footnote font-semibold text-warning-strong" data-testid={`${testId}-error`}>
        <span>{formatMessage({ id: "agent.create.hostedModel.loadFailed" })}</span>
        <TextLink variant="strong" onClick={onReload}>
          {formatMessage({ id: "agent.create.hostedModel.reload" })}
        </TextLink>
      </div>
    );
  }
  if (view!.locked) {
    return (
      <div className="stack-y-1" data-testid={`${testId}-locked`}>
        <p className="font-mono text-mono-meta text-foreground">{view!.defaultLabel ?? view!.default}</p>
        <p className="text-caption text-foreground-hint">
          {formatMessage({ id: "agent.detail.hostedModel.locked" })}
        </p>
      </div>
    );
  }
  return (
    <RuntimeChoiceCombobox
      options={options}
      value={value ?? ""}
      onValueChange={handlePick}
      emptyOption={emptyOption}
      allowCustom={false}
      placeholder={formatMessage({ id: "agent.detail.hostedModel.title" })}
      testId={testId}
    />
  );
}
