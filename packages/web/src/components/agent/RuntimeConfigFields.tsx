import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import type { RefObject, ReactNode } from "react";
import { Fragment, useCallback, useMemo, useState } from "react";
import {
  isRuntimeFormV2FieldVisible,
  runtimeFormV2AdvancedStartsOpen,
  runtimeFormV2ConnectionActive,
  runtimeFormV2SelectedConnection,
  runtimeFormV2UnavailableSelection,
  validateRuntimeFormV2,
} from "@botiverse/raft-runtime-form";
import type {
  ParsedRuntimeFormV2,
  RuntimeFormV2Field,
  RuntimeFormV2Sources,
  RuntimeFormV2Value,
  RuntimeFormV2Values,
} from "@botiverse/raft-runtime-form";
import type { RuntimeFormV2State } from "../../hooks/useRuntimeFormV2";
import { useIntl } from "react-intl";
import ExperimentalBadge from "../ui/ExperimentalBadge";
import type { ProviderConnectionSummary } from "@botiverse/raft-shared";
import { Button, Select, SelectActionItem, SelectContent, SelectGroup, SelectGroupLabel, SelectIcon, SelectItem, SelectItemDescription, SelectItemIndicator, SelectItemText, SelectList, SelectSeparator, SelectTrigger, SelectValue, TextLink } from "@botiverse/raft-ui";
import StableField from "./StableField";
import Banner from "../ui/Banner";
import SectionEyebrow from "../ui/SectionEyebrow";
import { KeyValueAddButton } from "../ui/KeyValueInput";
import Tooltip from "../ui/Tooltip";
import { RuntimeEnvVarRow } from "./RuntimeEnvVarRow";
import { RuntimeFormV2FieldControl } from "./RuntimeFormV2FieldControl";

/** Stable fallbacks for optional props, so a defaulted prop keeps one identity
 *  across renders instead of a fresh `[]` each time. */
const NO_PROVIDER_CONNECTIONS: readonly ProviderConnectionSummary[] = [];
const NO_SOURCE_IDS: readonly string[] = [];

/**
 * Field-level action (rescan / retry).
 *
 * raft-ui owns the whole appearance: `icon` is the ghost 32px icon button that
 * sits in a field's label row, `link` is a TextLink inside a status sentence,
 * so `strong`. `className` is deliberately not accepted, so no callsite style
 * lands on top of either.
 */
export function FieldAction({ tone, children, ...props }: {
  tone: "icon" | "link";
  children: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "className">) {
  return tone === "icon"
    ? <Button variant="ghost" size="icon-md" className="ml-auto" {...props}>{children}</Button>
    : <TextLink variant="strong" {...props}>{children}</TextLink>;
}

/** Every field in this form is a reserved-row field (StableField). */
export const Field = StableField;

export interface RuntimeOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Optional visible group label. Contiguous groups preserve caller order. */
  group?: string;
  /** Optional secondary line (e.g. per-effort reasoning-level description). */
  description?: string;
  /** raft-ui's Experimental badge after the label, in the list and in the trigger. */
  experimental?: boolean;
  /** What this computer lacks for it (" (not installed)"), after the label and
   *  any badge. Always in the closed field; in the list unless
   *  `availabilitySuffixInList` is false (its group heading says it). */
  availabilitySuffix?: string;
  availabilitySuffixInList?: boolean;
}

function commitRuntimeSelectValue(
  options: readonly RuntimeOption[],
  nextValue: string | null,
  onValueChange: (value: string) => void,
) {
  if (nextValue == null) return;
  const nextOption = options.find((option) => option.value === nextValue);
  if (!nextOption || nextOption.disabled) return;
  onValueChange(nextValue);
}

/** Test-only alias for the guard used by the real Select callback. A disabled
 *  item is normally unreachable through pointer/keyboard input, but the write
 *  boundary must also reject a value injected below that visual layer. */
export { commitRuntimeSelectValue as commitRuntimeSelectValueForTest };

