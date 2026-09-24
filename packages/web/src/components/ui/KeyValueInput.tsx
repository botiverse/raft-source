import { Plus, Trash2 } from "lucide-react";
import { useId } from "react";
import type { HTMLInputTypeAttribute } from "react";
import { useIntl } from "react-intl";
import { Button, Field, Input } from "raft-ui";

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

  return (
    <div className="flex items-center gap-2">
      <Field className="contents">
        <Input id={`${rowId}-key`} required={keyRequired} aria-label={resolvedKeyLabel} type="text" value={keyValue} onChange={(event) => onKeyChange(event.target.value)} className="w-1/3 min-w-0" placeholder={resolvedKeyPlaceholder} />
      </Field>
      {/* Themed, not `text-black/40`: a literal cannot follow the theme, and
          leaving one behind in the file being cleaned of them made no sense. */}
      <span className="text-foreground-muted">=</span>
      <Field className="contents">
        <Input id={`${rowId}-value`} required={valueRequired} aria-label={resolvedValueLabel} type={valueType} value={value} onChange={(event) => onValueChange(event.target.value)} className="min-w-0 flex-1" placeholder={resolvedValuePlaceholder} />
      </Field>
      <Button type="button" size="icon-xs" variant="default" onClick={onRemove} aria-label={resolvedRemoveLabel}>
        <Trash2 size={14} />
      </Button>
    </div>
  );
}

/**
 * No colour override on the Button.
 *
 * `variant="ghost"` already carries the themed treatment —
 * `text-foreground-strong`, plus `hover:border-line-strong hover:bg-fill-muted`.
 * The `text-black/60 hover:text-black` that used to sit here replaced all of it
 * with a literal, so the control could not follow the theme: exactly the defect
 * this migration exists to remove (@cindyz).
 */
export function KeyValueAddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" size="sm" variant="ghost" onClick={onClick}>
      <Plus size={14} />
      {label}
    </Button>
  );
}
