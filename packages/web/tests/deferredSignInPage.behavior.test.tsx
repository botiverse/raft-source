import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "./helpers/domSetup";
import { TestIntlProvider } from "./helpers/intl";

// The sign-in page's chunk, held until a test lets it arrive.
let arrive: () => void = () => {};
const arrived = new Promise<void>((resolve) => { arrive = resolve; });
vi.mock("../src/components/auth/SignInPage", async () => {
  await arrived;
  return {
    SignInPage: ({ purpose }: { purpose?: string }) => <div data-testid="sign-in-page-loaded">{purpose}</div>,
    PendingSecondFactorSignInStep: () => null,
  };
});

const { DeferredSignInPage } = await import("../src/components/auth/SignInPageFrame");

afterEach(cleanup);

test("the sign-in page draws its frame until its code is in, then itself in the same commit, with no Suspense in between", async () => {
  render(<TestIntlProvider><MemoryRouter><DeferredSignInPage purpose="Why" /></MemoryRouter></TestIntlProvider>);
  expect(screen.getByTestId("sign-in-frame")).toBeTruthy();
  expect(screen.getByTestId("sign-in-frame-reserved")).toBeTruthy();
  expect(screen.queryByTestId("sign-in-page-loaded")).toBeNull();
  await act(async () => { arrive(); await arrived; });
  expect((await screen.findByTestId("sign-in-page-loaded")).textContent).toBe("Why");
  expect(screen.queryByTestId("sign-in-frame")).toBeNull();
});

test("code already in draws the page in the first render, no frame", () => {
  render(<TestIntlProvider><MemoryRouter><DeferredSignInPage purpose="Again" /></MemoryRouter></TestIntlProvider>);
  expect(screen.getByTestId("sign-in-page-loaded").textContent).toBe("Again");
  expect(screen.queryByTestId("sign-in-frame")).toBeNull();
});
