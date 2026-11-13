import { Plus, Trash2 } from "lucide-react";
import { Button, Input } from "@botiverse/raft-ui";
import { useCallback } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";

const MAX_HEADER_NAMES = 16;

function McpHeaderNameRow({
  index,
  value,
  onChange,
  onRemove,
  canRemove,
}: {
  index: number;
  value: string;
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
  canRemove: boolean;
}) {
  const { formatMessage } = useIntl();
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onChange(index, event.target.value), [index, onChange]);
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);
  return (
    <div className="flex items-center gap-2">
      <Input
        type="text"
        value={value}
        onChange={handleChange}
        className="min-w-0 flex-1 font-mono"
        aria-label={formatMessage({ id: "settings.mcpApp.headers.nameLabel" }, { index: index + 1 })}
        placeholder={formatMessage({ id: "settings.mcpApp.headers.namePlaceholder" })}
      />
      {canRemove ? (
        <Button type="button" size="icon-md" variant="danger" onClick={handleRemove} aria-label={formatMessage({ id: "settings.mcpApp.headers.remove" }, { name: value || index + 1 })}>
          <Trash2 size={13} />
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The header NAMES an API-key App requires (names only: values belong to each Connection and are
 * entered there, write-only). Every Connection of the App must supply exactly these headers.
 */
export function McpHeaderNameList({ names, onChange }: { names: string[]; onChange: (names: string[]) => void }) {
  const { formatMessage } = useIntl();
  const handleChange = useCallback((index: number, value: string) => {
    onChange(names.map((name, current) => current === index ? value : name));
  }, [names, onChange]);
  const handleRemove = useCallback((index: number) => onChange(names.filter((_, current) => current !== index)), [names, onChange]);
  const handleAdd = useCallback(() => onChange([...names, ""]), [names, onChange]);
  return (
    <div className="stack-y-2" data-testid="mcp-header-name-list">
      <div className="text-footnote font-bold text-foreground">{formatMessage({ id: "settings.mcpApp.headers.title" })}</div>
      <p className="text-caption text-foreground-muted">{formatMessage({ id: "settings.mcpApp.headers.description" })}</p>
      {names.map((name, index) => (
        // Rows are positional: a header name is what is being edited, so it cannot be the key.
        // oxlint-disable-next-line react-doctor/no-array-index-as-key
        <McpHeaderNameRow key={index} index={index} value={name} onChange={handleChange} onRemove={handleRemove} canRemove={names.length > 1} />
      ))}
      {names.length < MAX_HEADER_NAMES ? (
        <Button type="button" size="md" variant="outline" onClick={handleAdd}>
          <Plus size={13} />
          {formatMessage({ id: "settings.mcpApp.headers.add" })}
        </Button>
      ) : null}
    </div>
  );
}
