import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, screen } from "@testing-library/react";
import SignedInAs from "../src/components/auth/SignedInAs";
import type { User } from "../src/store/authStore";
import { renderWithIntl } from "./helpers/intl";

/**
 * "Signed in as …" always names the ACCOUNT by email (#177).
 *
 * Every surface using it asks "is this the right account?" — approve a device, authorize a
 * service, choose a first server, log out. Email is NOT NULL and unique; a display name is
 * editable and can collide. Reading only the email also means the internal `pending_<hex>`
 * handle the server parks in `users.name` before identity setup can never leak here, which is
 * the bug that started this.
 */

function user(overrides: Partial<User> = {}): User {
  return {
    id: "user-1",
    email: "cindy@example.com",
    name: "cindy",
    displayName: "Cindy Z",
    ...overrides,
  } as User;
}

afterEach(() => cleanup());

test("the email is shown, not the display name or handle", () => {
  renderWithIntl(<SignedInAs user={user()} />);
  screen.getByText("cindy@example.com");
  assert.equal(screen.queryByText("Cindy Z"), null, "a display name must not stand in for the account");
  assert.equal(screen.queryByText("cindy"), null);
});

test("an unfinished identity cannot leak the internal placeholder handle", () => {
  // Before identity setup: displayName is null and name is the server's reservation. The old
  // `displayName || name || email` chain rendered that reservation back to the person here.
  for (const name of ["pending_1234567890abcdef", "pending_1234567890abcdef12345678", "PENDING_ABCDEF0123456789"]) {
    renderWithIntl(<SignedInAs user={user({ name, displayName: null })} />);
    assert.equal(screen.queryByText(/pending_/i), null, `placeholder leaked: ${name}`);
    screen.getByText("cindy@example.com");
    cleanup();
  }
});

test("unknown user covers having no user at all, which is the only way to reach it", () => {
  // `users.email` is NOT NULL, so a signed-up user always has one — this branch is only for
  // signed-out / still-loading, never for a real account.
  renderWithIntl(<SignedInAs user={null} />);
  screen.getByText("unknown user");
});
