import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RuntimeFormV2SourceStatusLine } from "../src/components/agent/RuntimeFormV2SourceStatusLine";
import { runtimePickerCliProblem } from "../src/components/machine/runtimePickerCliProblem";
import { TestIntlProvider } from "./helpers/intl";

// #oar-raft:#20: a model list that failed because the runtime is signed out
// or too old on the Computer says so, instead of the generic "could not list
// the options" (armbian-jojo's agy 1.2.7 showed only that).

function render(reason: string, locale: "en" | "zh-cn" = "en"): string {
  return renderToStaticMarkup(
    createElement(TestIntlProvider, { locale },
      createElement(RuntimeFormV2SourceStatusLine, {
        status: { status: "fallback", reason, retryable: true },
        sourceId: "models",
        testId: "model",
        retrying: false,
      }),
    ),
  );
}

test("a signed-out runtime's list says it is not signed in", () => {
  assert.match(render("not_signed_in"), /not signed in on this Computer/);
  assert.doesNotMatch(render("not_signed_in"), /could not list/);
  assert.match(render("not_signed_in", "zh-cn"), /没有登录/);
});

test("a too-old runtime's list says to update it", () => {
  assert.match(render("runtime_outdated"), /too old to list the options/);
  assert.doesNotMatch(render("runtime_outdated"), /could not list/);
  assert.match(render("runtime_outdated", "zh-cn"), /版本太旧/);
});

test("other failures keep the generic line", () => {
  assert.match(render("probe_failed"), /could not list the options/);
});

test("the picker warns about a missing or too-old CLI, not an installation it can't sign in", () => {
  assert.equal(runtimePickerCliProblem({ kind: "unavailable", reason: "version_unsupported" }), "version_unsupported");
  assert.equal(runtimePickerCliProblem({ kind: "unavailable", reason: "not_installed" }), "not_installed");
  assert.equal(runtimePickerCliProblem({ kind: "unavailable", reason: "unsupported_installation" }), null);
  assert.equal(runtimePickerCliProblem({ kind: "logged_out" }), null);
  assert.equal(runtimePickerCliProblem(null), null);
});
