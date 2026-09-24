import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import SocialProviderButton from "../src/components/auth/SocialProviderButton";
import { TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) =>
  rtlRender(ui, { wrapper: TestIntlProvider, ...options });

afterEach(() => {
  cleanup();
});

test("social provider buttons center their icon and label together", () => {
  render(
    <>
      <SocialProviderButton providerId="google" label="Google" onClick={() => {}} />
      <SocialProviderButton providerId="github" label="GitHub" onClick={() => {}} />
      <SocialProviderButton providerId="apple" label="Apple" onClick={() => {}} />
    </>,
  );

  for (const label of ["Google", "GitHub", "Apple"]) {
    const button = screen.getByRole("button", { name: `Continue with ${label}` });
    assert.ok(button.classList.contains("justify-center"));
    assert.equal(button.children.length, 2);
    assert.ok(button.firstElementChild instanceof HTMLImageElement);
    assert.equal(button.lastElementChild?.textContent, `Continue with ${label}`);
  }
});