/** A second line that only repeats the label in another case (GPT-6-Astra /
 *  gpt-6-astra) adds nothing but height: show it only when it says more. */
function addsToLabel(label: string, description: string | undefined): description is string {
  return Boolean(description) && description!.toLowerCase() !== label.toLowerCase();
}

/** An option's label: the name, the Experimental badge when it has one, then
 *  what this computer lacks for it. The space keeps "Qoder Experimental" two
 *  words in the accessible name and is the gap you see; one inline span holds
 *  them, because the closed field's trigger is a flex row, which drops a
 *  whitespace-only text node between its items (the name and badge touched).
 *  `inList` drops a suffix the group heading already says; the closed field
 *  has no heading, so it keeps it. */
function runtimeOptionLabel(option: RuntimeOption, inList: boolean): ReactNode {
  const suffix = inList && option.availabilitySuffixInList === false ? "" : option.availabilitySuffix ?? "";
  if (!option.experimental) return option.label + suffix;
  return <span data-slot="runtime-option-label">{option.label}{" "}<ExperimentalBadge />{suffix}</span>;
}

function renderSelectOption(option: RuntimeOption) {
  return (
    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
      <SelectItemText>{runtimeOptionLabel(option, true)}</SelectItemText>
      {addsToLabel(option.label, option.description) ? (
        <SelectItemDescription>{option.description}</SelectItemDescription>
      ) : null}
      <SelectItemIndicator />
    </SelectItem>
  );
}

function renderSelectItems(options: readonly RuntimeOption[]) {
  if (!options.some((option) => option.group)) {
    return options.map(renderSelectOption);
  }
  const groups: Array<{ label: string; options: RuntimeOption[] }> = [];
  for (const option of options) {
    const label = option.group ?? "";
    const tail = groups.at(-1);
    if (!tail || tail.label !== label) groups.push({ label, options: [option] });
    else tail.options.push(option);
  }
  // A separator goes between groups, not under a heading (Raft DS Select).
  return groups.map((group, index) => (
    <Fragment key={group.label || `ungrouped-${index}`}>
      {index > 0 ? <SelectSeparator /> : null}
      {group.label ? (
        <SelectGroup>
          <SelectGroupLabel>{group.label}</SelectGroupLabel>
          {group.options.map(renderSelectOption)}
        </SelectGroup>
      ) : group.options.map(renderSelectOption)}
    </Fragment>
  ));
}

/** A row at the end of a runtime select's list that changes what the list
 *  shows (Show All Supported / Show Installed Only). It is not a value. */
export interface RuntimeSelectListAction {
  /** Says what pressing it does: Show All Supported, or Show Installed Only. */
  label: string;
  onToggle: () => void;
}

/**
 * The list action row: raft-ui's SelectActionItem, last in the list after a
 * separator. Arrow keys and typeahead reach it like an option; pressing it runs
 * the toggle, never becomes the value, and leaves the list open.
 */
function RuntimeSelectListActionRow({ action }: { action: RuntimeSelectListAction }) {
  return (
    <>
      <SelectSeparator />
      <SelectActionItem
        data-testid="runtime-picker-show-all"
        onAction={action.onToggle}
      >
        {action.label}
      </SelectActionItem>
    </>
  );
}

/** Test-only alias. Exported so a tooth can drive the select-only field shape
 *  directly: the invalid mark crosses StableField → this component →
 *  SelectTrigger, and a component silently swallows props it does not declare,
 *  so the end of that chain needs asserting somewhere. */
export { RuntimeSelectControl as RuntimeSelectControlForTest };

