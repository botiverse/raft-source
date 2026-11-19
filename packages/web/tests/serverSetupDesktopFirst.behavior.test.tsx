import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import ServerSetupComputerRuntimeStep from "../src/components/onboarding/ServerSetupComputerRuntimeStep";
import { resetDesktopPlatformsForTest } from "../src/components/settings/DesktopDownloadOptions";
import { desktopPlatformsFrom } from "../src/utils/desktopDownload";
import { TestIntlProvider } from "./helpers/intl";

/**
 * The computer step in a browser offers Raft Desktop first (Wug / huxijin,
 * 2026-11-14): a third of new servers stopped at this step (Nova, 11-08), about
 * half without copying a command, nearly all at a computer that could run the
 * app, which adds it in one click. The commands stay one click away, and are the
 * only way where this device has no build.
 */

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
const noop = () => undefined;
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const originalUserAgent = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
const originalGlobalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/** The device the page reads (navigator.userAgent), wherever this Node keeps `navigator` (as appDownloadClicked.behavior.test.tsx). */
function useDevice(userAgent: string): void {
  Object.defineProperty(window.navigator, "userAgent", { configurable: true, value: userAgent });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: window.navigator });
}

afterEach(() => {
  cleanup();
  resetDesktopPlatformsForTest();
  if (originalUserAgent) Object.defineProperty(window.navigator, "userAgent", originalUserAgent);
  else delete (window.navigator as { userAgent?: string }).userAgent;
  if (originalGlobalNavigator) Object.defineProperty(globalThis, "navigator", originalGlobalNavigator);
});

function renderStep(onChooseConnectWay: (way: "download_app" | "install_myself") => void = noop) {
  return render(
    <ServerSetupComputerRuntimeStep
      computer={null}
      runtimeStatus="unknown"
      serverSlug="launch"
      computerInstallCommand="curl -fsSL https://downloads.raft.build/computer/install.sh | sh"
      setupCommand="raft-computer setup /launch"
      onCopyInstallCommand={noop}
      onOpenApiKeySettings={noop}
      onNext={noop}
      onChooseConnectWay={onChooseConnectWay}
    />,
  );
}

test("a Mac browser gets the Raft Desktop download first, and the commands only after Install with a command", async () => {
  useDevice(MAC);
  resetDesktopPlatformsForTest(async () => ({ mac: { status: "available", universal: true }, linux: { status: "available" }, windows: { status: "available" } }));
  const ways: string[] = [];
  renderStep((way) => ways.push(way));

  const download = await screen.findByTestId("onboarding-desktop-download-recommended");
  assert.equal(download.textContent, "Download for Mac");
  assert.match(download.getAttribute("href") ?? "", /\/desktop-download\?target=mac&from=app$/);
  assert.ok(!screen.queryByText("raft-computer setup /launch"), "no command before they ask for one");

  download.addEventListener("click", (event) => event.preventDefault(), { once: true });
  assert.ok(!screen.queryByTestId("onboarding-desktop-download-waiting"));
  fireEvent.click(download);
  assert.deepEqual(ways, ["download_app"]);
  assert.ok(screen.getByTestId("onboarding-desktop-download-waiting"), "after the click it says it is waiting for the computer");

  fireEvent.click(screen.getByRole("button", { name: "Install with a command" }));
  await waitFor(() => assert.ok(screen.getByText("raft-computer setup /launch")));
  assert.ok(!screen.queryByTestId("onboarding-desktop-download"));
  assert.deepEqual(ways, ["download_app", "install_myself"]);
});

test("a device with no Raft Desktop build gets the commands as before", async () => {
  useDevice(MAC);
  resetDesktopPlatformsForTest(async () => ({ mac: { status: "none" }, linux: { status: "none" }, windows: { status: "none" } }));
  renderStep();
  await waitFor(() => assert.ok(screen.getByText("raft-computer setup /launch")));
  assert.ok(!screen.queryByTestId("onboarding-desktop-download"));
});

test("a malformed platforms answer falls back to the defaults instead of breaking the page", () => {
  assert.deepEqual(desktopPlatformsFrom([]), { mac: { status: "unknown" }, linux: { status: "unknown" }, windows: { status: "none" } });
  assert.deepEqual(desktopPlatformsFrom({ mac: { status: "available", universal: true }, windows: "yes" }), {
    mac: { status: "available", universal: true },
    linux: { status: "unknown" },
    windows: { status: "none" },
  });
});
