import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import type { ArtifactHome } from "@botiverse/raft-shared";

import { artifactHomeWords } from "../src/apps/artifacts/artifactHomeWords";
import { artifactAudience } from "../src/apps/artifacts/ArtifactScopeLabel";
import { mergedMessages } from "../src/i18n/messages";
import { SUPPORTED_LOCALES } from "../src/i18n/locale";

// #460: a joint home the reader's server has no copy of comes from the server
// with no id and no name (UNRESOLVED_JOINT_HOME), never the joint's storage
// channel; it reads "Shared channel" in the reader's language, not a bare
// "#" or nothing. Every other home reads as before.

const server = { named: "yes" as const, server: "Northwind" };
const unresolved: ArtifactHome = { kind: "conversation", conversation: { id: null, name: "", type: "joint" } };

test("an unresolved joint home reads as a shared channel; named homes as before", () => {
  const { formatMessage } = createIntl({ locale: "en", defaultLocale: "en", messages: mergedMessages("en") });
  assert.equal(artifactHomeWords(formatMessage, unresolved, server), "Shared channel");
  assert.equal(artifactAudience(formatMessage, unresolved, server), "Members of a shared channel");
  const joint: ArtifactHome = { kind: "conversation", conversation: { id: "c1", name: "acme-partners", type: "joint" } };
  assert.equal(artifactHomeWords(formatMessage, joint, server), "acme-partners");
  assert.equal(artifactAudience(formatMessage, joint, server), "Members of acme-partners");
  const channel: ArtifactHome = { kind: "conversation", conversation: { id: "c2", name: "growth", type: "channel" } };
  assert.equal(artifactHomeWords(formatMessage, channel, server), "#growth");
  // A deleted conversation's orphan (a channel with no name) is not called a shared channel.
  const orphan: ArtifactHome = { kind: "conversation", conversation: { id: null, name: "", type: "channel" } };
  assert.equal(artifactHomeWords(formatMessage, orphan, server), "#");
});

test("every locale names an unresolved joint home in its own words", () => {
  for (const locale of SUPPORTED_LOCALES) {
    const messages = mergedMessages(locale);
    assert.ok(messages["artifacts.scope.sharedChannel"], locale);
    assert.ok(messages["artifacts.scope.whoSharedChannel"], locale);
    const { formatMessage } = createIntl({ locale, defaultLocale: "en", messages });
    assert.notEqual(artifactHomeWords(formatMessage, unresolved, server), "", locale);
  }
});
