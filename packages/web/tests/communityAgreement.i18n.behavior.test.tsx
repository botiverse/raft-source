import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, fireEvent, screen } from "@testing-library/react";

import CommunityAgreementDialog from "../src/components/server/CommunityAgreementDialog";
import AgreementBody from "../src/components/server/AgreementBody";
import { zhCn as zhMessages } from "../src/i18n/messages/zh-cn";
import { renderWithIntl } from "./helpers/intl";

const zh = zhMessages as Record<string, string>;

afterEach(() => {
  cleanup();
});

test("community agreement dialog renders zh-cn actions", () => {
  renderWithIntl(
    <CommunityAgreementDialog
      agreement={{
        id: "agr-1",
        title: "House rules",
        bodyMarkdown: "Be kind.",
        version: 3,
      }}
      onClose={() => {}}
      onAgree={async () => {}}
    />,
    { locale: "zh-cn" },
  );
  assert.ok(screen.getByRole("button", { name: zh["server.communityAgreement.cancel"] }));
  assert.ok(screen.getByRole("button", { name: zh["server.communityAgreement.agreeContinue"] }));
  assert.match(document.body.textContent ?? "", /3/);
  assert.doesNotMatch(document.body.textContent ?? "", /Agree & Continue/);
});

test("AgreementBody empty state renders zh-cn", () => {
  renderWithIntl(<AgreementBody source="" />, { locale: "zh-cn" });
  assert.match(document.body.textContent ?? "", new RegExp(zh["server.communityAgreement.nothingToPreview"]));
  assert.doesNotMatch(document.body.textContent ?? "", /Nothing to preview yet/);
});

test("community agreement failures render the correct zh-cn response state", async () => {
  const agreement = {
    id: "agr-1",
    title: "House rules",
    bodyMarkdown: "Be kind.",
    version: 3,
  };
  const cases = [
    {
      error: { response: { data: { error: "agreement_changed" } } },
      expected: zh["server.communityAgreement.updated"],
    },
    {
      error: new Error("network down"),
      expected: zh["server.communityAgreement.failedToJoin"],
    },
  ];

  for (const scenario of cases) {
    const view = renderWithIntl(
      <CommunityAgreementDialog
        agreement={agreement}
        onClose={() => {}}
        onAgree={async () => Promise.reject(scenario.error)}
      />,
      { locale: "zh-cn" },
    );
    fireEvent.click(screen.getByRole("button", { name: zh["server.communityAgreement.agreeContinue"] }));
    assert.ok(await screen.findByText(scenario.expected));
    assert.doesNotMatch(document.body.textContent ?? "", /Failed to join community server/);
    view.unmount();
  }
});
