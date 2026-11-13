import { FormSection } from "@botiverse/raft-ui";
import type { ReactNode } from "react";

/**
 * One part of the app editor: raft-ui's FormSection (small heading, its
 * status as a quiet tag, and a line only where it names a consequence) with a
 * stable anchor the editor's section list scrolls to.
 */
export function ConnectedAppEditorSection({
  sectionId,
  title,
  description,
  status,
  children,
}: {
  /** An ordinary App's section id, or an MCP App's (`McpAppEditor`). */
  sectionId: string;
  title: ReactNode;
  description?: string;
  status: string;
  children: ReactNode;
}) {
  return (
    <FormSection
      id={`connected-app-editor-${sectionId}`}
      data-testid={`connected-app-editor-section-${sectionId}`}
      title={title}
      status={status}
      description={description}
    >
      {children}
    </FormSection>
  );
}
