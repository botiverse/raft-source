import ServerCreatePreview from "../components/auth/ServerCreatePreview";
import { SCRIM_CLASS } from "../components/ui/scrim";
import ServerSetupDisplayStyleStep from "../components/onboarding/ServerSetupDisplayStyleStep";
import ServerSetupHandoffStep from "../components/onboarding/ServerSetupHandoffStep";
import ServerSetupSurveyStep from "../components/onboarding/ServerSetupSurveyStep";
import ServerSetupUpgradeStep from "../components/onboarding/ServerSetupUpgradeStep";

function ignorePreviewAction() {}

/** Dev-only: the setup steps after Create Cindy, `?step=survey|upgrade|display-style|handoff`. */
export default function DisplayStylePreviewPage() {
  const step = new URLSearchParams(window.location.search).get("step") ?? "display-style";
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-layer-sidebar font-display">
      <div className="absolute inset-0">
        <ServerCreatePreview serverName="Cindy's pricing team" serverSlug="cindys-pricing-team" />
      </div>
      <div className={`absolute inset-0 ${SCRIM_CLASS}`} aria-hidden="true" />
      <div className="absolute inset-0 flex items-center justify-center p-4 sm:px-8 sm:py-7 lg:px-[120px] lg:py-14">
        {step === "survey" ? (
          <ServerSetupSurveyStep onDone={ignorePreviewAction} />
        ) : step === "upgrade" ? (
          <ServerSetupUpgradeStep serverId="preview" serverSlug="cindys-pricing-team" onDone={ignorePreviewAction} />
        ) : step === "handoff" ? (
          <ServerSetupHandoffStep serverId="preview" onDone={ignorePreviewAction} />
        ) : (
          <ServerSetupDisplayStyleStep onDone={ignorePreviewAction} />
        )}
      </div>
    </div>
  );
}
