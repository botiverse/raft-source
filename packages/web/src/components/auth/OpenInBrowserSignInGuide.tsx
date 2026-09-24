import { useState } from "react";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import { CenteredCardBrandHeader } from "./CenteredCardFrame";

export default function OpenInBrowserSignInGuide({
  loginUrl,
  onBack,
}: {
  loginUrl: string;
  onBack?: () => void;
}) {
  const { formatMessage } = useIntl();
  // Holds a MessageId, not text. The default is the hint the guide shows before
  // any copy attempt — dropping it would silently remove that line.
  const [copyStatus, setCopyStatus] = useState<MessageId>("auth.openInBrowser.copyHint");

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(loginUrl);
      setCopyStatus("auth.openInBrowser.copied");
    } catch {
      setCopyStatus("auth.openInBrowser.copyFailed");
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-white font-display safe-top safe-bottom">
      <div className="flex min-h-full w-full flex-col">
        <CenteredCardBrandHeader />
        <main className="flex min-h-0 flex-1 px-5 pb-10 pt-8 sm:px-8 sm:pt-12">
          <div className="w-full max-w-lg pt-[5vh] sm:pt-[4vh]">
            <h1 className="text-[26px] font-extrabold leading-tight tracking-normal text-black sm:text-3xl">
              {formatMessage({ id: "auth.openInBrowser.title" })}
            </h1>
            <p className="mt-4 text-base leading-7 text-black/65">
              {formatMessage({ id: "auth.openInBrowser.description" })}
            </p>
            <div className="mt-7 grid gap-3 sm:flex sm:items-center">
              <a
                href={loginUrl}
                target="_blank"
                rel="noreferrer"
                className="btn-brutal w-full bg-soft-signal px-4 py-2.5 text-center text-sm sm:w-auto"
              >
                {formatMessage({ id: "auth.openInBrowser.openBrowser" })}
              </a>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="btn-brutal w-full bg-white px-4 py-2.5 text-sm sm:w-auto"
              >
                {formatMessage({ id: "auth.openInBrowser.copyLink" })}
              </button>
            </div>
            <p className="mt-4 text-sm leading-6 text-black/55">{formatMessage({ id: copyStatus })}</p>
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                className="mt-5 text-sm font-bold underline"
              >
                {formatMessage({ id: "auth.openInBrowser.backToOptions" })}
              </button>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}
