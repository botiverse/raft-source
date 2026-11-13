import { useCallback } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import { Button, Input } from "@botiverse/raft-ui";
import { Trash2 } from "lucide-react";

export type EnvVarEntry = { key: string; value: string };

export function EnvVarEntryRow({
  index,
  entry,
  onChange,
  onRemove,
}: {
  index: number;
  entry: EnvVarEntry;
  onChange: (index: number, patch: Partial<EnvVarEntry>) => void;
  onRemove: (index: number) => void;
}) {
  const { formatMessage } = useIntl();
  const handleKeyChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => onChange(index, { key: e.target.value }),
    [onChange, index],
  );
  const handleValueChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => onChange(index, { value: e.target.value }),
    [onChange, index],
  );
  const handleRemove = useCallback(() => onRemove(index), [onRemove, index]);
  // A key/value row: raft-ui draws both inputs as DS fields (44px, 1.5px ink
  // line); the page only sets their widths. Removing a row is recoverable, so
  // the remove action is a ghost icon button, not the red destructive sticker.
  return (
    <div className="flex items-center gap-2">
      <Input
        type="text"
        value={entry.key}
        onChange={handleKeyChange}
        className="w-1/3 min-w-0"
        placeholder={formatMessage({ id: "agent.runtimeConfig.envVarName" })}
      />
      <span className="font-mono text-mono-code text-foreground-hint">=</span>
      <Input
        type="text"
        value={entry.value}
        onChange={handleValueChange}
        className="min-w-0 flex-1"
        placeholder={formatMessage({ id: "agent.runtimeConfig.envVarFallback" })}
      />
      <Button variant="ghost" size="icon-md"
        type="button"
        onClick={handleRemove}
        aria-label={formatMessage({ id: "agent.runtimeConfig.removeEnvVar" })}
      >
        <Trash2 size={14} aria-hidden="true" />
      </Button>
    </div>
  );
}
