import { useState } from "react";
import type { FormEvent } from "react";
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
import Button from "../ui/Button";
import SetupSessionFooter from "./SetupSessionFooter";

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
            className={`border-2 border-black px-3 py-1.5 text-sm font-bold transition-shadow ${
              // Brand yellow, not the pink accent: pink is the CTA/primary-action colour
              // (the Continue button right below), and a grid of pink chips read like a
              // row of buttons competing with it.
              selected ? "bg-soft-signal shadow-brutal-sm" : "bg-white hover:shadow-brutal-sm"
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
  const [error, setError] = useState("");

  const handleSubmit = async (event: FormEvent) => {
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
  };

  return (
    <section
      className="flex w-full max-w-[620px] flex-col overflow-hidden border-2 border-black bg-white shadow-brutal"
      data-testid="server-setup-survey"
    >
      <header className="shrink-0 border-b-2 border-black px-8 pb-5 pt-7">
        <p className="font-mono text-[10px] font-bold uppercase tracking-wide text-black/55">
          {formatMessage({ id: "layout.onboarding.setupServerEyebrow" })}
        </p>
        <h1 className="mt-2 text-xl font-bold">
          {formatMessage({ id: "layout.onboarding.tellAboutYou" }, { agentName })}
        </h1>
        <p className="mt-1 text-xs leading-5 text-black/60">
          {formatMessage({ id: "layout.onboarding.surveyHint" })}
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-5 px-8 py-6" noValidate>
        {error ? <Banner intent="warning" className="font-bold">{error}</Banner> : null}

        <div>
          <p className="mb-2 text-sm font-bold text-black">
            {formatMessage({ id: "layout.onboarding.whatDescribesYou" })}
          </p>
          <OptionGrid name="role" options={SIGNUP_ROLES} value={role} onChange={setRole} />
        </div>

        <div>
          <p className="mb-2 text-sm font-bold text-black">
            {formatMessage({ id: "layout.onboarding.howHearAboutRaft" })}
          </p>
          <OptionGrid name="source" options={REFERRAL_SOURCES} value={source} onChange={setSource} />
          {source === "other" && (
            <input
              type="text"
              value={sourceOther}
              onChange={(event) => setSourceOther(event.target.value)}
              className="input-brutal mt-2 w-full p-2 text-sm"
              placeholder={formatMessage({ id: "layout.onboarding.referralOtherPlaceholder" })}
              maxLength={200}
              aria-label={formatMessage({ id: "layout.onboarding.referralGroupAria" })}
              data-testid="signup-source-other-input"
            />
          )}
        </div>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SetupSessionFooter disabled={loading} />
          <Button
            type="submit"
            disabled={loading || !role || !source}
            size="lg"
            tone="pink"
            className="w-full sm:w-auto"
            data-testid="server-setup-survey-continue"
          >
            {loading
              ? formatMessage({ id: "layout.onboarding.savingLabel" })
              : formatMessage({ id: "layout.onboarding.continue" })}
          </Button>
        </div>
      </form>
    </section>
  );
}
