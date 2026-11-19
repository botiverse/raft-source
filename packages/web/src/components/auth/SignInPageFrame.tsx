/**
 * The sign-in page as App.tsx renders it (DeferredSignInPage), and its frame
 * while its code loads:
 * the sign-in page is its own chunk (docs/frontend/boot-bundle.md), and a
 * signed-out load can render before it is in (a stored session that turned
 * out gone, a chunk slower than /auth/me). Rather than the bootstrap's
 * loading line, the page's own frame: the brand bar and the open-in-app
 * strips as SignInPage has them, the card with its title, and the form's
 * space kept empty (each control there, invisible, as LoginPage lays it out),
 * so nothing moves when the page arrives. Eager and small: only the frame,
 * raft-ui and FormField, nothing of LoginPage.
 */
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { Button, Input, Separator, TextLink, TextSans } from "@botiverse/raft-ui";
import { RefreshCw } from "lucide-react";
import { loadedModule } from "../../boot/sharedModule";
import { rememberedProviderCount } from "../../hooks/useAuthProviders";
import { loadSignInPage } from "../../pages/landingPages";
import { importHandledLocally, noteChunkFailureShownInPlace, reloadIfReleaseSuperseded } from "../../utils/dynamicImportRecovery";
import { desktopPasskeySignInShown } from "../../utils/desktopPasskeySignIn";
import { OpenInAppOffers } from "../deeplinks/OpenInAppOffers";
import FormField from "../ui/FormField";
import AuthPageFrame, { AuthPageIntro } from "./AuthPageFrame";
import { reloadOntoSignInOnce } from "./signInChunkReload";
import { canUsePasskeys } from "./webauthn";
import type { LoginPageProps } from "./LoginPage";

const keep = (chunks: ReactNode) => chunks;

/** LoginPage's form, every control in place and invisible. */
function ReservedSignInForm() {
  const { formatMessage } = useIntl();
  const [providerCount] = useState(rememberedProviderCount);
  // LoginPage's "Sign in with a passkey" line (usePasskeySignIn, or Raft Desktop's).
  const [passkeyLine] = useState(() => canUsePasskeys() || desktopPasskeySignInShown());
  return (
    <div aria-hidden="true" inert className="invisible" data-testid="sign-in-frame-reserved">
      <div className="stack-y-4 md:pointer-fine:stack-y-3">
        <FormField label={formatMessage({ id: "pages.login.emailLabel" })}>
          <Input type="email" tabIndex={-1} />
        </FormField>
        <FormField
          label={formatMessage({ id: "pages.login.passwordLabel" })}
          labelAction={<TextLink className="text-footnote" tabIndex={-1}>{formatMessage({ id: "pages.login.forgotPassword" })}</TextLink>}
        >
          <Input type="password" tabIndex={-1} />
        </FormField>
        <Button type="button" size="xl" variant="accent" className="w-full" tabIndex={-1}>
          {formatMessage({ id: "pages.login.submit" })}
        </Button>
      </div>
      {providerCount > 0 && (
        <>
          <Separator className="my-1">{formatMessage({ id: "pages.login.or" })}</Separator>
          <div className="stack-y-2">
            {Array.from({ length: providerCount }, (_, index) => (
              <Button key={index} type="button" variant="outline" size="lg" className="w-full gap-3" tabIndex={-1} />
            ))}
          </div>
        </>
      )}
      {passkeyLine && (
        <div className="mt-4 text-center">
          <TextLink className="text-footnote" tabIndex={-1}>{formatMessage({ id: "auth.passkey.signIn" })}</TextLink>
        </div>
      )}
      <TextSans size="small" className="mt-4 text-center">
        {formatMessage({ id: "pages.login.noAccountPrompt" }, { create: keep })}
      </TextSans>
      <TextSans size="caption" className="mt-6 text-center">
        {formatMessage({ id: "pages.login.legalAgreement" }, { terms: keep, privacy: keep })}
      </TextSans>
    </div>
  );
}

