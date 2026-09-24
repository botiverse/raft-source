import { useIntl } from "react-intl";
import type { SocialAuthProviderId } from "../../hooks/useAuthProviders";
import { AppleLogo, GitHubLogo, GoogleLogo } from "../icons/ProviderLogos";

const SOCIAL_BUTTON_BASE = "flex w-full items-center justify-center gap-3 border-2 border-black px-3 py-2 text-sm font-bold shadow-brutal-sm transition-all duration-100 hover:-translate-y-[1px] hover:shadow-brutal active:translate-x-[2px] active:translate-y-[2px] active:shadow-brutal-active";

export default function SocialProviderButton({
  providerId,
  label,
  onClick,
}: {
  providerId: SocialAuthProviderId;
  label: string;
  onClick: (providerId: SocialAuthProviderId) => void;
}) {
  const { formatMessage } = useIntl();
  const logo = providerId === "google"
    ? <GoogleLogo />
    : providerId === "github"
      ? <GitHubLogo />
      : <AppleLogo />;

  return (
    <button
      type="button"
      onClick={() => onClick(providerId)}
      className={`${SOCIAL_BUTTON_BASE} bg-white text-black`}
    >
      {logo}
      <span>{formatMessage({ id: "auth.social.continueWith" }, { provider: label })}</span>
    </button>
  );
}
