import Tooltip from "../../../components/ui/Tooltip";

export function ConnectedAppSummary({ description }: { description?: string | null }) {
  const text = description?.trim();
  if (!text) return null;
  return (
    <Tooltip content={text}>
    <div className="mt-1 line-clamp-2 break-words text-callout text-foreground-muted">
      {text}
    </div>
    </Tooltip>
  );
}
