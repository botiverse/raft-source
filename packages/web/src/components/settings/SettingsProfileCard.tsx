import type { ReactNode } from "react";
import { Card, Separator } from "@botiverse/raft-ui";
import Tooltip from "../ui/Tooltip";

type SettingsProfileCardProps = {
  avatar: ReactNode;
  title: string;
  subtitle: string;
  children: ReactNode;
  testId?: string;
};

/**
 * Shared identity card for Account and Server Profile settings.
 *
 * The shell owns only presentation: avatar placement, identity typography,
 * and the divided field stack. Each settings surface keeps its own form,
 * permissions, validation, and save lifecycle inside `children`.
 */
export default function SettingsProfileCard({
  avatar,
  title,
  subtitle,
  children,
  testId,
}: SettingsProfileCardProps) {
  return (
    <Card
      data-testid={testId}
      className="stack-y-4 p-4"
    >
      <div className="flex items-start gap-4">
        <div className="flex size-16 shrink-0 items-center justify-center">
          {avatar}
        </div>

        <div className="min-w-0 flex-1 pt-2">
          <Tooltip content={title}>
          <div
            className="min-w-0 truncate text-headline text-foreground"
          >
            {title}
          </div>
          </Tooltip>
          <Tooltip content={subtitle}>
          <div className="mt-0.5 truncate font-mono text-mono-code text-foreground-muted">
            {subtitle}
          </div>
          </Tooltip>
        </div>
      </div>

      <div className="stack-y-3">
        <Separator className="mb-4" />
        {children}
      </div>
    </Card>
  );
}