/** The fallback of the lazy SignInPage: its frame, title and `purpose`, the form's space empty. */
export function SignInPageFrame({ purpose, children }: { purpose?: string; children?: ReactNode }) {
  const { formatMessage } = useIntl();
  const { pathname } = useLocation();
  // As SignInPage: the open-in-app offers at a workspace address.
  const offers = pathname.startsWith("/s/");
  return (
    <AuthPageFrame
      topStrip={offers ? <OpenInAppOffers slot="top" /> : undefined}
      bottomStrip={offers ? <OpenInAppOffers slot="bottom" /> : undefined}
    >
      <div className="w-full" aria-busy="true" data-testid="sign-in-frame">
        <AuthPageIntro
          title={formatMessage({ id: "pages.login.title" })}
          description={purpose ? <span>{purpose}</span> : undefined}
        />
        {children ?? <ReservedSignInForm />}
      </div>
    </AuthPageFrame>
  );
}

/** The fallback of the lazy second sign-in step: the same card under its title. */
export function SecondFactorStepFrame() {
  const { formatMessage } = useIntl();
  return (
    <AuthPageFrame>
      <div className="w-full" aria-busy="true" data-testid="second-factor-frame">
        <AuthPageIntro title={formatMessage({ id: "auth.secondFactor.title" })} />
      </div>
    </AuthPageFrame>
  );
}

/**
 * The sign-in page's code failed to download where it was to show: most
 * likely a tab left open across a deploy, asking for a file the server no
 * longer has. The page loads again once onto the current release
 * (signInChunkReload.ts), showing the frame meanwhile; if it already did
 * lately, Try again in the card.
 */
export function SignInChunkFailed({ onRetry }: { onRetry: () => void }) {
  const { formatMessage } = useIntl();
  // Decided once, as this mounts: the reload is idempotent within the page
  // (a second render, StrictMode's included, finds it under way).
  const [gaveUp] = useState(() => !reloadOntoSignInOnce());
  if (!gaveUp) return <SignInPageFrame />;
  return (
    <SignInPageFrame>
      <div role="status" className="stack-y-4 text-center" data-testid="sign-in-chunk-failed">
        <TextSans size="small">{formatMessage({ id: "common.deferred.failedDescription" })}</TextSans>
        <Button variant="outline" size="md" onClick={onRetry} data-testid="deferred-panel-retry">
          <RefreshCw />
          {formatMessage({ id: "common.deferred.retry" })}
        </Button>
      </div>
    </SignInPageFrame>
  );
}

/**
 * The sign-in page (its own chunk, pages/landingPages.ts loadSignInPage),
 * drawn as its frame until the code is in and then as itself, in the same
 * place. Not React.lazy under Suspense: a Suspense boundary that showed its
 * fallback reveals the content only after React's fallback throttle (about
 * 300 ms), so a chunk that arrives a moment after the first render would keep
 * the frame up that long. Here the frame is this component's own render and
 * the page replaces it in the next commit after the code arrives. Code already
 * in (preloaded at boot, opened before) draws the page in the first render.
 * A failed download: SignInChunkFailed (one reload, then Try again).
 */
export function DeferredSignInPage(props: LoginPageProps) {
  const [module, setModule] = useState(() => loadedModule(loadSignInPage));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (module) return undefined;
    let live = true;
    importHandledLocally(loadSignInPage).then((loaded) => {
      if (live) setModule(loaded);
    }, (error: unknown) => {
      if (!live) return;
      noteChunkFailureShownInPlace(error);
      setFailed(true);
    });
    return () => { live = false; };
  }, [module, attempt]);
  const retry = useCallback(() => {
    // As every other in-place chunk failure (boot/lazyChunk.tsx): a newer
    // release replaces the page instead of retrying the old chunk.
    if (reloadIfReleaseSuperseded()) return;
    setFailed(false);
    setAttempt((n) => n + 1);
  }, []);
  if (module) return <module.default {...props} />;
  if (failed) return <SignInChunkFailed onRetry={retry} />;
  return <SignInPageFrame purpose={props.purpose} />;
}
