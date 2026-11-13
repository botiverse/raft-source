// The text an app adds to agent prompts (#proj-apps task #4), shown exactly as
// agents get it: appPromptTextLines (packages/shared) does the inert rendering
// and the directory formatting for this one app. Every surface that confirms or
// reviews that text shows it through these parts, so what an admin reads is
// what agents read.
//
// Raft Design System: CodeBlock (plain, without a language) for the lines,
// wrapping instead of scrolling sideways so a reader sees every word before
// confirming (as the text attachment preview does).

import { useIntl } from "react-intl";
import { CodeBlock, CodeBlockBody, CodeBlockHeader, CodeBlockTitle } from "@botiverse/raft-ui";
import { appPromptTextLines } from "@botiverse/raft-shared";
import type { AppPromptTextFields } from "../../lib/appPromptText";

export function AppPromptTextBlock({
  fields,
  service,
  title,
  testId = "app-prompt-text",
}: {
  fields: AppPromptTextFields;
  service?: string | null;
  title?: string;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const lines = appPromptTextLines({ ...fields, service });
  if (!lines) {
    return (
      <div className="stack-y-1" data-testid={testId} data-empty="true">
        {title ? <div className="text-footnote font-semibold text-foreground">{title}</div> : null}
        <div className="text-footnote text-foreground-muted">{formatMessage({ id: "appPromptText.empty" })}</div>
      </div>
    );
  }
  return (
    <CodeBlock data-testid={testId}>
      {title ? (
        <CodeBlockHeader>
          <CodeBlockTitle>{title}</CodeBlockTitle>
        </CodeBlockHeader>
      ) : null}
      <CodeBlockBody>
        <pre className="whitespace-pre-wrap break-words" data-app-prompt-text-lines="">{lines.join("\n")}</pre>
      </CodeBlockBody>
    </CodeBlock>
  );
}

/** One install entry point's section: the heading, where the text goes, the text. */
export function AppPromptTextSection({
  fields,
  service,
  className,
}: {
  fields: AppPromptTextFields;
  service?: string | null;
  className?: string;
}) {
  const { formatMessage } = useIntl();
  return (
    <section className={className ? `stack-y-2 ${className}` : "stack-y-2"} data-testid="app-prompt-text-section">
      <div className="text-footnote font-semibold text-foreground">{formatMessage({ id: "appPromptText.title" })}</div>
      <div className="text-footnote text-foreground-muted">{formatMessage({ id: "appPromptText.installNote" })}</div>
      <AppPromptTextBlock fields={fields} service={service} />
    </section>
  );
}

/** Old and new text side by side (stacked on narrow widths). */
export function AppPromptTextComparison({
  before,
  after,
  beforeTitle,
  afterTitle,
  service,
}: {
  before: AppPromptTextFields | null;
  after: AppPromptTextFields;
  beforeTitle: string;
  afterTitle: string;
  service?: string | null;
}) {
  const { formatMessage } = useIntl();
  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="app-prompt-text-comparison">
      {before ? (
        <AppPromptTextBlock fields={before} service={service} title={beforeTitle} testId="app-prompt-text-before" />
      ) : (
        <div className="stack-y-1" data-testid="app-prompt-text-before" data-empty="true">
          <div className="text-footnote font-semibold text-foreground">{beforeTitle}</div>
          <div className="text-footnote text-foreground-muted">{formatMessage({ id: "appPromptText.noConfirmedText" })}</div>
        </div>
      )}
      <AppPromptTextBlock fields={after} service={service} title={afterTitle} testId="app-prompt-text-after" />
    </div>
  );
}
