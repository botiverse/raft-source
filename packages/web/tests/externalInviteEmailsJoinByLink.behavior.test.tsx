import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { ExternalInviteEmailsField } from "../src/components/channel/ExternalInviteSteps";
import { TestIntlProvider } from "./helpers/intl";

// People read the External invite step as "pick existing Raft users"
// (#wg-rbac:edede5f7). The email box always says each person gets a link by
// email (no account needed), with or without the history and slots lines.
describe("External invite email box", () => {
  afterEach(() => cleanup());

  it("says everyone gets an email link without needing an account; the placeholder shows several emails", () => {
    render(<TestIntlProvider><ExternalInviteEmailsField value="" onChange={() => {}} overBy={0} /></TestIntlProvider>);
    assert.equal(screen.getByTestId("external-invite-emails-join-by-link").textContent, "Everyone gets an email with a link to join, even without a Raft account.");
    assert.equal(screen.getByRole("textbox").getAttribute("placeholder"), "alex@example.com, sam@example.org, …");
  });

  it("keeps the line when history and slots lines are shown", () => {
    render(
      <TestIntlProvider>
        <ExternalInviteEmailsField value="" onChange={() => {}} overBy={0} historyHint slotsHint="2 left" />
      </TestIntlProvider>,
    );
    assert.equal(screen.getAllByTestId("external-invite-emails-join-by-link").length, 1);
    assert.ok(screen.getByTestId("external-invite-emails-history"));
    assert.ok(screen.getByTestId("external-invite-slots-left"));
  });
});
