import { ChevronDown, ChevronRight, Info, RefreshCw } from "lucide-react";
import type { RefObject, ReactNode } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { getModelLabel, getRuntimeDisplayName, getRuntimeProviderDisplayName, REASONING_EFFORT_RUNTIMES } from "@botiverse/raft-shared";
import type { ResolvedAgentCreateFormDefinition, ReasoningEffort, RuntimeModelInfo, RuntimeReasoningEffort } from "@botiverse/raft-shared";
import {
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardLeading,
  CardTitle,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "raft-ui";
import StableField from "./StableField";
import { KeyValueAddButton, KeyValueInputRow } from "../ui/KeyValueInput";
import Tooltip from "../ui/Tooltip";
import { reasoningEffortOptionsForModel } from "../../utils/reasoningEffortOptions";
import {
  builtInCatalogCapabilityIsLive,
  projectBuiltInPresetModelOptions,
} from "../../hooks/useRuntimeModels";
import type { RuntimeModelSourceState } from "../../hooks/useRuntimeModels";
import {
  CUSTOM_MODEL_SELECT_VALUE,
  BUILTIN_RUNTIME_ALL_PROVIDER_IDS,
  PI_BUILTIN_PROVIDER_IDS,
  PI_PROVIDER_CONFIGURED,
  builtInProviderModels,
  isBuiltInGatewayProviderMode,
  piBuiltinProviderModels,
  runtimeIgnoresModel,
  supportsRuntimeApiUrl,
  supportsRuntimeBuiltInProvider,
  supportsRuntimeCommand,
  supportsRuntimeCustomModelName,
  supportsRuntimeFastMode,
  supportsRuntimePiProvider,
} from "../../utils/runtimeConfigForm";
import type {
  BuiltInProviderMode,
  PiProviderMode,
  RuntimeProviderMode,
} from "../../utils/runtimeConfigForm";

const DEFAULT_REASONING_EFFORT_SELECT_VALUE = "__default_reasoning_effort__";

/**
 * Field-level action (rescan / retry).
 *
 * Both callsites now render the same chrome. This used to branch on whether the
 * page had opted in, so that Agent Details kept raw buttons while Create Agent
 * got tokenised ones; with Agent Details migrated there is nothing left to
 * branch on, and the `className` a caller passes is styling that survives on top
 * of the variant rather than instead of it.
 */
function FieldAction({ tone, className: _legacyClassName, children, ...props }: {
  tone: "icon" | "link";
  /** Accepted and DISCARDED. These are the pre-migration hand-rolled styles
   *  (`font-bold underline`, `ml-auto text-black/40`, …); the tokenised variants
   *  below own the appearance now. The prop stays on the signature because eight
   *  callsites still pass it, and deleting it there is churn that would bury this
   *  change — but it must not reach the Button, or the old look would be layered
   *  back on top of the new one. Discarding it is what the opted-in path already
   *  did before Agent Details joined it. */
  className: string;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  void _legacyClassName;
  return tone === "icon"
    ? <Button variant="ghost" size="icon-xs" className="ml-auto" {...props}>{children}</Button>
    // `inline`, not `sm`. `sm` is a CONTROL size — h-7 plus px-2.5 — so the
    // retry rendered as a 28px-tall box with side padding parked under the
    // sentence, which is what read as "not inline, lots of padding" in
    // acceptance. raft-ui 0.5.3 ships `inline` for exactly this case:
    // `h-auto p-0 align-baseline leading-[inherit]`, i.e. a word in a line of
    // text that happens to be clickable. No `mt-1` either — a top margin on an
    // inline action is what forced it onto its own row.
    : <Button variant="link" size="inline" {...props}>{children}</Button>;
}

/**
 * Every field in this form is a reserved-row field.
 *
 * This was a switch between StableField and the older FormField so that Agent
 * Details kept its existing rhythm while Create Agent moved. Both pages are on
 * StableField now, so the indirection is just a name — kept because eight
 * callsites read it, and renaming them would bury the actual change in noise.
 */
const Field = StableField;

/**
 * raft-ui builds SelectTrigger on `Button`, so out of the box a select inherits
 * BUTTON metrics (h-8 = 32px, text-sm, font-bold) while `Input` — which has no
 * height, font-size or font-weight token of its own — renders at 44px / 16px /
 * 400. Three axes diverge, and the two controls sit in the same form.
 *
 * `field` re-states the select trigger in INPUT metrics so the two match:
 * content height from `py-2` (as Input does), normal weight, same font size.
 * Height is deliberately not a fixed token — it is derived the same way Input
 * derives it, so the two cannot drift apart if the type scale changes.
 *
 * This belongs in raft-ui, not here: a select trigger is semantically a field,
 * not a button. Reported upstream; until it lands, the app states it explicitly
 * rather than leaving the mismatch visible.
 */
/* Removed: the field arm now opts in via `chrome="field"` on the Select root.
 * What this constant used to say — "h-auto py-2 text-base font-normal" — is why
 * it had to go: `text-base` is a LITERAL 16px, i.e. brutal's token. Under elegant
 * (14px) it was simply wrong, and because it wasn't `font-field` the option text
 * still lost to the theme's own weight rule. A restated metric cannot follow a
 * token; only the real axis can. Kept out of the `legacy` arm, which is untouched. */

/**
 * Scoped popup metrics for the opt-in pages.
 *
 * The trigger was aligned to input metrics, but the panel it opens was not —
 * the same option read 16px/400 in the trigger and 12px/700 in the list. The
 * popup renders in a portal, outside the field subtree, which is why the field
 * geometry assertions could not see it and did not object.
 *
 * `SelectContent` forwards `className` onto the portal popup, so the options can
 * be brought onto the field contract from the callsite, scoped to this page —
 * no global CSS, no `!important`, and every other raft-ui Select untouched.
 * Written as descendant variants rather than a stylesheet rule so the scope is
 * visible at the callsite instead of hidden in index.css.
 *
 * The real fix belongs in raft-ui: a select is a field, so its trigger and its
 * options should share one type contract instead of each callsite restating it.
 */
/* Removed for the same reason as FIELD_METRIC_TRIGGER: `chrome="field"` reaches
 * the portal popup through React context, so the options inherit the field
 * contract without the callsite restating 16px/400 at them. */



export interface RuntimeOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Optional secondary line (e.g. per-effort reasoning-level description). */
  description?: string;
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

function renderSelectItems(options: readonly RuntimeOption[]) {
  return options.map((option) => (
    <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
      <SelectItemText>
        {option.description ? (
          <span className="flex flex-col">
            <span>{option.label}</span>
            <span className="text-xs font-normal text-black/50">{option.description}</span>
          </span>
        ) : (
          option.label
        )}
      </SelectItemText>
      <SelectItemIndicator />
    </SelectItem>
  ));
}

/** Test-only alias. Exported so a tooth can drive the select-only field shape
 *  directly: the invalid mark crosses StableField → this component →
 *  SelectTrigger, and a component silently swallows props it does not declare,
 *  so the end of that chain needs asserting somewhere. */
export { RuntimeSelectControl as RuntimeSelectControlForTest };

function RuntimeSelectControl({
  value,
  onValueChange,
  options,
  placeholder,
  portalContainer,
  testId,
  "data-invalid": dataInvalid,
  "aria-describedby": ariaDescribedBy,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly RuntimeOption[];
  placeholder: string;
  portalContainer?: RefObject<HTMLElement | null>;
  testId?: string;
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
  return (
    <Select
      // `chrome` lives on the Select ROOT and reaches the popup through context,
      // so the trigger and its options share one contract. Restating metrics as
      // classes on the trigger (the old FIELD_METRIC_* constants) could not do
      // that — it hardcoded 16px, which is brutal's token, so elegant silently
      // rendered at the wrong size.
      chrome="field"
      value={value}
      onValueChange={(nextValue) => commitRuntimeSelectValue(options, nextValue, onValueChange)}
      items={options}
    >
      <SelectTrigger className="w-full" data-testid={testId} data-invalid={dataInvalid} aria-describedby={ariaDescribedBy}>
        <SelectValue placeholder={placeholder} />
        <SelectIcon />
      </SelectTrigger>
      <SelectContent
        portalProps={portalContainer ? { container: portalContainer } : undefined}
      >
        <SelectList>{renderSelectItems(options)}</SelectList>
      </SelectContent>
    </Select>
  );
}

export interface EnvVarEntry {
  key: string;
  value: string;
}

function runtimeModelSourceStatus(
  intl: IntlShape,
  runtime: string,
  source: RuntimeModelSourceState,
): ReactNode {
  const runtimeName = getRuntimeDisplayName(runtime);
  switch (source.kind) {
    case "live":
      return null;
    case "loading":
      return intl.formatMessage({ id: "agent.runtimeModels.loading" });
    case "missing_config":
      return source.recovery === "kimi_login"
        ? intl.formatMessage(
          { id: "agent.runtimeModels.kimiLoginRequired" },
          {
            command: (chunks) => (
              <code key="command" className="font-mono font-bold">{chunks}</code>
            ),
          },
        )
        : intl.formatMessage(
          { id: "agent.runtimeModels.missingConfig" },
          { runtimeName },
        );
    case "no_models":
      return intl.formatMessage(
        { id: "agent.runtimeModels.noModels" },
        { runtimeName },
      );
    case "unsupported":
      return runtimeIgnoresModel(runtime)
        ? intl.formatMessage(
          { id: "agent.runtimeModels.defaultModel" },
          { runtimeName },
        )
        : intl.formatMessage(
          { id: "agent.runtimeModels.unsupported" },
          { runtimeName },
        );
    case "error":
      return intl.formatMessage({ id: "agent.runtimeModels.error" });
    case "idle":
      return intl.formatMessage({ id: "agent.runtimeModels.idle" });
  }
}

function builtInCatalogStatus(
  intl: IntlShape,
  source: RuntimeModelSourceState,
  model: string,
): ReactNode {
  if (source.kind === "live") {
    if (!builtInCatalogCapabilityIsLive(source)) {
      return intl.formatMessage({
        id: "agent.runtimeModels.builtInUpgradeRequired",
      });
    }
    return source.value.models.some((candidate) => candidate.id === model)
      ? null
      : intl.formatMessage({
          id: "agent.runtimeModels.builtInSelectionUnavailable",
        });
  }
  if (source.kind === "loading") {
    return intl.formatMessage({ id: "agent.runtimeModels.loading" });
  }
  return intl.formatMessage({
    id: "agent.runtimeModels.builtInCatalogUnavailable",
  });
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

interface RuntimeConfigFieldsProps {
  runtime: string;
  onRuntimeChange: (runtime: string) => void;
  runtimeOptions: RuntimeOption[];
  model: string;
  /** The stored value is display-only when this Computer cannot prove it. */
  persistedModel?: string;
  onModelChange: (model: string) => void;
  customModelMode: boolean;
  onCustomModelModeChange: (enabled: boolean) => void;
  modelOptions: RuntimeOption[];
  runtimeModels: {
    source: RuntimeModelSourceState;
    models: RuntimeModelInfo[];
    loading: boolean;
    rescan: () => void;
  };
  rescanDisabled?: boolean;
  providerMode: RuntimeProviderMode;
  onProviderModeChange: (mode: RuntimeProviderMode) => void;
  providerApiUrl: string;
  onProviderApiUrlChange: (value: string) => void;
  providerApiKey: string;
  onProviderApiKeyChange: (value: string) => void;
  builtInProviderMode: BuiltInProviderMode;
  onBuiltInProviderModeChange: (mode: BuiltInProviderMode) => void;
  builtInProviderApiKey?: string;
  onBuiltInProviderApiKeyChange?: (value: string) => void;
  builtInProviderBaseUrl?: string;
  onBuiltInProviderBaseUrlChange?: (value: string) => void;
  builtInProviderSupportsImageInput?: boolean;
  onBuiltInProviderSupportsImageInputChange?: (enabled: boolean) => void;
  piProviderMode: PiProviderMode;
  onPiProviderModeChange: (mode: PiProviderMode) => void;
  piProviderApiKey: string;
  onPiProviderApiKeyChange: (value: string) => void;
  fastMode: boolean;
  onFastModeChange: (enabled: boolean) => void;
  command: string;
  onCommandChange: (command: string) => void;
  reasoningEffort: RuntimeReasoningEffort | null;
  onReasoningEffortChange: (effort: RuntimeReasoningEffort | null) => void;
  envVarEntries: EnvVarEntry[];
  onEnvVarEntriesChange: (entries: EnvVarEntry[]) => void;
  showRuntimeField?: boolean;
  runtimeLabel?: string;
  /** Optional explainer under the runtime select — onboarding users have no idea what a "runtime" is. */
  runtimeHint?: string;
  /** Re-ask the computer which runtimes are installed. Omit to hide the control. */
  onRescanRuntimes?: () => void;
  runtimesRescanning?: boolean;
  envVarsMode?: "inline" | "advanced" | "hidden";
  technicalFieldsMode?: "inline" | "advanced" | "hidden";
  advancedOpen?: boolean;
  onAdvancedOpenChange?: (open: boolean) => void;
  envVarsHint?: string;
  selectedModelSuggestionOnly?: boolean;
  showBuiltInRequiredHint?: boolean;
  selectPortalContainer?: RefObject<HTMLElement | null>;
  schemaBacked?: boolean;
  formDefinition?: ResolvedAgentCreateFormDefinition | null;
  formDefinitionLoading?: boolean;
  formDefinitionError?: boolean;
  formDefinitionErrorCode?: string;
  managedConnectionActive?: boolean;
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

function SchemaDrivenRuntimeFields({
  definition,
  providerId,
  onProviderChange,
  apiKey,
  onApiKeyChange,
  baseUrl,
  onBaseUrlChange,
  supportsImageInput,
  onSupportsImageInputChange,
  model,
  persistedModel,
  onModelChange,
  reasoningEffort,
  onReasoningEffortChange,
  onCustomModelModeChange,
  envVarEntries,
  onEnvVarEntriesChange,
  advancedOpen,
  onAdvancedOpenChange,
  portalContainer,
  managedConnectionActive = false,
  showValidationErrors = true,
}: {
  definition: ResolvedAgentCreateFormDefinition;
  providerId: string;
  onProviderChange: (value: string) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  baseUrl: string;
  onBaseUrlChange: (value: string) => void;
  supportsImageInput: boolean;
  onSupportsImageInputChange: (enabled: boolean) => void;
  model: string;
  persistedModel?: string;
  onModelChange: (value: string) => void;
  reasoningEffort: RuntimeReasoningEffort | null;
  onReasoningEffortChange: (value: RuntimeReasoningEffort | null) => void;
  onCustomModelModeChange: (enabled: boolean) => void;
  envVarEntries: EnvVarEntry[];
  onEnvVarEntriesChange: (entries: EnvVarEntry[]) => void;
  advancedOpen: boolean;
  onAdvancedOpenChange?: (open: boolean) => void;
  portalContainer?: RefObject<HTMLElement | null>;
  managedConnectionActive?: boolean;
  showValidationErrors?: boolean;
}) {
  const { formatMessage } = useIntl();
  if (definition.runtimeId === "kimi-sdk") {
    const modelSource = definition.optionSources.model;
    if (modelSource?.kind !== "select") return null;
    const selectedModel = modelSource.options.find((option) => option.value === model);
    const modelOptions = selectedModel || !model
      ? modelSource.options
      : [
          ...modelSource.options,
          {
            value: model,
            label: formatMessage(
              { id: "agent.detail.modelNotInComputerConfig" },
              { model },
            ),
            disabled: true,
          },
        ];
    const supportedEfforts = selectedModel?.supportedReasoningEfforts ?? [];
    const incompatibleEffort = reasoningEffort !== null && !supportedEfforts.includes(reasoningEffort);
    const effortOptions: RuntimeOption[] = [
      {
        value: DEFAULT_REASONING_EFFORT_SELECT_VALUE,
        label: formatMessage({ id: "agent.runtimeConfig.default" }),
      },
      ...supportedEfforts.map((effort) => ({ value: effort, label: effort })),
      ...(incompatibleEffort
        ? [{ value: reasoningEffort, label: reasoningEffort, disabled: true }]
        : []),
    ];
    const labels = definition.uiSchema.localization;
    return (
      <>
        <Field
          label={labels.model?.label ?? formatMessage({ id: "agent.runtimeConfig.model" })}
          hint={labels.model?.hint}
          required
          error={showValidationErrors && !selectedModel
            ? formatMessage({ id: "agent.runtimeConfig.modelRequired" })
            : undefined}
        >
          <RuntimeSelectControl
            value={model}
            onValueChange={(next) => {
              const nextModel = modelSource.options.find((option) => option.value === next);
              onModelChange(next);
              onReasoningEffortChange(nextModel?.defaultReasoningEffort ?? null);
            }}
            options={modelOptions}
            placeholder={labels.model?.placeholder ?? formatMessage({ id: "agent.runtimeConfig.model" })}
            portalContainer={portalContainer}
            testId="schema-runtime-model-select"
          />
        </Field>
        {supportedEfforts.length > 0 && (
          <Field
            label={labels.reasoningEffort?.label ?? formatMessage({ id: "agent.runtimeConfig.reasoning" })}
            hint={labels.reasoningEffort?.hint}
            error={showValidationErrors && incompatibleEffort
              ? formatMessage({ id: "agent.runtimeConfig.reasoningEffortInvalid" })
              : undefined}
          >
            <RuntimeSelectControl
              value={reasoningEffort ?? DEFAULT_REASONING_EFFORT_SELECT_VALUE}
              onValueChange={(next) => onReasoningEffortChange(
                next === DEFAULT_REASONING_EFFORT_SELECT_VALUE ? null : next,
              )}
              options={effortOptions}
              placeholder={formatMessage({ id: "agent.runtimeConfig.default" })}
              portalContainer={portalContainer}
              testId="schema-runtime-reasoning-select"
            />
          </Field>
        )}
        {definition.uiSchema.layout.advanced.includes("/envVars") && (
          <div>
            <button
              type="button"
              onClick={() => onAdvancedOpenChange?.(!advancedOpen)}
              aria-expanded={advancedOpen}
              className="flex items-center gap-1 text-sm font-bold uppercase tracking-wide text-black/60 hover:text-black"
            >
              {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              {formatMessage({ id: "agent.runtimeConfig.advanced" })}
            </button>
            {advancedOpen && (
              <div className="mt-3 border-l-2 border-black/10 pl-3">
                <RuntimeEnvVarsField
                  entries={envVarEntries}
                  onChange={onEnvVarEntriesChange}
                  hint={labels.envVars?.hint}
                />
              </div>
            )}
          </div>
        )}
      </>
    );
  }
  const providerSource = definition.optionSources.provider;
  const modelSource = definition.optionSources.model;
  if (providerSource?.kind !== "select" || modelSource?.kind !== "dependent_select") return null;
  const providerOption = providerSource.options.find((option) => option.value === providerId);
  const providerOptions = providerOption || !persistedModel
    ? providerSource.options
    : [
        ...providerSource.options,
        {
          value: providerId,
          label: providerId,
          providerKind: "preset" as const,
          disabled: true,
        },
      ];
  const gateway = providerOption?.providerKind === "gateway";
  const liveModelOptions = modelSource.optionsByValue[providerId] ?? [];
  const modelOptions = persistedModel && !liveModelOptions.some((option) => option.value === persistedModel)
    ? [
        ...liveModelOptions,
        {
          value: persistedModel,
          label: getModelLabel("builtin", persistedModel),
          disabled: true,
        },
      ]
    : liveModelOptions;
  const labels = definition.uiSchema.localization;
  const baseUrlVisible = definition.uiSchema.visibility.some((rule) =>
    rule.pointer === "/baseUrl" && rule.when.pointer === "/providerId" && rule.when.in.includes(providerId));
  const supportsImageInputVisible = definition.uiSchema.visibility.some((rule) =>
    rule.pointer === "/supportsImageInput" && rule.when.pointer === "/providerId" && rule.when.in.includes(providerId));
  const baseUrlInvalid = baseUrlVisible && !/^https?:\/\//i.test(baseUrl.trim());

  return (
    <>
      {!managedConnectionActive && <Field label={labels.providerId?.label ?? formatMessage({ id: "agent.runtimeConfig.provider" })} hint={labels.providerId?.hint}>
        <RuntimeSelectControl
          value={providerId}
          onValueChange={(next) => {
            const nextOption = providerSource.options.find((option) => option.value === next);
            const nextCustom = nextOption?.providerKind === "gateway";
            onProviderChange(next);
            onCustomModelModeChange(nextCustom);
            onBaseUrlChange("");
            onSupportsImageInputChange(false);
            onAdvancedOpenChange?.(false);
            onModelChange(nextCustom ? "" : (modelSource.defaultValueByValue[next] ?? ""));
          }}
          options={providerOptions}
          placeholder={labels.providerId?.placeholder ?? formatMessage({ id: "agent.runtimeConfig.provider" })}
          portalContainer={portalContainer}
          testId="schema-runtime-provider-select"
        />
      </Field>}
      {!managedConnectionActive && <Field
        label={formatMessage(
          { id: "agent.runtimeConfig.apiKeyForProvider" },
          { provider: providerOption?.label ?? labels.apiKey?.label ?? formatMessage({ id: "agent.runtimeConfig.provider" }) },
        )}
        required
        error={showValidationErrors && !apiKey.trim()
          ? formatMessage({ id: "agent.runtimeConfig.apiKeyRequired" })
          : undefined}
      >
        <Input
          type="password"
          value={apiKey}
          onChange={(event) => onApiKeyChange(event.target.value)}
          placeholder={labels.apiKey?.placeholder ?? "sk-..."}
          autoComplete="off"
          data-testid="schema-runtime-api-key"
        />
      </Field>}
      {!managedConnectionActive && baseUrlVisible && (
        <Field
          label={labels.baseUrl?.label ?? formatMessage({ id: "agent.runtimeConfig.baseUrl" })}
          required
          error={showValidationErrors && baseUrlInvalid
            ? formatMessage({ id: "agent.runtimeConfig.baseUrlInvalid" })
            : undefined}
        >
          <Input
            type="url"
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder={labels.baseUrl?.placeholder ?? "https://gateway.example.com/v1"}
            data-testid="schema-runtime-base-url"
          />
        </Field>
      )}
      {!managedConnectionActive && supportsImageInputVisible && (
        <Field
          label={formatMessage({ id: "agent.runtimeConfig.imageInput" })}
          hint={labels.supportsImageInput?.hint}
          adopt={false}
        >
          <Card variant="option" render={<label />}>
            <CardHeader>
              <CardLeading>
                <Checkbox
                  size="md"
                  checked={supportsImageInput}
                  onCheckedChange={(checked) => onSupportsImageInputChange(checked === true)}
                  aria-labelledby="schema-image-input-title"
            data-testid="schema-runtime-supports-image-input"
                />
              </CardLeading>
              <CardTitle id="schema-image-input-title">{labels.supportsImageInput?.label ?? formatMessage({ id: "agent.runtimeConfig.supportsImageInput" })}</CardTitle>
            </CardHeader>
          </Card>
        </Field>
      )}
      <Field
        label={labels.model?.label ?? formatMessage({ id: "agent.runtimeConfig.model" })}
        required
        error={showValidationErrors && !model.trim()
          ? formatMessage({ id: "agent.runtimeConfig.modelRequired" })
          : undefined}
      >
        {gateway ? (
          <Input
            type="text"
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
            placeholder={labels.model?.placeholder ?? formatMessage({ id: "agent.runtimeConfig.gatewayModelId" })}
            data-testid="schema-runtime-custom-model"
          />
        ) : (
          <RuntimeSelectControl
            value={model}
            onValueChange={onModelChange}
            options={modelOptions}
            placeholder={labels.model?.placeholder ?? formatMessage({ id: "agent.runtimeConfig.model" })}
            portalContainer={portalContainer}
            testId="schema-runtime-model-select"
          />
        )}
      </Field>
      {definition.uiSchema.layout.advanced.includes("/envVars") && (
        <div>
          <button
            type="button"
            onClick={() => onAdvancedOpenChange?.(!advancedOpen)}
            aria-expanded={advancedOpen}
            className="flex items-center gap-1 text-sm font-bold uppercase tracking-wide text-black/60 hover:text-black"
          >
            {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {formatMessage({ id: "agent.runtimeConfig.advanced" })}
          </button>
          {advancedOpen && (
            <div className="mt-3 border-l-2 border-black/10 pl-3">
              <RuntimeEnvVarsField
                entries={envVarEntries}
                onChange={onEnvVarEntriesChange}
                hint={labels.envVars?.hint}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}

function ClaudeCommandInfo() {
  const { formatMessage } = useIntl();
  return (
    <Tooltip
      content={
        formatMessage(
          { id: "agent.runtimeConfig.claudeCommandInfo" },
          {
            code: (chunks) => <span key="code" className="font-mono">{chunks}</span>,
          },
        )
      }
      contentProps={{ side: "bottom", className: "w-72 max-w-[calc(100vw-3rem)] text-left font-normal" }}
    >
      <button
        type="button"
        aria-label={formatMessage({ id: "agent.runtimeConfig.claudeCommandRequirements" })}
        className="inline-flex size-4 items-center justify-center text-black/45 transition-colors hover:text-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
      >
        <Info size={14} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

function RuntimeEnvVarsField({
  entries,
  onChange,
  optional,
  hint,
}: {
  entries: EnvVarEntry[];
  onChange: (entries: EnvVarEntry[]) => void;
  optional?: boolean;
  hint?: string;
}) {
  const { formatMessage } = useIntl();
  return (
    <Field label={formatMessage({ id: "agent.runtimeConfig.envVars" })} optional={optional} adopt={false}>
      {hint && <p className="mb-2 -mt-1 text-xs text-black/50">{hint}</p>}
      <div className="space-y-2">
        {entries.map((entry, index) => (
          <KeyValueInputRow
            key={index}
            keyValue={entry.key}
            value={entry.value}
            onKeyChange={(value) => {
              const updated = [...entries];
              updated[index] = { ...updated[index], key: value };
              onChange(updated);
            }}
            onValueChange={(value) => {
              const updated = [...entries];
              updated[index] = { ...updated[index], value };
              onChange(updated);
            }}
            onRemove={() => onChange(entries.filter((_, i) => i !== index))}
            keyLabel={formatMessage({ id: "agent.runtimeConfig.envVarName" })}
            valueLabel={formatMessage(
              { id: "agent.runtimeConfig.envVarValueFor" },
              { name: entry.key || formatMessage({ id: "agent.runtimeConfig.envVarFallback" }) },
            )}
            removeLabel={formatMessage({ id: "agent.runtimeConfig.removeEnvVar" })}
          />
        ))}
        <KeyValueAddButton
          label={formatMessage({ id: "agent.runtimeConfig.addVariable" })}
          onClick={() => onChange([...entries, { key: "", value: "" }])}
        />
      </div>
    </Field>
  );
}

export default function RuntimeConfigFields({
  runtime,
  onRuntimeChange,
  runtimeOptions,
  model,
  persistedModel,
  onModelChange,
  customModelMode,
  onCustomModelModeChange,
  modelOptions,
  runtimeModels,
  rescanDisabled,
  providerMode,
  onProviderModeChange,
  providerApiUrl,
  onProviderApiUrlChange,
  providerApiKey,
  onProviderApiKeyChange,
  builtInProviderMode,
  onBuiltInProviderModeChange,
  builtInProviderApiKey = "",
  onBuiltInProviderApiKeyChange = () => undefined,
  builtInProviderBaseUrl = "",
  onBuiltInProviderBaseUrlChange = () => undefined,
  builtInProviderSupportsImageInput = false,
  onBuiltInProviderSupportsImageInputChange = () => undefined,
  piProviderMode,
  onPiProviderModeChange,
  piProviderApiKey,
  onPiProviderApiKeyChange,
  fastMode,
  onFastModeChange,
  command,
  onCommandChange,
  reasoningEffort,
  onReasoningEffortChange,
  envVarEntries,
  onEnvVarEntriesChange,
  showRuntimeField = true,
  runtimeLabel,
  runtimeHint,
  onRescanRuntimes,
  runtimesRescanning = false,
  envVarsMode = "inline",
  technicalFieldsMode = "inline",
  advancedOpen = false,
  onAdvancedOpenChange,
  envVarsHint,
  selectedModelSuggestionOnly,
  showBuiltInRequiredHint = false,
  selectPortalContainer,
  schemaBacked = false,
  formDefinition = null,
  formDefinitionLoading = false,
  formDefinitionError = false,
  formDefinitionErrorCode,
  managedConnectionActive = false,
  showValidationErrors = true,
}: RuntimeConfigFieldsProps) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const effectiveRuntimeLabel = runtimeLabel ?? formatMessage({ id: "agent.runtimeConfig.runtime" });
  const effectiveEnvVarsHint = envVarsHint ?? formatMessage({ id: "agent.runtimeConfig.envVarsHint" });
  const apiUrlSupported = supportsRuntimeApiUrl(runtime);
  const commandSupported = supportsRuntimeCommand(runtime);
  const customModelSupported = supportsRuntimeCustomModelName(runtime);
  const fastModeSupported = supportsRuntimeFastMode(runtime);
  const reasoningSupported = REASONING_EFFORT_RUNTIMES.has(runtime)
    && (runtime !== "kimi-sdk" || schemaBacked);
  const providerApiUrlRequired = apiUrlSupported && providerMode === "custom";
  const builtInProviderSupported = supportsRuntimeBuiltInProvider(runtime);
  const piProviderSupported = supportsRuntimePiProvider(runtime);
  const builtInGatewayProvider = builtInProviderSupported && isBuiltInGatewayProviderMode(builtInProviderMode);
  const customModelInputMode = customModelMode || builtInGatewayProvider;
  const builtInCatalogApplies = builtInProviderSupported && !builtInGatewayProvider;
  const builtInModelList = builtInCatalogApplies
    ? projectBuiltInPresetModelOptions({
        source: runtimeModels.source,
        providerModels: builtInProviderModels(builtInProviderMode) ?? [],
        ...(persistedModel ? { persistedModel } : {}),
      })
    : null;
  const builtInBaseUrlInvalid = builtInGatewayProvider && !/^https?:\/\//i.test(builtInProviderBaseUrl.trim());
  const piApiKeyRequired = piProviderSupported && piProviderMode !== PI_PROVIDER_CONFIGURED;
  // Gateway providers are custom-model-only: Slock cannot know what models a
  // user-controlled gateway exposes, so host-discovered modelOptions must not
  // leak into this mode.
  const piBuiltinModelList = piApiKeyRequired ? piBuiltinProviderModels(piProviderMode) : null;
  const providerModelList = builtInModelList ?? piBuiltinModelList;
  const machineSourceApplies = (!providerModelList && !builtInGatewayProvider) || builtInCatalogApplies;
  const effectiveModelOptions: RuntimeOption[] = providerModelList
    ? providerModelList.map((m) => {
        const disabled = "disabled" in m && m.disabled === true;
        return {
          value: m.id,
          label: m.label,
          ...(disabled ? { disabled } : {}),
        };
      })
    : builtInGatewayProvider ? [] : modelOptions;
  const providerModeOptions: RuntimeOption[] = [
    { value: "default", label: formatMessage({ id: "agent.runtimeConfig.default" }) },
    { value: "custom", label: formatMessage({ id: "agent.runtimeConfig.custom" }) },
  ];
  const builtInProviderOptions: RuntimeOption[] = BUILTIN_RUNTIME_ALL_PROVIDER_IDS.map((id) => ({
    value: id,
    label: getRuntimeProviderDisplayName(id),
  }));
  const piProviderOptions: RuntimeOption[] = [
    { value: PI_PROVIDER_CONFIGURED, label: formatMessage({ id: "agent.runtimeConfig.configured" }) },
    ...PI_BUILTIN_PROVIDER_IDS.map((id) => ({
      value: id,
      label: getRuntimeProviderDisplayName(id),
    })),
  ];
  const modelSelectOptions: RuntimeOption[] = [
    ...effectiveModelOptions,
    // A Built-in/Pi provider locks the model picker to its SDK
    // first-class set; "Custom" doesn't apply because the provider
    // namespace owns the model list.
    ...(customModelSupported && !providerModelList ? [{ value: CUSTOM_MODEL_SELECT_VALUE, label: formatMessage({ id: "agent.runtimeConfig.custom" }) }] : []),
  ];
  // Reasoning options are gated by the selected model's declared
  // supportedReasoningEfforts (data-driven — e.g. GPT-5.6 luna omits Ultra);
  // models that don't declare a set fall back to the full catalog.
  const reasoningOptions: RuntimeOption[] = [
    { value: DEFAULT_REASONING_EFFORT_SELECT_VALUE, label: formatMessage({ id: "agent.runtimeConfig.default" }) },
    ...reasoningEffortOptionsForModel(runtime, model, runtimeModels.models).map((option) => ({
      value: option.value,
      label: formatMessage({ id: option.labelId }),
      description: option.descriptionId ? formatMessage({ id: option.descriptionId }) : undefined,
    })),
  ];
  const providerApiUrlInvalid = providerApiUrlRequired
    ? !/^https?:\/\//i.test(providerApiUrl.trim())
    : providerApiUrl.trim().length > 0 && !/^https?:\/\//i.test(providerApiUrl.trim());
  const customModelInvalid = customModelInputMode && !model.trim();
  const modelSource = runtimeModels.source;
  const modelSourceCanRetry = machineSourceApplies && (
    modelSource.kind === "missing_config"
    || modelSource.kind === "no_models"
    || (modelSource.kind === "error" && modelSource.retryable)
  );
  const showHeaderRescan = machineSourceApplies && (
    modelSource.kind === "live" || modelSource.kind === "loading"
  );
  const modelSourceStatusContent = machineSourceApplies
    ? builtInCatalogApplies
      ? builtInCatalogStatus(intl, modelSource, model)
      : runtimeModelSourceStatus(intl, runtime, modelSource)
    : null;
  /** The retry action. No `mt-1`: it renders inside the status sentence, and a
   *  top margin on an inline action is what used to force it onto its own row. */
  const retryAction = modelSourceCanRetry ? (
    <FieldAction
      tone="link"
      type="button"
      onClick={runtimeModels.rescan}
      disabled={rescanDisabled || runtimeModels.loading}
      className="font-bold text-black underline underline-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {intl.formatMessage({ id: "agent.runtimeModels.retry" })}
    </FieldAction>
  ) : null;
  const envVarsField = envVarsMode === "hidden" ? null : (
    <RuntimeEnvVarsField
      entries={envVarEntries}
      onChange={onEnvVarEntriesChange}
      optional={envVarsMode === "inline"}
      hint={effectiveEnvVarsHint}
    />
  );
  const commandField = envVarsMode !== "hidden" && commandSupported ? (
    <Field
      label={formatMessage({ id: "agent.runtimeConfig.claudeCommand" })}
      optional
      hint={formatMessage({ id: "agent.runtimeConfig.claudeCommandHint" })}
      labelAccessory={<ClaudeCommandInfo />}
    >
      <Input
        type="text"
        value={command}
        onChange={(event) => onCommandChange(event.target.value)}
        placeholder="claude"
      />
    </Field>
  ) : null;
  const apiProviderFields = apiUrlSupported ? (
    <Field
      label={formatMessage({ id: "agent.runtimeConfig.provider" })}
      hint={formatMessage({ id: "agent.runtimeConfig.providerHint" })}
    >
      <RuntimeSelectControl
        value={providerMode}
        onValueChange={(next) => {
          const nextMode = next as RuntimeProviderMode;
          onProviderModeChange(nextMode);
          if (nextMode !== "custom") {
            onProviderApiUrlChange("");
            onProviderApiKeyChange("");
          }
        }}
        options={providerModeOptions}
        placeholder={formatMessage({ id: "agent.runtimeConfig.provider" })}
        portalContainer={selectPortalContainer}
        testId="runtime-provider-mode-select"
      />
    </Field>
  ) : null;
  const apiProviderRequiredFields = providerApiUrlRequired ? (
    <>
      {/* The error goes through the field's `error` SLOT, not a `<p>` dropped in
          beside the control.

          Same words, same colour — but a conditionally-rendered sibling has no
          height when there is nothing to say, so every field below it moved the
          moment the message appeared or cleared. That is the jump Cindy recorded:
          typing a first character into API KEY cleared its error and pulled MODEL
          up by a line. The slot is reserved whether or not it is occupied, so the
          form's height stops depending on its validity.

          It also stops us drawing our own error: `error` is what FormField and
          StableField already render, so this callsite no longer decides what an
          error looks like. */}
      <Field
        label={formatMessage({ id: "agent.runtimeConfig.apiUrl" })}
        required
        error={showValidationErrors && providerApiUrlInvalid
          ? formatMessage({ id: "agent.runtimeConfig.apiUrlInvalid" })
          : undefined}
      >
        <Input
          type="url"
          value={providerApiUrl}
          onChange={(event) => onProviderApiUrlChange(event.target.value)}
          placeholder="https://gateway.example.com"
        />
      </Field>
      <Field
        label={formatMessage({ id: "agent.runtimeConfig.apiKey" })}
        required
        error={showValidationErrors && !providerApiKey.trim()
          ? formatMessage({ id: "agent.runtimeConfig.apiKeyRequiredForCustomProvider" })
          : undefined}
      >
        <Input
          type="password"
          value={providerApiKey}
          onChange={(event) => onProviderApiKeyChange(event.target.value)}
          placeholder="sk-ant-..."
          autoComplete="off"
        />
      </Field>
    </>
  ) : null;
  const reasoningField = reasoningSupported ? (
    <Field label={formatMessage({ id: "agent.runtimeConfig.reasoning" })}>
      <RuntimeSelectControl
        value={reasoningEffort || DEFAULT_REASONING_EFFORT_SELECT_VALUE}
        onValueChange={(value) => {
          onReasoningEffortChange(
            value === DEFAULT_REASONING_EFFORT_SELECT_VALUE
              ? null
              : value as ReasoningEffort,
          );
        }}
        options={reasoningOptions}
        placeholder={formatMessage({ id: "agent.runtimeConfig.reasoning" })}
        portalContainer={selectPortalContainer}
        testId="runtime-reasoning-select"
      />
    </Field>
  ) : null;
  const fastModeField = fastModeSupported ? (
    // MODE stays the field (group) label and the option name stays on the card.
    // The structure was never the problem — the appearance was: the plain Card
    // used panel elevation (4px) and an 18px/700 title against a 14px/700
    // uppercase field label, so the nested item outranked its own section
    // heading. `variant="option"` fixes exactly that (2px shadow, matching the
    // Input beside it, and a 14px title) without collapsing the two levels.
    //
    // Do not "simplify" this by moving the option name up into the field label:
    // that was tried (29acf6fa) while the Card was gone, and when the cards came
    // back (1926886) the label was left behind, so the schema-driven sibling
    // rendered "SUPPORTS IMAGE INPUT" above a card titled "Supports image
    // input" — the same words twice.
    //
    // `adopt={false}` + the explicit `aria-labelledby` are load-bearing here.
    // StableField adopts the single interactive child and a Card counts as one,
    // so the field's id and aria would land on the Card's `<label>` and collide
    // with the id Base UI gives the checkbox's hidden input; separately the
    // checkbox would inherit the FIELD's name and be announced as "Mode" rather
    // than "Fast mode" (@Dozy, and every test stayed green through it).
    <Field
      label={formatMessage({ id: "agent.runtimeConfig.mode" })}
      adopt={false}
    >
      <Card variant="option" render={<label />}>
        <CardHeader>
          <CardLeading>
            <Checkbox
              size="md"
              checked={fastMode}
              onCheckedChange={(checked) => onFastModeChange(checked === true)}
              aria-labelledby="runtime-fast-mode-title"
            />
          </CardLeading>
          <CardTitle id="runtime-fast-mode-title">{formatMessage({ id: "agent.runtimeConfig.fastMode" })}</CardTitle>
            <CardDescription>{formatMessage({ id: "agent.runtimeConfig.fastModeDescription" })}</CardDescription>
        </CardHeader>
      </Card>
    </Field>
  ) : null;
  // Provider belongs with Runtime and Model as basic configuration — burying it
  // with the technical knobs is why Create Cindy showed only Runtime + Model.
  // Nested disclosure state is local: no caller needs to drive it.

  const providerFields = (
    <>
      {apiProviderFields}
      {apiProviderRequiredFields}
    </>
  );
  // The genuinely technical knobs. These are what "Advanced" is for.
  const technicalFields = (
    <>
      {reasoningField}
      {fastModeField}
    </>
  );
  const showAdvancedSection = technicalFieldsMode === "advanced" || envVarsMode === "advanced";

  return (
    <>
      {showRuntimeField && (
        <Field
          label={effectiveRuntimeLabel}
          required
          hint={runtimeHint}
          labelAccessory={onRescanRuntimes ? (
            <FieldAction
              tone="icon"
              type="button"
              onClick={onRescanRuntimes}
              disabled={runtimesRescanning}
              className="ml-auto text-black/40 transition-colors hover:text-black disabled:cursor-not-allowed disabled:opacity-50"
              title={formatMessage({ id: "agent.runtimeConfig.rescanRuntimesTitle" })}
              aria-label={formatMessage({ id: "agent.runtimeConfig.rescanRuntimesAria" })}
            >
              <RefreshCw size={12} className={runtimesRescanning ? "animate-spin" : ""} />
            </FieldAction>
          ) : undefined}
        >
          <RuntimeSelectControl
            value={runtime}
            onValueChange={onRuntimeChange}
            options={runtimeOptions}
            placeholder={formatMessage({ id: "common.select.placeholder" })}
            portalContainer={selectPortalContainer}
          />
        </Field>
      )}

      {schemaBacked ? (
        formDefinition ? (
          <SchemaDrivenRuntimeFields
            definition={formDefinition}
            providerId={builtInProviderMode}
            onProviderChange={(value) => onBuiltInProviderModeChange(value as BuiltInProviderMode)}
            apiKey={builtInProviderApiKey}
            onApiKeyChange={onBuiltInProviderApiKeyChange}
            baseUrl={builtInProviderBaseUrl}
            onBaseUrlChange={onBuiltInProviderBaseUrlChange}
            supportsImageInput={builtInProviderSupportsImageInput}
            onSupportsImageInputChange={onBuiltInProviderSupportsImageInputChange}
            model={model}
            persistedModel={persistedModel}
            onModelChange={onModelChange}
            reasoningEffort={reasoningEffort}
            onReasoningEffortChange={onReasoningEffortChange}
            onCustomModelModeChange={onCustomModelModeChange}
            envVarEntries={envVarEntries}
            onEnvVarEntriesChange={onEnvVarEntriesChange}
            advancedOpen={advancedOpen}
            onAdvancedOpenChange={onAdvancedOpenChange}
            portalContainer={selectPortalContainer}
            managedConnectionActive={managedConnectionActive}
            showValidationErrors={showValidationErrors}
          />
        ) : (
          <p className="border-2 border-black bg-soft-signal p-3 text-sm font-bold" data-testid="schema-runtime-unavailable">
            {formatMessage({
              id: runtimeFormUnavailableMessageId(
                formDefinitionLoading,
                formDefinitionError,
                formDefinitionErrorCode,
              ),
            })}
          </p>
        )
      ) : (
        <>

      {/* Runtime → Provider → Model are the basic three, always visible. */}
      {providerFields}

      {builtInProviderSupported && !managedConnectionActive && (
        <>
          <Field
            label={formatMessage({ id: "agent.runtimeConfig.provider" })}
            hint={formatMessage({ id: "agent.runtimeConfig.builtInProviderHint" })}
          >
            <RuntimeSelectControl
              value={builtInProviderMode}
              onValueChange={(next) => {
                onBuiltInProviderModeChange(next as BuiltInProviderMode);
                onBuiltInProviderSupportsImageInputChange(false);
              }}
              options={builtInProviderOptions}
              placeholder={formatMessage({ id: "agent.runtimeConfig.provider" })}
              portalContainer={selectPortalContainer}
            />
            {showBuiltInRequiredHint && (
              <p className="mt-1 text-xs font-bold text-brutal-orange">
                {formatMessage(
                  { id: "agent.runtimeConfig.builtInRequiredHint" },
                  { runtimeName: getRuntimeDisplayName(runtime) },
                )}
              </p>
            )}
          </Field>
          <Field
            label={formatMessage(
              { id: "agent.runtimeConfig.apiKeyForProvider" },
              { provider: getRuntimeProviderDisplayName(builtInProviderMode) },
            )}
            required
            error={showValidationErrors && !builtInProviderApiKey.trim()
              ? formatMessage(
                { id: "agent.runtimeConfig.apiKeyRequiredForProvider" },
                { provider: getRuntimeProviderDisplayName(builtInProviderMode) },
              )
              : undefined}
          >
            <Input
              type="password"
              value={builtInProviderApiKey}
              onChange={(event) => onBuiltInProviderApiKeyChange(event.target.value)}
              placeholder="sk-..."
              autoComplete="off"
            />
          </Field>
          {builtInGatewayProvider && (
            <>
              <Field
                label={formatMessage({ id: "agent.runtimeConfig.baseUrl" })}
                required
                error={showValidationErrors && builtInBaseUrlInvalid
                  ? formatMessage({ id: "agent.runtimeConfig.baseUrlInvalid" })
                  : undefined}
              >
                <Input
                  type="url"
                  value={builtInProviderBaseUrl}
                  onChange={(event) => onBuiltInProviderBaseUrlChange(event.target.value)}
                  placeholder={builtInProviderMode === "anthropic-compatible" ? "https://gateway.example.com/anthropic" : "https://gateway.example.com/v1"}
                />
              </Field>
              <Field
                label={formatMessage({ id: "agent.runtimeConfig.imageInput" })}
                hint={formatMessage({ id: "agent.runtimeConfig.imageInputHint" })}
                adopt={false}
              >
                <Card variant="option" render={<label />}>
                  <CardHeader>
                    <CardLeading>
                      <Checkbox
                        size="md"
                        checked={builtInProviderSupportsImageInput}
                        onCheckedChange={(checked) => onBuiltInProviderSupportsImageInputChange(checked === true)}
                        aria-labelledby="gateway-image-input-title"
                    data-testid="runtime-supports-image-input"
                      />
                    </CardLeading>
                    <CardTitle id="gateway-image-input-title">{formatMessage({ id: "agent.runtimeConfig.supportsImageInput" })}</CardTitle>
                  </CardHeader>
                </Card>
              </Field>
            </>
          )}
        </>
      )}

      {piProviderSupported && (
        <Field
          label={formatMessage({ id: "agent.runtimeConfig.provider" })}
          hint={formatMessage({ id: "agent.runtimeConfig.piProviderHint" })}
        >
          <RuntimeSelectControl
            value={piProviderMode}
            onValueChange={(nextValue) => {
              const next = nextValue as PiProviderMode;
              onPiProviderModeChange(next);
              if (next === PI_PROVIDER_CONFIGURED) {
                onPiProviderApiKeyChange("");
              }
            }}
            options={piProviderOptions}
            placeholder={formatMessage({ id: "agent.runtimeConfig.provider" })}
            portalContainer={selectPortalContainer}
          />
        </Field>
      )}

      {piApiKeyRequired && (
        <Field
          label={formatMessage(
            { id: "agent.runtimeConfig.apiKeyForProvider" },
            { provider: getRuntimeProviderDisplayName(piProviderMode) },
          )}
          required
          error={showValidationErrors && !piProviderApiKey.trim()
            ? formatMessage({ id: "agent.runtimeConfig.apiKeyRequiredForBuiltInProvider" })
            : undefined}
        >
          <Input
            type="password"
            value={piProviderApiKey}
            onChange={(event) => onPiProviderApiKeyChange(event.target.value)}
            placeholder="sk-..."
            autoComplete="off"
          />
        </Field>
      )}

      {/* Dynamic required per cindyz: only the modes that actually enforce a model
          value carry the marker. A static asterisk would claim the select can be
          left empty, which it cannot. */}
      <Field
        label={formatMessage({ id: "agent.runtimeConfig.model" })}
        required={customModelInputMode}
        // Was a conditional `<p>` in `belowControl`; moved to the slot for the
        // same reason as API URL/KEY above — it shifted everything under it.
        error={showValidationErrors && customModelInvalid
          ? formatMessage({ id: "agent.runtimeConfig.customModelRequired" })
          : undefined}
        labelAccessory={showHeaderRescan ? (
          <FieldAction
            tone="icon"
            type="button"
            onClick={runtimeModels.rescan}
            disabled={rescanDisabled || runtimeModels.loading}
            className="ml-auto text-black/40 hover:text-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={intl.formatMessage({ id: "agent.runtimeModels.rescan" })}
            aria-label={intl.formatMessage({ id: "agent.runtimeModels.rescan" })}
          >
            <RefreshCw size={12} className={runtimeModels.loading ? "animate-spin" : ""} />
          </FieldAction>
        ) : undefined}
        belowControl={<>
          {modelSourceStatusContent && (
            <div
              className="mt-2 border-l-2 border-black/20 pl-2 text-xs text-black/60"
              data-testid="runtime-model-source-status"
            >
              {/* The retry belongs INSIDE the sentence it acts on: "Models could
                  not be loaded from this Computer. Retry" reads as one
                  status line with a clickable tail, which is what "inline" means.
                  Previously it was a sibling of a block `<p>`, so no button size
                  could have saved it — a block element before it already forced
                  the line break. Size and position both had to change.

                  Agent Details used to render this stacked instead; both pages
                  now share the inline form. */}
              <p>
                {modelSourceStatusContent}
                {retryAction ? <>{" "}{retryAction}</> : null}
              </p>
            </div>
          )}
          {selectedModelSuggestionOnly && (
            <p className="mt-1.5 text-xs text-black/50">
              {formatMessage({ id: "agent.runtimeConfig.modelSuggestionOnly" })}
            </p>
          )}
        </>}
      >
        {builtInGatewayProvider ? null : (
          <RuntimeSelectControl
            value={customModelMode ? CUSTOM_MODEL_SELECT_VALUE : model}
            onValueChange={(next) => {
              if (next === CUSTOM_MODEL_SELECT_VALUE) {
                onCustomModelModeChange(true);
                onModelChange("");
                return;
              }
              onCustomModelModeChange(false);
              onModelChange(next);
            }}
            options={modelSelectOptions}
            placeholder={formatMessage({ id: "agent.runtimeConfig.model" })}
            portalContainer={selectPortalContainer}
          />
        )}
        {customModelSupported && customModelInputMode && (
          /* `data-field-adopt` and no wrapping <div>: this Input is the field's
             VALUE control, and the Select beside it only picks the mode. Wrapped
             in a div it was not even a adoption candidate, so the field adopted
             the Select and marked THAT invalid while this box — the one the error
             is about — announced itself as fine (@Dozy, review of H=b396d486).
             The spacing moves onto the Input; a wrapper is not needed for it. */
          <Input
            data-field-adopt
            className="mt-2"
            type="text"
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
            placeholder={formatMessage({
              id: builtInGatewayProvider
                ? "agent.runtimeConfig.gatewayModelId"
                : runtime === "claude"
                  ? "agent.runtimeConfig.customModelName"
                  : "agent.runtimeConfig.customModelId",
            })}
          />
        )}
      </Field>

      {technicalFieldsMode === "inline" && technicalFields}

      {/* Two levels of disclosure, not one. "More" is the ordinary escape hatch —
          tuning you might reasonably want. "Advanced" sits one level deeper inside
          it and holds what can break the agent if you get it wrong (a custom launch
          command, raw env vars). Calling the outer one "Advanced", as it used to be,
          warned people off options that are not actually dangerous. */}
      {showAdvancedSection ? (
        <div>
          <button
            type="button"
            onClick={() => onAdvancedOpenChange?.(!advancedOpen)}
            aria-expanded={advancedOpen}
            className="flex items-center gap-1 text-sm font-bold uppercase tracking-wide text-black/60 hover:text-black"
          >
            {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            {formatMessage({ id: "agent.runtimeConfig.more" })}
          </button>
          {/* One level, not two (@cindyz, 2026-09-03). The inner "Advanced" existed
              to separate what can break the agent from ordinary tuning, but both
              words only mean "more stuff" — so the nesting cost a click and did
              not carry the risk message it was there for. The risk belongs in the
              copy of the fields that carry it, not in how deeply they are
              buried. */}
          {advancedOpen && (
            <div className="mt-3 space-y-3">
              {technicalFieldsMode === "advanced" && technicalFields}
              {commandField}
              {envVarsField}
            </div>
          )}
        </div>
      ) : (
        <>
          {commandField}
          {envVarsField}
        </>
      )}
        </>
      )}
    </>
  );
}
