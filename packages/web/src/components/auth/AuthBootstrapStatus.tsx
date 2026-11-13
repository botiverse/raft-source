import { Suspense } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";

/** Auth bootstrap loading / restoring chrome (AppShell); its own module for the zh-cn i18n behavior tests. */
export function AuthBootstrapStatus({ view }: { view: "loading" | "restoring" }) {
  const { formatMessage } = useIntl();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-layer-sidebar font-display safe-top">
      <div className="text-headline text-foreground-muted">
        {view === "restoring"
          ? formatMessage({ id: "auth.bootstrap.restoringSession" })
          : formatMessage({ id: "common.loading" })}
      </div>
    </div>
  );
}

/** A landing page (pages/lazyLandingPages.ts) while its code loads: the line the auth bootstrap showed just before. */
export function Landing({ children }: { children: ReactNode }) {
  return <Suspense fallback={<AuthBootstrapStatus view="loading" />}>{children}</Suspense>;
}
