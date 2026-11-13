import AvatarSlot from "../../../components/ui/AvatarSlot";
import type { ServerAdminSettingsPrincipal } from "../../../utils/serverAdminSettings";

export function renderPrincipalAvatar(principal: ServerAdminSettingsPrincipal, context: "list-row" | "compact-list") {
  return principal.kind === "human" ? (
    <AvatarSlot
      context={context}
      type="human"
      humanAvatarUrl={principal.avatarUrl}
      className={context === "list-row" ? "self-start" : ""}
    />
  ) : (
    <AvatarSlot
      context={context}
      type="agent"
      agentAvatarUrl={principal.avatarUrl}
      className={context === "list-row" ? "self-start" : ""}
    />
  );
}
