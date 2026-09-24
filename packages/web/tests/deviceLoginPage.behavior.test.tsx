import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import api from "../src/api/client";
import DeviceLoginPage from "../src/pages/DeviceLoginPage";
import { useAuthStore } from "../src/store/authStore";
// DeviceLoginPage now calls useIntl() (pages.deviceLogin.* migration), so it
// needs an <IntlProvider> ancestor. Default locale (en) keeps these English
// assertions green.
import { TestIntlProvider } from "./helpers/intl";

const originalPost = api.post;
const originalClose = window.close;

function resetAuthUser() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "cindy@example.com",
      gravatarHash: "",
      name: "cindy zhao",
      displayName: "cindy zhao",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTranslationDisplay: "translated",
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
    loading: false,
    initialized: true,
  } as never);
}

async function submitWithError(code: string) {
  window.history.pushState({}, "", "/login/device?user_code=VSWA-7M58");
  resetAuthUser();
  api.post = async () => {
    throw { response: { data: { code } } };
  };

  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Approve Device Login" }));
  });
}

afterEach(() => {
  cleanup();
  api.post = originalPost;
  window.close = originalClose;
  window.history.pushState({}, "", "/");
  resetAuthUser();
});

test("expired device login points users back to Raft Desktop sign-in", async () => {
  await submitWithError("expired");

  assert.ok(await screen.findByText("That code has expired. Start sign-in again from Raft Desktop."));
  assert.equal(screen.queryByText(/raft-computer login/), null);
});

test("invalid device login references the code shown in Raft Desktop", async () => {
  await submitWithError("user_code_invalid");

  assert.ok(await screen.findByText("That code is invalid. Check the code shown in Raft Desktop and try again."));
});

test("already-used device login points users back to Raft Desktop if needed", async () => {
  await submitWithError("already_resolved");

  assert.ok(await screen.findByText("That sign-in request was already used. Start sign-in again from Raft Desktop if needed."));
});

test("approved device login closes the browser page from the Raft Desktop return state", async () => {
  let closed = false;
  window.history.pushState({}, "", "/login/device?user_code=VSWA-7M58");
  window.close = () => {
    closed = true;
  };
  resetAuthUser();
  api.post = async () => ({ data: {} });

  render(<TestIntlProvider><DeviceLoginPage /></TestIntlProvider>);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Approve Device Login" }));
  });

  assert.ok(await screen.findByText("Sign-in is complete. You can close this browser page."));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Close this page" }));
  });

  await waitFor(() => assert.equal(closed, true));
  assert.ok(await screen.findByText("If this tab stays open, close it manually."));
});
