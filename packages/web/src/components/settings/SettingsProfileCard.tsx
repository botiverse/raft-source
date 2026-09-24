import type { ReactNode } from "react";

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
    <div
      data-testid={testId}
      className="space-y-4 border-2 border-black bg-white p-4 shadow-brutal-sm"
    >
      <div className="flex items-start gap-4">
        <div className="flex size-16 shrink-0 items-center justify-center">
          {avatar}
        </div>

        <div className="min-w-0 flex-1 pt-1">
          <div
            className="min-w-0 truncate text-lg font-bold leading-tight text-black"
            title={title}
          >
            {title}
          </div>
          <div className="truncate text-sm font-mono text-black/50" title={subtitle}>
            {subtitle}
          </div>
        </div>
      </div>

      <div className="space-y-3 border-t border-black/10 pt-4">
        {children}
      </div>
    </div>
  );
}
