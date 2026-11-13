import { Button, Card, CardDescription, CardHeader, CardLeading, CardTitle, Checkbox, Input } from "@botiverse/raft-ui";
import { Pencil, RefreshCw } from "lucide-react";
import { useCallback, useId, useMemo } from "react";
import type { ChangeEvent, RefObject } from "react";
import {
  isRuntimeFormV2FieldRequired,
  runtimeFormV2Choices,
  runtimeFormV2SelectedConnection,
  runtimeFormV2SourceStatus,
  runtimeFormV2UnavailableSelection,
} from "@botiverse/raft-runtime-form";
import type { RuntimeFormV2ChoiceOption, RuntimeFormV2Field, RuntimeFormV2Sources, RuntimeFormV2Value, RuntimeFormV2Values } from "@botiverse/raft-runtime-form";
import { useIntl } from "react-intl";
import { Field, FieldAction, RuntimeFormV2StringMapField, RuntimeSelectControl } from "./RuntimeConfigFields";
import Tooltip from "../ui/Tooltip";
import { RuntimeFormV2ChoiceCombobox } from "./RuntimeChoiceCombobox";
import type { RuntimeOption } from "./RuntimeConfigFields";
import { RuntimeFormV2SourceStatusLine } from "./RuntimeFormV2SourceStatusLine";
import { RuntimeFormV2HintText } from "./RuntimeFormV2HintText";

const RUNTIME_FORM_V2_EMPTY_CHOICE = "__runtime_form_v2_default__";

const NO_RUNTIME_OPTIONS: RuntimeOption[] = [];

const EMPTY_STRING_MAP: Record<string, string> = {};