export function RuntimeSelectControl({
  value,
  onValueChange,
  options,
  placeholder,
  portalContainer,
  testId,
  listAction,
  "data-invalid": dataInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly RuntimeOption[];
  placeholder: string;
  portalContainer?: RefObject<HTMLElement | null>;
  testId?: string;
  /** A row after the options that changes what the list shows; see RuntimeSelectListActionRow. */
  listAction?: RuntimeSelectListAction;
  /** Set by StableField when this select is the field's adopted control and the
   *  field is in error. Accepted EXPLICITLY and forwarded to the trigger: a
   *  component silently swallows unknown props, so without this the mark reached
   *  `RuntimeSelectControl` and stopped there — a select-only field would show
   *  its error while announcing itself perfectly valid. The trigger is the
   *  focusable element, carries the `data-invalid:` styling variants, and derives
   *  `aria-invalid` from this same prop. */
  "data-invalid"?: string;
  /** Likewise, and for the same swallowing reason. Now that the message row is
   *  associated with the ADOPTED control by hand rather than broadcast through
   *  Field context, a select that is its field's control gets its description
   *  only if this component passes it along. Caught by the visual suite's
   *  "every field's control is wired" check, not by the unit teeth. */
  "aria-describedby"?: string;
}) {
  const handleValueChange = useCallback(
    (nextValue: string | null) => commitRuntimeSelectValue(options, nextValue, onValueChange),
    [options, onValueChange],
  );
  const contentPortalProps = useMemo(
    () => (portalContainer ? { container: portalContainer } : undefined),
    [portalContainer],
  );
  // The trigger says Experimental and what the computer lacks too; `items`
  // labels stay the plain name for type-to-search, so both are drawn here
  // rather than through them.
  const hasDecoratedLabel = options.some((option) => option.experimental || option.availabilitySuffix);
  const renderValue = useCallback((selected: unknown) => {
    const option = options.find((candidate) => candidate.value === selected);
    return option ? runtimeOptionLabel(option, false) : placeholder;
  }, [options, placeholder]);
  return (
    <Select
      // `chrome` lives on the Select ROOT and reaches the portal popup through
      // context, so the trigger and its options share the field type contract.
      // Never restate field metrics as classes on the trigger or the popup.
      chrome="field"
      value={value}
      onValueChange={handleValueChange}
      items={options}
    >
      <SelectTrigger className="w-full" data-testid={testId} data-invalid={dataInvalid} aria-describedby={ariaDescribedBy}>
        <SelectValue placeholder={placeholder}>{hasDecoratedLabel ? renderValue : undefined}</SelectValue>
        <SelectIcon />
      </SelectTrigger>
      {/* With a list action the popup is a column and the list may shrink: in a
          short window the list scrolls inside the popup instead of being cut
          off below it, so its last row, the action, stays reachable. */}
      <SelectContent portalProps={contentPortalProps} className={listAction ? "flex flex-col" : undefined}>
        <SelectList className={listAction ? "min-h-0" : undefined}>
          {renderSelectItems(options)}
          {listAction ? <RuntimeSelectListActionRow action={listAction} /> : null}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

export interface EnvVarEntry {
  key: string;
  value: string;
}

function runtimeFormUnavailableMessageId(
  loading: boolean,
  error: boolean,
  errorCode?: string,
) {
  if (loading) return "agent.runtimeConfig.schemaLoading";
  if (errorCode === "builtin_catalog_capability_required") {
    return "agent.runtimeModels.builtInUpgradeRequired";
  }
  if (
    errorCode === "builtin_catalog_unavailable" ||
    errorCode === "builtin_catalog_stale"
  ) {
    return "agent.runtimeModels.builtInCatalogUnavailable";
  }
  return error
    ? "agent.runtimeConfig.schemaErrorRefresh"
    : "agent.runtimeConfig.schemaUnavailable";
}

/** Why the runtime's form is not shown yet. Loading is information (cyan);
 *  an error or a missing form is a recoverable problem (orange). */
function RuntimeFormUnavailableNotice({ loading, error, errorCode, onRetry }: {
  loading: boolean;
  error: boolean;
  errorCode?: string;
  /** Load the whole form again; offered only for a failed load. */
  onRetry?: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <Banner
      intent={loading ? "info" : "warning"}
      data-testid="schema-runtime-unavailable"
      actions={!loading && error && onRetry ? (
        <Button type="button" variant="outline" size="md" onClick={onRetry} data-testid="runtime-form-v2-reload">
          {formatMessage({ id: "agent.runtimeFormV2.retry" })}
        </Button>
      ) : undefined}
    >
      {formatMessage({ id: runtimeFormUnavailableMessageId(loading, error, errorCode) })}
    </Banner>
  );
}

/**
 * The "More" / "Advanced" disclosure: a collapsible section title
 * (DS `button.rf-section__title`) — 13/18 700 ink-3, sentence case, a 14px
 * chevron, and `aria-expanded` saying whether the group below is open.
 */
export function RuntimeDisclosureToggle({ open, onOpenChange, children }: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const handleClick = useCallback(() => onOpenChange?.(!open), [onOpenChange, open]);
  return (
    <SectionEyebrow
      as="button"
      onClick={handleClick}
      aria-expanded={open}
      className="flex items-center gap-2 rounded-control outline-none hover:text-foreground focus-visible:shadow-focus"
    >
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      {children}
    </SectionEyebrow>
  );
}

export function RuntimeEnvVarsField({
  entries,
  onChange,
  optional,
  hint,
}: {
  entries: EnvVarEntry[];
  onChange: (entries: EnvVarEntry[]) => void;
  optional?: boolean;
  hint?: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const handleKeyChange = useCallback((index: number, key: string) => {
    const updated = [...entries];
    updated[index] = { ...updated[index], key };
    onChange(updated);
  }, [entries, onChange]);
  const handleValueChange = useCallback((index: number, value: string) => {
    const updated = [...entries];
    updated[index] = { ...updated[index], value };
    onChange(updated);
  }, [entries, onChange]);
  const handleRemove = useCallback((index: number) => {
    onChange(entries.filter((_, i) => i !== index));
  }, [entries, onChange]);
  const handleAdd = useCallback(() => {
    onChange([...entries, { key: "", value: "" }]);
  }, [entries, onChange]);
  return (
    <Field label={formatMessage({ id: "agent.runtimeConfig.envVars" })} optional={optional} adopt={false}>
      {hint && <p className="mb-2 -mt-1 text-caption text-foreground-hint">{hint}</p>}
      <div className="stack-y-2">
        {entries.map((entry, index) => (
          <RuntimeEnvVarRow
            key={index}
            index={index}
            entry={entry}
            onKeyChange={handleKeyChange}
            onValueChange={handleValueChange}
            onRemove={handleRemove}
          />
        ))}
        <KeyValueAddButton
          label={formatMessage({ id: "agent.runtimeConfig.addVariable" })}
          onClick={handleAdd}
        />
      </div>
    </Field>
  );
}
interface RuntimeConfigFieldsProps {
  runtime: string;
  onRuntimeChange: (runtime: string) => void;
  runtimeOptions: RuntimeOption[];
  runtimeLabel?: string;
  /** The runtime field has no error or hint of its own, so its message row is
   *  only reserved space. Pass `false` where no neighbouring field's height has to
   *  match (Cindy's setup screen, where it read as a missing line). */
  reserveRuntimeMessage?: boolean;
  /** Inside the runtime field, under its description line: the runtime's
   *  sign-in notice (RuntimeSignInNotice). */
  runtimeBelowDescription?: ReactNode;
  /** Inside the runtime select's list, after the options: Show All Supported. */
  runtimeListAction?: RuntimeSelectListAction;
  /** Re-ask the computer which runtimes are installed. Omit to hide the control. */
  onRescanRuntimes?: () => void;
  runtimesRescanning?: boolean;
  selectPortalContainer?: RefObject<HTMLElement | null>;
  /**
   * The selected runtime's protocol v2 form. Anything but a ready form (loading,
   * a failed load, a form this build cannot render, a runtime without a v2 form)
   * shows the form-unavailable notice in its place. Omit to render only the
   * runtime picker (no runtime selected yet, or the DEV-only preview).
   */
  runtimeFormV2?: {
    state: RuntimeFormV2State;
    values: RuntimeFormV2Values | null;
    onChange: (key: string, value: RuntimeFormV2Value) => void;
    serverErrors?: Record<string, string>;
    /** Edit: blank writeOnly fields keep the stored value. */
    editing?: boolean;
  };
  /** Saved Provider connections, for the v2 form's pencil action on the selected one. */
  providerConnections?: readonly ProviderConnectionSummary[];
  onEditProviderConnection?: (connection: ProviderConnectionSummary) => void;
  /**
   * Whether field-level validation errors are allowed to be VISIBLE yet.
   *
   * The errors themselves are always computed — submit still depends on them, so
   * gating this does not let an invalid form through. It only controls whether the
   * field has anything to say out loud, because a form that greets you in red
   * before you have typed a character is reporting your inaction as a mistake
   * (Cindy, acceptance on the onboarding Create Agent).
   *
   * Defaults to `true`: Agent Details and every other existing caller keeps the
   * behaviour it has today, and only a caller that owns a submit moment opts into
   * deferring. A default of `false` would silently hide errors on surfaces that
   * have no way to turn them back on.
   */
  showValidationErrors?: boolean;
}

export default function RuntimeConfigFields({
  runtime,
  onRuntimeChange,
  runtimeOptions,
  runtimeLabel,
  reserveRuntimeMessage = true,
  runtimeBelowDescription,
  runtimeListAction,
  onRescanRuntimes,
  runtimesRescanning = false,
  selectPortalContainer,
  runtimeFormV2,
  providerConnections = NO_PROVIDER_CONNECTIONS,
  onEditProviderConnection,
  showValidationErrors = true,
}: RuntimeConfigFieldsProps) {
  // `provider.saved_connection` (v2 forms): the pencil action bridge, memoized
  // so the object identity is stable across renders (react-doctor).
  const savedConnectionsForV2 = useMemo(() => (onEditProviderConnection
    ? {
        onEdit: (connectionId: string) => {
          const connection = providerConnections.find((candidate) => candidate.id === connectionId);
          if (connection) onEditProviderConnection(connection);
        },
      }
    : undefined), [onEditProviderConnection, providerConnections]);
  const { formatMessage } = useIntl();
  const effectiveRuntimeLabel = runtimeLabel ?? formatMessage({ id: "agent.runtimeConfig.runtime" });

  return (
    <>
      <Field
        label={effectiveRuntimeLabel}
        required
        reserveMessage={reserveRuntimeMessage}
        belowDescription={runtimeBelowDescription}
        labelAccessory={onRescanRuntimes ? (
          <Tooltip content={formatMessage({ id: "agent.runtimeConfig.rescanRuntimesTitle" })}>
            <FieldAction
              tone="icon"
              type="button"
              onClick={onRescanRuntimes}
              disabled={runtimesRescanning}
              aria-label={formatMessage({ id: "agent.runtimeConfig.rescanRuntimesAria" })}
            >
              <RefreshCw size={14} className={runtimesRescanning ? "animate-spin" : ""} aria-hidden="true" />
            </FieldAction>
          </Tooltip>
        ) : undefined}
      >
        <RuntimeSelectControl
          value={runtime}
          onValueChange={onRuntimeChange}
          options={runtimeOptions}
          listAction={runtimeListAction}
          placeholder={formatMessage({ id: "common.select.placeholder" })}
          portalContainer={selectPortalContainer}
        />
      </Field>

      {runtimeFormV2 && (
        runtimeFormV2.state.status === "ready" && runtimeFormV2.values ? (
          <RuntimeFormV2Fields
            form={runtimeFormV2.state.form}
            sources={runtimeFormV2.state.sources}
            values={runtimeFormV2.values}
            onChange={runtimeFormV2.onChange}
            showValidationErrors={showValidationErrors}
            serverErrors={runtimeFormV2.serverErrors}
            editing={runtimeFormV2.editing}
            portalContainer={selectPortalContainer}
            onRetrySource={runtimeFormV2.state.retrySource}
            retryingSourceIds={runtimeFormV2.state.retryingSourceIds}
            savedConnections={savedConnectionsForV2}
          />
        ) : (
          // "unsupported" (a form this build cannot render, or a runtime with no
          // v2 form) is neither loading nor a failed load: the plain
          // unavailable copy, without a retry that could not help.
          <RuntimeFormUnavailableNotice
            loading={runtimeFormV2.state.status === "loading" || runtimeFormV2.state.status === "idle"}
            error={runtimeFormV2.state.status === "error"}
            errorCode={runtimeFormV2.state.status === "error" ? runtimeFormV2.state.errorCode : undefined}
            onRetry={runtimeFormV2.state.status === "error" ? runtimeFormV2.state.reload : undefined}
          />
        )
      )}
    </>
  );
}


/**
 * Protocol v2 form: rendered by field kind from the server's description, with
 * no field or runtime names in this component. State rules (defaults, cascade,
 * visibility, validation) live in @botiverse/raft-runtime-form so mobile follows
 * the same ones.
 */
export function RuntimeFormV2Fields({
  form,
  sources,
  values,
  onChange,
  showValidationErrors,
  serverErrors,
  editing = false,
  portalContainer,
  onRetrySource,
  retryingSourceIds = NO_SOURCE_IDS,
  savedConnections,
}: {
  form: ParsedRuntimeFormV2;
  sources: RuntimeFormV2Sources;
  values: RuntimeFormV2Values;
  onChange: (key: string, value: RuntimeFormV2Value) => void;
  showValidationErrors: boolean;
  /** Field key → message returned by the server for this submission. */
  serverErrors?: Record<string, string>;
  /** Edit: blank writeOnly (secret) fields keep the stored value. */
  editing?: boolean;
  portalContainer?: RefObject<HTMLElement | null>;
  /** `option_source.status`: re-request a source (`?refresh=1`). */
  onRetrySource?: (sourceId: string) => void;
  retryingSourceIds?: readonly string[];
  /**
   * `provider.saved_connection`: pencil action for the selected saved
   * connection. Present only for callers whose operator may edit provider
   * connections (manageExternalAuth).
   */
  savedConnections?: { onEdit: (connectionId: string) => void };
}) {
  const { formatMessage } = useIntl();
  // Renderer convention: Advanced opens whenever a visible field in it has a
  // value (on edit, or once one is set), so a value in effect is never
  // collapsed out of sight. Opened once per appearance; the user may collapse it.
  const advancedHasValue = runtimeFormV2AdvancedStartsOpen(form, values, sources);
  const [advancedOpen, setAdvancedOpen] = useState(advancedHasValue);
  const [sawAdvancedValue, setSawAdvancedValue] = useState(advancedHasValue);
  if (advancedHasValue !== sawAdvancedValue) {
    setSawAdvancedValue(advancedHasValue);
    if (advancedHasValue) setAdvancedOpen(true);
  }
  const errors = validateRuntimeFormV2(form, sources, values, { editing });
  const errorText = (key: string): string | undefined => {
    if (serverErrors?.[key]) return serverErrors[key];
    // Save is disabled while this holds, so it shows without a submit attempt.
    if (errors[key] === "secret_reentry_required") return formatMessage({ id: "agent.runtimeFormV2.secretReentryRequired" });
    if (!showValidationErrors || !errors[key]) return undefined;
    switch (errors[key]) {
      case "invalid_url": return formatMessage({ id: "agent.runtimeConfig.baseUrlInvalid" });
      case "not_a_choice": return formatMessage({ id: "agent.runtimeFormV2.notAChoice" });
      case "unsupported_required": return formatMessage({ id: "agent.runtimeFormV2.updateToEdit" });
      // The field's source status line already says why, with its retry.
      case "source_unavailable": return undefined;
      // A bound-but-unavailable saved connection: visible, never silently rewritten.
      case "connection_unavailable": return formatMessage({ id: "agent.runtimeConfig.savedProviderUnavailable" });
      // v3: the value is an unavailable entry (a saved connection, or a model
      // on a list-only source): shown selected, pick another to save.
      case "option_unavailable": {
        const field = form.fields.find((candidate) => candidate.key === key);
        const entry = field ? runtimeFormV2UnavailableSelection(field, sources, values) : undefined;
        return formatMessage({ id: entry?.connectionId ? "agent.runtimeConfig.savedProviderUnavailable" : "agent.runtimeFormV2.notAChoice" });
      }
      default: return formatMessage({ id: "agent.runtimeFormV2.required" });
    }
  };

  // Saved provider connections (`provider.saved_connection`): while any field
  // holds a connection selection, the fields it owns are the connection's, not
  // the user's — disabled, placeholder, never submitted (the shared
  // runtimeFormV2Submission rules). Per-field rendering lives in
  // RuntimeFormV2FieldControl; the parent computes the form-wide state once.
  const connectionActive = runtimeFormV2ConnectionActive(form, sources, values);
  const selectedConnectionOption = connectionActive
    ? form.fields
        .map((candidate) => runtimeFormV2SelectedConnection(candidate, sources, values))
        .find((option): option is NonNullable<typeof option> => option !== undefined)
    : undefined;
  const managedPlaceholder = formatMessage(
    { id: "agent.runtimeConfig.credentialFromSavedProvider" },
    { connection: selectedConnectionOption?.label ?? formatMessage({ id: "agent.runtimeConfig.savedProviderUnavailable" }) },
  );

  const renderField = (field: RuntimeFormV2Field) => (
    // An optional field whose source is unavailable is hidden (option_source.status).
    isRuntimeFormV2FieldVisible(field, values, sources) ? (
      <RuntimeFormV2FieldControl
        key={field.key}
        field={field}
        sources={sources}
        values={values}
        onChange={onChange}
        error={errorText(field.key)}
        // A secret that cannot keep the stored value is edited like on create:
        // required, without the "leave blank to keep" hint.
        editing={editing && errors[field.key] !== "secret_reentry_required"}
        portalContainer={portalContainer}
        onRetrySource={onRetrySource}
        retryingSourceIds={retryingSourceIds}
        connectionActive={connectionActive}
        managedPlaceholder={connectionActive ? managedPlaceholder : undefined}
        savedConnections={savedConnections}
      />
    ) : null
  );

  const main = form.fields.filter((field) => !field.advanced);
  const advanced = form.fields.filter((field) => field.advanced);
  return (
    <>
      {main.map(renderField)}
      {advanced.length > 0 && (
        <div>
          <RuntimeDisclosureToggle open={advancedOpen} onOpenChange={setAdvancedOpen}>
            {formatMessage({ id: "agent.runtimeConfig.advanced" })}
          </RuntimeDisclosureToggle>
          {advancedOpen && (
            <div className="mt-3 stack-y-3 border-l border-line-hairline pl-3">
              {advanced.map(renderField)}
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Key/value editor over a string map; keeps half-typed rows locally until they have a key. */
export function RuntimeFormV2StringMapField({
  value,
  hint,
  onChange,
}: {
  value: Record<string, string>;
  hint?: ReactNode;
  onChange: (next: Record<string, string>) => void;
}) {
  const [entries, setEntries] = useState<EnvVarEntry[]>(() => Object.entries(value).map(([key, item]) => ({ key, value: item })));
  const handleChange = useCallback((next: EnvVarEntry[]) => {
    setEntries(next);
    const map: Record<string, string> = {};
    for (const entry of next) if (entry.key.trim()) map[entry.key.trim()] = entry.value;
    onChange(map);
  }, [onChange]);
  return (
    <RuntimeEnvVarsField
      entries={entries}
      hint={hint}
      onChange={handleChange}
    />
  );
}
