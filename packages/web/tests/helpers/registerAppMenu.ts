import { act, fireEvent, screen } from "@testing-library/react";

/**
 * "+ Add App" is a menu (Create a Raft App / Add a Custom MCP App). Opens it and picks one; the menu is a
 * Base UI menu, so it is opened from the keyboard as a person would.
 */
export async function chooseRegisterAppMenuItem(item: "own-service" | "mcp-server"): Promise<void> {
  const trigger = await screen.findByTestId("register-app-menu-trigger");
  await act(async () => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
  });
  fireEvent.click(await screen.findByTestId(`register-app-${item}`));
}