/** One protocol v2 field, rendered by its kind. */
export function RuntimeFormV2FieldControl({
  field,
  sources,
  values,
  onChange,
  error,
  editing,
  portalContainer,
  onRetrySource,
  retryingSourceIds,
  connectionActive = false,
  managedPlaceholder,
  savedConnections,
}: {
  field: RuntimeFormV2Field;
  sources: RuntimeFormV2Sources;
  values: RuntimeFormV2Values;
  onChange: (key: string, value: RuntimeFormV2Value) => void;
  error: string | undefined;
  editing: boolean;
  portalContainer?: RefObject<HTMLElement | null>;
  onRetrySource?: (sourceId: string) => void;
  retryingSourceIds: readonly string[];
  /** `provider.saved_connection`: some field currently holds a saved-connection selection. */
  connectionActive?: boolean;
  /** Placeholder for connection-owned fields ("Provided by …"); parent-computed. */
  managedPlaceholder?: string;
  /** Pencil action for the selected saved connection; present only for authorized operators. */
  savedConnections?: { onEdit: (connectionId: string) => void };
}) {
  const { formatMessage } = useIntl();
  const fieldKey = field.key;
  const choices = useMemo(() => runtimeFormV2Choices(field, sources, values), [field, sources, values]);
  const value = values[fieldKey];
  const text = typeof value === "string" ? value : "";
  const secretKept = editing && field.kind === "secret";
  // Saved provider connections: a field the selected connection owns is the
  // connection's, not the user's — disabled, safe placeholder, never required
  // (and never submitted; the shared runtimeFormV2Submission rules drop it).
  const connectionOwnedNow = connectionActive && field.connectionOwned === true;
  // v3 keeps a bound connection that is not selectable in unavailableOptions:
  // its pencil still opens it (to enable it or add the credential).
  const fieldConnection = runtimeFormV2SelectedConnection(field, sources, values)
    ?? runtimeFormV2UnavailableSelection(field, sources, values);
  const connectionId = typeof fieldConnection?.connectionId === "string" && fieldConnection.connectionId
    ? fieldConnection.connectionId
    : undefined;
  const savedGroupLabel = formatMessage({ id: "agent.runtimeConfig.savedProviders" });
  const directGroupLabel = formatMessage({ id: "agent.runtimeConfig.directProviders" });
  const toRuntimeOptionV2 = useCallback((option: RuntimeFormV2ChoiceOption): RuntimeOption => ({
    value: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.unavailable === true ? { disabled: true } : {}),
    ...(option.group === "saved"
      ? { group: savedGroupLabel }
      : option.group === "direct"
        ? { group: directGroupLabel }
        : {}),
  }), [savedGroupLabel, directGroupLabel]);
  const handleEditConnection = useCallback(() => {
    if (connectionId && savedConnections) savedConnections.onEdit(connectionId);
  }, [connectionId, savedConnections]);
  const pencilLabel = formatMessage({ id: "agent.runtimeConfig.editSavedProvider" });
  // Every field bound to an option source (the Computer's models, the
  // server's saved provider connections) gets a refresh action: it
  // re-requests the source with `?refresh=1`; for a Computer-reported list
  // that also bypasses the Computer's model-list cache. The copy names no
  // origin, since the list may come from either. A
  // non-live source with a retryable status already shows "Retry" below the
  // control, so the header action would only repeat it.
  const sourceId = field.kind !== "derived_select" ? field.optionSourceId : undefined;
  const sourceStatus = runtimeFormV2SourceStatus(field, sources);
  const refreshing = sourceId !== undefined && retryingSourceIds.includes(sourceId);
  const showRefresh = sourceId !== undefined && onRetrySource !== undefined && !(sourceStatus?.retryable === true);
  const handleRefreshSource = useCallback(() => {
    if (sourceId) onRetrySource?.(sourceId);
  }, [onRetrySource, sourceId]);
  const refreshTitle = formatMessage({ id: "agent.runtimeFormV2.refreshSourceTitle" });
  const refreshLabel = formatMessage({ id: "agent.runtimeFormV2.refreshSourceAria" });
  // Server hint copy may carry inline Markdown links (https only).
  const fieldHint = useMemo(() => (field.hint ? <RuntimeFormV2HintText hint={field.hint} /> : undefined), [field.hint]);
  const hint = connectionOwnedNow
    ? managedPlaceholder
    : secretKept ? formatMessage({ id: "agent.runtimeFormV2.secretKept" }) : fieldHint;
  const required = isRuntimeFormV2FieldRequired(field, values) && !secretKept && !connectionOwnedNow;
  const common = useMemo(
    () => ({
      label: field.label,
      hint,
      required,
      error,
      ...((connectionId && savedConnections) || showRefresh
        ? {
            // The refresh action for a source-bound list, and the pencil action
            // for the selected saved connection (authorized operators only);
            // built inside the memo so their identity is stable.
            labelAccessory: (
              <>
                {showRefresh ? (
                  <Tooltip content={refreshTitle}>
                    <FieldAction
                      tone="icon"
                      type="button"
                      onClick={handleRefreshSource}
                      disabled={refreshing}
                      aria-label={refreshLabel}
                      data-testid={`runtime-form-v2-refresh-source-${fieldKey}`}
                    >
                      <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
                    </FieldAction>
                  </Tooltip>
                ) : null}
                {connectionId && savedConnections ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-md"
                    onClick={handleEditConnection}
                    aria-label={pencilLabel}
                    title={pencilLabel}
                    data-testid={`runtime-form-v2-edit-provider-connection-${fieldKey}`}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </Button>
                ) : null}
              </>
            ),
          }
        : {}),
    }),
    [connectionId, savedConnections, handleEditConnection, pencilLabel, showRefresh, refreshTitle, handleRefreshSource, refreshing, refreshLabel, fieldKey, field.label, hint, required, error],
  );
  // `OptionSource.unavailableOptions`: models this Computer's runtime listed as
  // disabled (and, on v3, saved connections that are not selectable), a
  // disabled group after the list: by `group` when the server sends one, else
  // "Not available on this computer". The reason is plain text.
  const unavailableSource = field.kind !== "derived_select" && field.optionSourceId ? sources[field.optionSourceId]?.unavailableOptions : undefined;
  const unavailableOptions = useMemo((): RuntimeOption[] => {
    if (!Array.isArray(unavailableSource)) return NO_RUNTIME_OPTIONS;
    const group = formatMessage({ id: "agent.runtimeModels.unavailableGroup" });
    return unavailableSource
      .filter((option) => typeof option?.value === "string" && option.value !== "")
      .map((option) => ({
        value: option.value,
        label: typeof option.label === "string" && option.label ? option.label : option.value,
        disabled: true,
        group: option.group === "saved" ? savedGroupLabel : option.group === "direct" ? directGroupLabel : group,
        ...(typeof option.reason === "string" && option.reason ? { description: option.reason } : {}),
      }));
  }, [unavailableSource, formatMessage, savedGroupLabel, directGroupLabel]);
  const listedOptions = useMemo(
    () => (choices?.kind === "select" ? choices.options.map(toRuntimeOptionV2) : NO_RUNTIME_OPTIONS),
    [choices, toRuntimeOptionV2],
  );
  const selectOptions = useMemo((): RuntimeOption[] => (choices?.kind === "select"
    ? [
        ...(choices.allowEmpty ? [{ value: RUNTIME_FORM_V2_EMPTY_CHOICE, label: formatMessage({ id: "agent.runtimeConfig.default" }) }] : []),
        ...listedOptions,
        ...(text && !choices.options.some((option) => option.value === text) ? [{ value: text, label: text, disabled: true }] : []),
      ]
    : NO_RUNTIME_OPTIONS), [choices, listedOptions, text, formatMessage]);
  const emptyOption = useMemo(
    (): RuntimeOption => ({ value: RUNTIME_FORM_V2_EMPTY_CHOICE, label: formatMessage({ id: "agent.runtimeConfig.default" }) }),
    [formatMessage],
  );
  const handleValueChange = useCallback(
    (next: RuntimeFormV2Value) => onChange(fieldKey, next),
    [onChange, fieldKey],
  );
  const handleCheckedChange = useCallback(
    (checked: boolean) => onChange(fieldKey, checked === true),
    [onChange, fieldKey],
  );
  const handleSelectChange = useCallback(
    (next: string) => onChange(fieldKey, next === RUNTIME_FORM_V2_EMPTY_CHOICE ? "" : next),
    [onChange, fieldKey],
  );
  const handleInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(fieldKey, event.target.value),
    [onChange, fieldKey],
  );
  const testId = `runtime-form-v2-${fieldKey}`;
  // A boolean's field has no label of its own: point the checkbox at the
  // option card's title so it is announced by the option's name
  // (runtimeChoiceCards.behavior.test.tsx (removed in the 2026-11 web DOM test prune)).
  const optionTitleId = useId();
  switch (field.kind) {
    case "unsupported":
      return required ? (
        <Field {...common} adopt={false}>
          <p className="text-callout text-foreground-muted" data-testid={testId}>
            {formatMessage({ id: "agent.runtimeFormV2.updateToEdit" })}
          </p>
        </Field>
      ) : null;
    case "boolean":
      return (
        <Field {...common} label={undefined} adopt={false}>
          <Card variant="option" render={<label />}>
            <CardHeader>
              <CardLeading>
                <Checkbox checked={value === true} disabled={connectionOwnedNow} onCheckedChange={handleCheckedChange} aria-labelledby={optionTitleId} data-testid={testId} />
              </CardLeading>
              <CardTitle id={optionTitleId}>{field.label}</CardTitle>
              {fieldHint && <CardDescription>{fieldHint}</CardDescription>}
            </CardHeader>
          </Card>
        </Field>
      );
    case "string_map":
      return (
        <RuntimeFormV2StringMapField
          value={value && typeof value === "object" ? value : EMPTY_STRING_MAP}
          hint={fieldHint}
          onChange={handleValueChange}
        />
      );
    default: {
      const status = sourceStatus;
      const statusLine = status && field.optionSourceId ? (
        <RuntimeFormV2SourceStatusLine
          status={status}
          sourceId={field.optionSourceId}
          testId={testId}
          onRetrySource={onRetrySource}
          retrying={retryingSourceIds.includes(field.optionSourceId)}
        />
      ) : null;
      if (choices?.kind === "select") {
        // A derived list with nothing to offer (e.g. a model without an effort menu) is not shown.
        if (field.kind === "derived_select" && choices.options.length === 0) return null;
        // A list the Computer reports (models) can be long: search it. A custom
        // value field types into the same box. Short fixed lists stay a select.
        if (choices.allowCustom || (field.optionSourceId && field.kind !== "derived_select")) {
          return (
            <RuntimeFormV2ChoiceCombobox
              common={common}
              options={listedOptions}
              value={text}
              onValueChange={handleValueChange}
              emptyOption={choices.allowEmpty ? emptyOption : undefined}
              unavailableOptions={unavailableOptions}
              allowCustom={choices.allowCustom}
              placeholder={field.placeholder ?? field.label}
              portalContainer={portalContainer}
              testId={testId}
              belowControl={statusLine}
            />
          );
        }
        return (
          <Field {...common} belowControl={statusLine}>
            <RuntimeSelectControl
              value={text || (choices.allowEmpty ? RUNTIME_FORM_V2_EMPTY_CHOICE : "")}
              onValueChange={handleSelectChange}
              options={selectOptions}
              placeholder={field.placeholder ?? field.label}
              portalContainer={portalContainer}
              testId={testId}
            />
          </Field>
        );
      }
      return (
        <Field {...common}>
          <Input
            type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"}
            value={connectionOwnedNow ? "" : text}
            onChange={handleInputChange}
            placeholder={connectionOwnedNow ? managedPlaceholder : field.placeholder}
            autoComplete={field.kind === "secret" ? "off" : undefined}
            disabled={connectionOwnedNow}
            data-testid={testId}
          />
        </Field>
      );
    }
  }
}
