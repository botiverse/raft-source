import { useIntl } from "react-intl";
import CopyButton from "../ui/CopyButton";
import CopyIconButton from "../ui/CopyIconButton";

/**
 * "Trace ID a1b2c3d4…" with a copy button, under an error the app shows, so a
 * user can send us the id and we find the request end to end (#proj-o11y:#18).
 * The note shows the first 8 hex digits; the button copies all 32. It uses the
 * app's one copy control (ui/CopyButton + CopyIconButton, as code blocks do), so
 * copying looks and behaves the same everywhere.
 */
export function TraceIdNote({
  traceId,
  surface = "light",
  className = "",
}: {
  traceId: string;
  /** `dark` on the toast HUD, `light` on paper. */
  surface?: "light" | "dark";
  className?: string;
}) {
  const { formatMessage } = useIntl();
  const tone = surface === "dark" ? "text-foreground-on-hud/70" : "text-foreground-hint";
  return (
    <span
      className={`group inline-flex items-center gap-1 text-footnote ${tone} ${className}`}
      data-testid="trace-id-note"
    >
      <span>{formatMessage({ id: "errors.traceId.label" })}</span>
      <code className="font-mono" data-testid="trace-id-note-value" title={traceId}>
        {traceId.slice(0, 8)}…
      </code>
      <CopyButton text={traceId} resetKey={traceId}>
        {({ copied, disabled, onClick, onMouseDown }) => (
          <CopyIconButton
            onClick={onClick}
            onMouseDown={onMouseDown}
            disabled={disabled}
            copied={copied}
            copiedLabel={formatMessage({ id: "errors.traceId.copied" })}
            copyLabel={formatMessage({ id: "errors.traceId.copy" })}
            surface={surface}
            // The HUD copy control is hidden until hover elsewhere; here it must always show.
            className={surface === "dark" && !copied ? "!text-foreground-on-hud/70 hover:!text-foreground-on-hud" : ""}
            data-testid="trace-id-note-copy"
          />
        )}
      </CopyButton>
    </span>
  );
}
