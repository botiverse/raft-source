import { ChevronDown, Globe, Plug, Plus } from "lucide-react";
import { Button, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@botiverse/raft-ui";
import { FitToolbarButton } from "@botiverse/raft-ui/wip";
import { useIntl } from "react-intl";
import { LIST_TOOLBAR_STEP } from "../../ui/listToolbar";

/**
 * "+ Add App": what kind of App to add. On the Apps page (`inToolbar`) it is
 * the primary action at the end of its toolbar, + once the toolbar gives way
 * (Raft DS › The toolbar over a list, step 4); in Settings it is the
 * section header's button. "Create a Raft App"
 * opens the Raft App form; "Add a Custom MCP App" opens the MCP App editor on a server URL. The
 * MCP Apps Raft maintains are installed from the Marketplace, not here.
 */
export function RegisterAppMenu({
  onRegisterOwnService,
  onRegisterMcpServer,
  inToolbar = false,
}: {
  onRegisterOwnService: () => void;
  onRegisterMcpServer: () => void;
  /** An item of the Apps page's FitToolbar. */
  inToolbar?: boolean;
}) {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: "settings.connectedApps.addApp" });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={inToolbar ? (
          <FitToolbarButton variant="primary" icon={<Plus />} plusOrder={LIST_TOOLBAR_STEP.primaryPlus} data-testid="register-app-menu-trigger">
            {label}
          </FitToolbarButton>
        ) : (
          <Button variant="accent" size="md" type="button" className="inline-flex items-center gap-1.5" data-testid="register-app-menu-trigger">
            <Plus size={14} />
            {label}
            <ChevronDown size={14} />
          </Button>
        )}
      />
      {/* Each choice is its icon and name (no describing line: HelperText step 1); capped, never wider than the screen. */}
      <DropdownMenuContent side="bottom" align="end" sideOffset={4} className="max-w-[min(20rem,var(--available-width))]" data-testid="register-app-menu">
        <DropdownMenuItem onClick={onRegisterOwnService} data-testid="register-app-own-service">
          <Globe />
          <span className="font-bold">{formatMessage({ id: "settings.mcpApp.register.ownService" })}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onRegisterMcpServer} data-testid="register-app-mcp-server">
          <Plug />
          <span className="font-bold">{formatMessage({ id: "settings.mcpApp.register.mcpServer" })}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
