import { useCallback, useId, useLayoutEffect, useMemo, useState } from "react";
import type { CSSProperties, ChangeEvent, FormEvent, KeyboardEvent } from "react";
import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { X } from "lucide-react";
import { REFERRAL_SOURCES, currentTimeMs, isReferralSourceId } from "@botiverse/raft-shared";
import type { ReferralSourceId } from "@botiverse/raft-shared";
import { Button, Card, CardContent, CardFooter, CardHeader, CardTitle, Input, RadioGroup, RadioGroupItem, ScrollArea } from "@botiverse/raft-ui";
import { getEmbedMode } from "../../embed";
import { useAnnouncementStore } from "../../store/announcementStore";
import { useAuthStore } from "../../store/authStore";
import { useOnboardingAnnouncementGateStore } from "../../store/onboardingAnnouncementGateStore";
import { REFERRAL_SOURCE_PROMPT_FEATURE_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";
import { useOnboardingDisplayStylePending } from "../../utils/onboardingDisplayStyle";
import { toastViewportNoticeMoved, useToastViewportBottom, useToastViewportNotice } from "../toastViewportBottom";
import Banner from "../ui/Banner";
import {
  REFERRAL_SOURCE_OTHER_MAX_LENGTH,
  REFERRAL_SOURCE_SKIP_FIELDS,
  referralSourceAnswerFields,
  shouldShowReferralSourcePrompt,
  useReferralSourcePromptSession,
} from "./referralSourcePromptRule";
import { isAgentActivityPath, isServerSettingsPath } from "./ServerSetupProjectionGate";
import { REFERRAL_SOURCE_LABEL_ID } from "./referralSourceLabels";

/** idle: waiting for a choice; submitting / skipping: that PATCH is out; failed: the last PATCH did not land. */
type PromptStatus = "idle" | "submitting" | "skipping" | "failed";

// Where a floating notice goes (FloatingUpdateBanner, Raft DS › Toast › Where it
// appears): 16px above whatever holds the bottom of the page, which
// toastViewportBottom measures: the composer (or the bar in its place), a
// phone's tab bar, the on-screen keyboard; never under the home indicator. So
// it covers none of them. The trailing corner from `sm` up, centred on a phone.
// z-app, as that banner and the setup resume bar: over the page, under every
// popup, dialog and toast (raft-ui layer order).
const PROMPT_PLACE =
  "pointer-events-none fixed inset-x-0 z-app flex justify-center px-3 sm:justify-end sm:px-4 bottom-[calc(max(var(--toast-viewport-bottom,0px),env(safe-area-inset-bottom))+1rem)]";
// Never taller than the room above that floor: the options scroll inside.
const PROMPT_CARD =
  "pointer-events-auto w-full max-w-[400px] shadow-float max-h-[min(32rem,calc(100dvh-max(var(--toast-viewport-bottom,0px),env(safe-area-inset-bottom))-2rem-env(safe-area-inset-top)))]";

function ReferralSourcePromptCard({ userId }: { userId: string }) {
  const { formatMessage } = useIntl();
  const updateProfile = useAuthStore((state) => state.updateProfile);
  const dismiss = useReferralSourcePromptSession((state) => state.dismiss);
  const titleId = useId();
  const [status, setStatus] = useState<PromptStatus>("idle");
  const [source, setSource] = useState<ReferralSourceId | null>(null);
  const [sourceOther, setSourceOther] = useState("");
  const saving = status === "submitting" || status === "skipping";
  // Its own place among the page's floors; a toast shown with it stacks above it.
  const noticeRef = useToastViewportNotice();
  const viewportBottom = useToastViewportBottom(false, false);
  const placeStyle = useMemo(
    () => (viewportBottom === null ? undefined : ({ "--toast-viewport-bottom": `${viewportBottom}px` } as CSSProperties)),
    [viewportBottom],
  );
  // Synchronising with the toast viewport (outside React): it moved without resizing.
  useLayoutEffect(() => toastViewportNoticeMoved(), [viewportBottom]);

  const handleSourceChange = useCallback((next: unknown) => {
    if (!isReferralSourceId(next)) return;
    setSource(next);
    // A new choice is a new attempt: the last failure no longer describes it.
    setStatus((current) => (current === "failed" ? "idle" : current));
  }, []);
  const handleSourceOtherChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSourceOther(event.target.value);
  }, []);

  // Both write the user record through the existing PATCH /api/auth/me; its
  // answer replaces the auth store's user, which is what takes this card down
  // (here and, from the next profile read, on every other device).
  const save = useCallback(async (action: "submitting" | "skipping", fields: Parameters<typeof updateProfile>[0]) => {
    setStatus(action);
    try {
      await updateProfile(fields);
    } catch {
      setStatus("failed");
    }
  }, [updateProfile]);

  const handleSubmit = useCallback((event: FormEvent) => {
    event.preventDefault();
    if (!source || saving) return;
    void save("submitting", referralSourceAnswerFields(source, sourceOther));
  }, [save, saving, source, sourceOther]);

  const handleSkip = useCallback(() => {
    if (saving) return;
    void save("skipping", REFERRAL_SOURCE_SKIP_FIELDS);
  }, [save, saving]);

  const handleNotNow = useCallback(() => dismiss(userId), [dismiss, userId]);

  // Escape (and the ×) means "not now", not "never": it closes the card for
  // this page's life and writes nothing. Escape is the reflex for getting any
  // overlay out of the way, often before it was read, so recording it as a
  // skip would silence the question for good on the strength of a keypress
  // that was not an answer. "Skip" is the explicit, labelled way to decline.
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.stopPropagation();
    dismiss(userId);
  }, [dismiss, userId]);

  const title = formatMessage({ id: "layout.onboarding.howHearAboutRaft" });
  return (
    // Not a modal: no backdrop, no focus trap and no focus steal, so chat stays
    // usable underneath. So not a dialog either (one that never takes focus is
    // announced to nobody): a labelled complementary region, reached with Tab
    // or a screen reader's landmarks, and announced once by the status line
    // ReferralSourcePrompt keeps beside it.
    <div ref={noticeRef} className={PROMPT_PLACE} style={placeStyle} data-testid="referral-source-prompt-place">
      <Card
        render={<aside aria-labelledby={titleId} />}
        onKeyDown={handleKeyDown}
        className={PROMPT_CARD}
        data-testid="referral-source-prompt"
      >
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <CardHeader className="flex shrink-0 items-start justify-between gap-2 p-4 pb-0">
            <CardTitle id={titleId} className="min-w-0 break-words">{title}</CardTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon-md"
              className="-my-1 -me-1 shrink-0 text-foreground-muted [&_svg]:size-3.5"
              aria-label={formatMessage({ id: "layout.referralPrompt.notNow" })}
              onClick={handleNotNow}
              data-testid="referral-source-prompt-close"
            >
              <X aria-hidden />
            </Button>
          </CardHeader>
          {/* The part that scrolls when the window is short (a phone in landscape, the keyboard up). */}
          <CardContent render={<ScrollArea role="group" aria-labelledby={titleId} />} className="min-h-0 stack-y-3 px-4 pt-3 pb-4">
            {status === "failed" ? (
              <Banner intent="warning">{formatMessage({ id: "layout.onboarding.saveAnswersFailed" })}</Banner>
            ) : null}
            <RadioGroup value={source ?? ""} onValueChange={handleSourceChange} aria-labelledby={titleId} disabled={saving} className="gap-0">
              {REFERRAL_SOURCES.map((option) => (
                <label key={option.id} className="flex min-h-8 items-center gap-3 py-1 text-callout text-foreground">
                  <RadioGroupItem value={option.id} className="shrink-0" data-testid={`referral-source-prompt-option-${option.id}`} />
                  <span className="min-w-0">{formatMessage({ id: REFERRAL_SOURCE_LABEL_ID[option.id] })}</span>
                </label>
              ))}
            </RadioGroup>
            {source === "other" ? (
              <Input
                type="text"
                value={sourceOther}
                onChange={handleSourceOtherChange}
                disabled={saving}
                className="w-full"
                placeholder={formatMessage({ id: "layout.onboarding.referralOtherPlaceholder" })}
                maxLength={REFERRAL_SOURCE_OTHER_MAX_LENGTH}
                aria-label={formatMessage({ id: "layout.onboarding.referralGroupAria" })}
                data-testid="referral-source-prompt-other"
              />
            ) : null}
          </CardContent>
          <CardFooter className="shrink-0 justify-end gap-2 border-0 px-4 pt-0 pb-4">
            <Button type="button" variant="ghost" disabled={saving} onClick={handleSkip} data-testid="referral-source-prompt-skip">
              {formatMessage({ id: "layout.referralPrompt.skip" })}
            </Button>
            <Button type="submit" variant="accent" disabled={saving || !source} data-testid="referral-source-prompt-submit">
              {status === "submitting"
                ? formatMessage({ id: "layout.onboarding.savingLabel" })
                : formatMessage({ id: "layout.referralPrompt.submit" })}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

/**
 * "How did you hear about Raft?" for a new account that the owner setup survey
 * never reached (flag referral_source_prompt_v0; the rule is
 * shouldShowReferralSourcePrompt). Mounted by MainLayout, so it exists only
 * inside a server: never on sign-up, a public page or the mobile app's
 * standalone onboarding page, none of which render that layout.
 */
export function ReferralSourcePrompt() {
  const { formatMessage } = useIntl();
  const user = useAuthStore((state) => state.user);
  const server = useServerStore((state) => state.current);
  const flagEnabled = useServerFeatureFlag(REFERRAL_SOURCE_PROMPT_FEATURE_FLAG_KEY).enabled;
  const setupGate = useOnboardingAnnouncementGateStore((state) => (
    server ? state.byServerId[server.id] ?? "pending" : "pending"
  ));
  const sawOnboardingThisSession = useOnboardingAnnouncementGateStore((state) => (
    server ? state.sawOnboardingServerIds.includes(server.id) : false
  ));
  const displayStylePending = useOnboardingDisplayStylePending();
  // Already narrowed to this server by the store. A cheap, slightly wide
  // reading: an announcement held back for its own reasons (a sidebar one off
  // the chat pages) holds the card too, until it is read.
  const announcementPending = useAnnouncementStore((state) => state.pending.length > 0);
  const dismissedForUserId = useReferralSourcePromptSession((state) => state.dismissedForUserId);
  const { pathname } = useLocation();

  const show = shouldShowReferralSourcePrompt({
    flagEnabled,
    user,
    serverRole: server?.role ?? null,
    setupGate,
    sawOnboardingThisSession,
    displayStylePending,
    announcementPending,
    settingsPage: server ? isServerSettingsPath(pathname, server.slug) : false,
    embedded: getEmbedMode().embedded,
    agentActivityPage: server ? isAgentActivityPath(pathname, server.slug) : false,
    dismissedForUserId,
    nowMs: currentTimeMs(),
  });
  // Nothing at all for everyone the flag or the account rules out.
  if (!flagEnabled || !user) return null;
  return (
    <>
      {/* In the page before the card is, so its arrival is a change a screen
          reader announces (politely): the card itself never takes focus. */}
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="referral-source-prompt-live">
        {show ? formatMessage({ id: "layout.onboarding.howHearAboutRaft" }) : ""}
      </p>
      {/* Keyed by person: another account on this tab starts from an empty form. */}
      {show ? <ReferralSourcePromptCard key={user.id} userId={user.id} /> : null}
    </>
  );
}
