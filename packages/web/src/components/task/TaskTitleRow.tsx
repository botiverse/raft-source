import { Input, Button } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { Trash2 } from "lucide-react";

export function TaskTitleRow({ index, title, placeholder, removable, onChange, onRemove }: {
  index: number;
  title: string;
  placeholder: string;
  removable: boolean;
  onChange: (index: number, value: string) => void;
  onRemove: (index: number) => void;
}) {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => onChange(index, e.target.value),
    [index, onChange],
  );
  const handleRemove = useCallback(() => onRemove(index), [index, onRemove]);

  return (
    <div className="mb-2 flex items-center gap-1">
      <Input
        type="text"
        value={title}
        onChange={handleChange}
        className="w-full"
        placeholder={placeholder}
        autoFocus={index === 0}
      />
      {/* Removing a draft row is undoable typing, not an irreversible
          consequence: a borderless icon button, not the red sticker. */}
      {removable && (
        <Button size="icon-md"
          variant="ghost"
          type="button"
          onClick={handleRemove}
          className="shrink-0"
        >
          <Trash2 size={16} />
        </Button>
      )}
    </div>
  );
}
