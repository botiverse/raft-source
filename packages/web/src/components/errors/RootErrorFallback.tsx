import { useIntl } from "react-intl";
import RootFallbackScroller from "./RootFallbackScroller";

export default function RootErrorFallback({
  error,
  componentStack,
}: {
  error: Error;
  componentStack?: string | null;
}) {
  const { formatMessage } = useIntl();

  return (
    <RootFallbackScroller style={{ padding: 24, fontFamily: "monospace", background: "#fff8e1" }}>
      <h1 style={{ color: "#d32f2f" }}>{formatMessage({ id: "errorBoundary.title" })}</h1>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{error.message}</pre>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, color: "#666" }}>{error.stack}</pre>
      {componentStack ? (
        <details open>
          <summary>{formatMessage({ id: "errorBoundary.componentStack" })}</summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 11, color: "#666" }}>{componentStack}</pre>
        </details>
      ) : null}
      <button
        onClick={() => window.location.reload()}
        style={{ marginTop: 16, padding: "8px 16px", cursor: "pointer" }}
      >
        {formatMessage({ id: "errorBoundary.reloadApp" })}
      </button>
    </RootFallbackScroller>
  );
}
