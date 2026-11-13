import { Plus, Trash2 } from "lucide-react";
import { useCallback, useId } from "react";
import type { ChangeEvent, HTMLInputTypeAttribute } from "react";
import { useIntl } from "react-intl";
import { Button, Field, Input } from "@botiverse/raft-ui";

export function KeyValueInputRow({
  keyValue,
  value,
  onKeyChange,
  onValueChange,
  onRemove,
  keyPlaceholder,
  valuePlaceholder,
  valueType = "text",
  keyRequired = false,
  valueRequired = false,
  keyLabel,
  valueLabel,
  removeLabel,
}: {
  keyValue: string;
  value: string;
  onKeyChange: (value: string) => void;
  onValueChange: (value: string) => void;
  onRemove: () => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  valueType?: HTMLInputTypeAttribute;
  keyRequired?: boolean;
  valueRequired?: boolean;
  keyLabel?: string;
  valueLabel?: string;
  removeLabel?: string;
}) {
  const { formatMessage } = useIntl();
  const resolvedKeyPlaceholder = keyPlaceholder ?? formatMessage({ id: "ui.keyValue.keyPlaceholder" });
  const resolvedValuePlaceholder = valuePlaceholder ?? formatMessage({ id: "ui.keyValue.valuePlaceholder" });
  const resolvedKeyLabel = keyLabel ?? formatMessage({ id: "ui.keyValue.keyLabel" });
  const resolvedValueLabel = valueLabel ?? formatMessage({ id: "ui.keyValue.valueLabel" });
  const resolvedRemoveLabel = removeLabel ?? formatMessage({ id: "ui.keyValue.removeRow" });

  /*
   * Each input sits in its OWN `Field`, rendered with `display: contents` so it
   * adds no layout.
   *
   * That isolation is what makes the pair addressable. Base UI's Field context
   * hands every Input beneath it the SAME control id and the SAME
   * `aria-labelledby` — so four inputs in an env-vars list all answered to one
   * id, and each announced as the outer field's label ("Environment Variables")
   * instead of "Environment variable name" / "Value for RAFT_PROFILE". An
   * inherited `aria-labelledby` also outranks `aria-label`, so labelling them
   * directly did not help while they shared a context.
   *
   * A nested Field gives each input its own id and no inherited label, which is
   * why `aria-label` works here again.
   * (Found in review by @Dozy on PR #7010.)
   */
  const rowId = useId();
  const handleKeyChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onKeyChange(event.target.value),
    [onKeyChange],
  );
  const handleValueChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onValueChange(event.target.value),
    [onValueChange],
  );

  return (
    <div className="flex items-center gap-2">
      <Field className="contents">
        <Input id={`${rowId}-key`} required={keyRequired} aria-label={resolvedKeyLabel} type="text" value={keyValue} onChange={handleKeyChange} className="w-1/3 min-w-0" placeholder={resolvedKeyPlaceholder} />
      </Field>
      {/* The `=` is machine syntax: Space Mono, ink-3. */}
      <span className="font-mono text-mono-code text-foreground-hint">=</span>
      <Field className="contents">
        <Input id={`${rowId}-value`} required={valueRequired} aria-label={resolvedValueLabel} type={valueType} value={value} onChange={handleValueChange} className="min-w-0 flex-1" placeholder={resolvedValuePlaceholder} />
      </Field>
      {/* Removing an unsaved row is reversible (nothing is written until the
          form saves), so it is a quiet ghost icon button, not the red sticker
          the DS keeps for irreversible consequences. */}
      <Button type="button" size="icon-md" variant="ghost" onClick={onRemove} aria-label={resolvedRemoveLabel} className="shrink-0">
        <Trash2 size={16} />
      </Button>
    </div>
  );
}

/**
 * No colour override on the Button.
 *
 * `variant="ghost"` already carries the themed treatment (ink text, the
 * pressed wash on hover); a literal colour here would stop the control from
 * following the theme. `size="md"` is raft-ui's 32px text button.
 */
export function KeyValueAddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" size="md" variant="ghost" onClick={onClick}>
      <Plus size={16} />
      {label}
    </Button>
  );
}
