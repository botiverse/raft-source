import { useIntl } from "react-intl";
import { InlineCode } from "@botiverse/raft-ui";
import type { MigrationErrorPresentation } from "./errors";

export function MigrationErrorContent({ presentation }: { presentation: MigrationErrorPresentation }) {
  const { formatMessage } = useIntl();
  return (
    <div className="stack-y-1.5">
      {presentation.placement ? <div className="font-semibold">{presentation.placement}</div> : null}
      <div>{presentation.message}</div>
      {presentation.issues?.length ? (
        <ul className="list-disc stack-y-1 pl-5">
          {presentation.issues.map((issue, index) => <li key={`${index}:${issue}`}>{issue}</li>)}
        </ul>
      ) : null}
      {presentation.technicalCode || presentation.diagnosticRef ? (
        <details className="text-caption text-foreground-muted">
          <summary className="font-semibold">{formatMessage({ id: "agent.detail.technicalDetails" })}</summary>
          <div className="mt-1 stack-y-0.5">
            {presentation.technicalCode ? (
              <div>
                {formatMessage({ id: "agent.detail.technicalErrorCode" })}: {" "}
                <InlineCode>{presentation.technicalCode}</InlineCode>
              </div>
            ) : null}
            {presentation.diagnosticRef ? (
              <div>
                {formatMessage({ id: "agent.detail.diagnosticReference" })}: {" "}
                <InlineCode>{presentation.diagnosticRef}</InlineCode>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  );
}
