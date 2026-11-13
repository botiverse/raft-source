import type { SocialAuthProviderId } from "../../../hooks/useAuthProviders";
import { AppleLogo, GitHubLogo, GoogleLogo } from "../../../components/icons/ProviderLogos";

export function SocialProviderIcon({ providerId }: { providerId: SocialAuthProviderId }) {
  if (providerId === "google") {
    return (
      <span className="inline-flex size-[18px] shrink-0 items-center justify-center">
        <GoogleLogo className="size-4" />
      </span>
    );
  }
  if (providerId === "apple") {
    return (
      <span className="inline-flex size-[18px] shrink-0 items-center justify-center text-foreground">
        <AppleLogo className="size-4" />
      </span>
    );
  }
  return (
    <span className="inline-flex size-[18px] shrink-0 items-center justify-center text-foreground">
      <GitHubLogo className="size-4" />
    </span>
  );
}
