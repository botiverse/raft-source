import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import DeviceLoginPage from "../src/pages/DeviceLoginPage";
import { TestIntlProvider } from "./helpers/intl";
import { useAuthStore } from "../src/store/authStore";

const EXPECTED_APPROVE_TITLE = "Approve Device Login";
const EXPECTED_APPROVE = "Approve Device Login";
const EXPECTED_EXPIRED = "That code has expired. Start sign-in again from Raft Desktop.";
const EXPECTED_CLOSE = "Close this page";
const EXPECTED_APPROVED_DESCRIPTION = "Sign-in is complete. You can close this browser page.";

const originalPost = api.post;

afterEach(() => {
  cleanup();
  api.post = originalPost;
  useAuthStore.setState({ user: null, initialized: true, restoreState: "signed_out" } as never);
  window.history.pushState({}, "", "/");
});

function seedUser() {
  useAuthStore.setState({
    user: {
      id: "user-1",
      name: "ada",
      displayName: "Ada",
      email: "ada@example.com",
      emailVerified: true,
    },
    loading: false,
    initialized: true,
    restoreState: "authenticated",
  } as never);
}

function renderDeviceLogin(search = "") {
  // App itself cannot isolate here: default App reads import.meta.env.DEV,
  // which is undefined outside Vite (same harness wall as
  // mobileDownloadChooser.behavior.test.tsx). The reachable page is still
  // DeviceLoginPage at /login/device.
  window.history.pushState({}, "", `/login/device${search}`);
  return render(
    <MemoryRouter initialEntries={[`/login/device${search}`]}>
      <TestIntlProvider>
        <DeviceLoginPage />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("device login page is login-into-Raft and approves through /auth/device/approve", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body: unknown) => {
    posts.push({ url, body });
    return { data: { ok: true } };
  }) as typeof api.post;
  seedUser();
  renderDeviceLogin("?user_code=abcd-efgh");

  assert.ok(screen.getByRole("heading", { name: EXPECTED_APPROVE_TITLE }));
  assert.equal(screen.queryByText("Login with Raft"), null);
  const code = screen.getByPlaceholderText("XXXX-XXXX") as HTMLInputElement;
  assert.equal(code.value, "abcd-efgh");

  fireEvent.click(screen.getByRole("button", { name: EXPECTED_APPROVE }));

  await waitFor(() => {
    assert.deepEqual(posts, [{
      url: "/auth/device/approve",
      body: { userCode: "ABCD-EFGH", approve: true },
    }]);
    assert.ok(screen.getByText(EXPECTED_APPROVED_DESCRIPTION));
  });
  assert.ok(screen.getByRole("button", { name: EXPECTED_CLOSE }));
});

test("device login recovery copy points users back to Raft Desktop", async () => {
  api.post = (async () => {
    throw {
      response: {
        data: { code: "expired", error: "expired" },
      },
    };
  }) as typeof api.post;
  seedUser();
  renderDeviceLogin();

  fireEvent.change(screen.getByPlaceholderText("XXXX-XXXX"), { target: { value: "WXYZ-1234" } });
  fireEvent.click(screen.getByRole("button", { name: EXPECTED_APPROVE }));

  assert.ok(await screen.findByText(EXPECTED_EXPIRED));
  assert.equal(screen.queryByText(/Return to your terminal/), null);
  assert.equal(screen.queryByText(/raft-computer login/), null);
  assert.ok(screen.getByRole("button", { name: EXPECTED_APPROVE }));
});
