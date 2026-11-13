import { useCallback, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import {
  REFERRAL_SOURCES,
  SIGNUP_ROLES,
} from "@botiverse/raft-shared";
import type {
  ReferralSourceId,
  SignupRoleId,
} from "@botiverse/raft-shared";
import { useAuthStore } from "../../store/authStore";
import Banner from "../ui/Banner";
import { Button, Input } from "@botiverse/raft-ui";
import SetupSessionFooter from "./SetupSessionFooter";
import SetupStepFrame from "./SetupStepFrame";

/**
 * Asked once, immediately after Cindy is created and immediately before the handoff.
 *
 * The position is the point. These answers are for Cindy: the role is passed into
 * her briefing so she pitches Raft to a tech lead differently than to a founder.
 * Asking here, one screen before "Let's go", is what makes that legible. Asked back
 * at signup it would just read as a toll booth.
 *
 * "How did you hear about Raft" is not a new question. It writes `referralSource`,
 * which has always existed and is written by the same PATCH /api/auth/me. The
 * owner-onboarding modal asks it later only when it is still unanswered, so filling
 * it here simply means it is not asked twice.
 */
function OptionGrid<T extends string>({
  name,
  options,
  value,
  onChange,
}: {
  name: string;
  options: ReadonlyArray<{ id: T; label: string }>;
  value: T | null;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={name}>
      {options.map((option) => {
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.id)}
            className={`h-8 rounded-control border-[1.5px] px-3 text-footnote font-bold outline-none focus-visible:shadow-focus ${
              // Yellow = what you selected (DS rule 4), as a sticker: ink edge, ink
              // type. Not the pink accent: pink is the one primary action (the
              // Continue button right below), and a grid of pink chips read like a
              // row of buttons competing with it.
              selected
                ? "border-sticker-ink bg-selected text-sticker-ink hover:overlay-sticker-medium active:overlay-sticker-medium"
                : "border-line-strong bg-layer-card text-foreground hover:overlay-medium active:overlay-medium"
            }`}
            data-testid={`signup-${name}-${option.id}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default function ServerSetupSurveyStep({
  agentName = "Cindy",
  onDone,
}: {
  agentName?: string;
  onDone: () => void;
}) {
  const loading = useAuthStore((state) => state.loading);
  // Display-language (react-intl), layout namespace.
  const { formatMessage } = useIntl();
  const updateProfile = useAuthStore((state) => state.updateProfile);
  const [role, setRole] = useState<SignupRoleId | null>(null);
  const [source, setSource] = useState<ReferralSourceId | null>(null);
  const [sourceOther, setSourceOther] = useState("");
  const handleSourceOtherChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSourceOther(event.target.value);
  }, []);
  const [error, setError] = useState("");

  const handleSubmit = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!role || !source) return;
    setError("");
    try {
      // Same endpoint that has always recorded the referral source. Sending the role
      // with it is what closes the survey gate, so the two cannot land apart.
      // Saves the answers only. Cindy is briefed on "Let's go", one screen later, so
      // she is not talking to an empty room while a modal is still up.
      await updateProfile({
        signupRole: role,
        referralSource: source,
        referralSourceOther: source === "other" ? sourceOther.trim() : undefined,
      });
      onDone();
    } catch {
      setError(formatMessage({ id: "layout.onboarding.saveAnswersFailed" }));
    }
  }, [formatMessage, onDone, role, source, sourceOther, updateProfile]);

  return (
    <SetupStepFrame
      testId="server-setup-survey"
      eyebrow={formatMessage({ id: "layout.onboarding.setupServerEyebrow" })}
      title={formatMessage({ id: "layout.onboarding.tellAboutYou" }, { agentName })}
      hint={formatMessage({ id: "layout.onboarding.surveyHint" })}
      onSubmit={handleSubmit}
      bodyClassName="stack-y-5"
      footer={
        <>
          <SetupSessionFooter disabled={loading} />
          <Button
            type="submit"
            disabled={loading || !role || !source}
            size="lg"
            variant="accent"
            className="w-full sm:w-auto"
            data-testid="server-setup-survey-continue"
          >
            {loading
              ? formatMessage({ id: "layout.onboarding.savingLabel" })
              : formatMessage({ id: "layout.onboarding.continue" })}
          </Button>
        </>
      }
    >
      {error ? <Banner intent="warning">{error}</Banner> : null}

      <div>
        <p className="mb-2 text-footnote font-bold text-foreground">
          {formatMessage({ id: "layout.onboarding.whatDescribesYou" })}
        </p>
        <OptionGrid name="role" options={SIGNUP_ROLES} value={role} onChange={setRole} />
      </div>

      <div>
        <p className="mb-2 text-footnote font-bold text-foreground">
          {formatMessage({ id: "layout.onboarding.howHearAboutRaft" })}
        </p>
        <OptionGrid name="source" options={REFERRAL_SOURCES} value={source} onChange={setSource} />
        {source === "other" && (
          <Input
            type="text"
            value={sourceOther}
            onChange={handleSourceOtherChange}
            className="mt-2 w-full"
            placeholder={formatMessage({ id: "layout.onboarding.referralOtherPlaceholder" })}
            maxLength={200}
            aria-label={formatMessage({ id: "layout.onboarding.referralGroupAria" })}
            data-testid="signup-source-other-input"
          />
        )}
      </div>
    </SetupStepFrame>
  );
}
