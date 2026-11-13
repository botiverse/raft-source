import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

type ProviderEntry = { status: string; image?: string | null };
type PairEntry = { leftProvider: string; rightProvider: string; status: string };
type SiteCase = {
  id: string;
  declaredProviders?: string[];
  providers: Record<string, ProviderEntry>;
  pairs: Record<string, PairEntry>;
};
type Applicability = {
  pairNotApplicable(item: SiteCase, entry: PairEntry): boolean;
  markNotApplicable(cases: SiteCase[]): void;
};

// site/applicability.js is a classic script inlined into index.html; load it
// the same way, in its own global scope.
function loadApplicability(): Applicability {
  const source = readFileSync(new URL("../site/applicability.js", import.meta.url), "utf8");
  const context: { VtApplicability?: Applicability } = {};
  runInNewContext(`${source}\nthis.VtApplicability = VtApplicability;`, context);
  if (!context.VtApplicability) throw new Error("applicability.js did not define VtApplicability");
  return context.VtApplicability;
}

const { markNotApplicable } = loadApplicability();

function reactOnlyCase(reactStatus: string): SiteCase {
  return {
    id: "screens.auth.login.signing",
    declaredProviders: ["react"],
    providers: {
      react: reactStatus === "captured" ? { status: "captured", image: "latest/react/x.png" } : { status: "missing", image: null },
      android: { status: "missing", image: null },
    },
    pairs: { react__android: { leftProvider: "react", rightProvider: "android", status: "missing" } },
  };
}

test("a pair missing only its undeclared end is n/a", () => {
  const item = reactOnlyCase("captured");
  markNotApplicable([item]);
  assert.equal(item.pairs.react__android.status, "n/a");
  assert.equal(item.providers.android.status, "n/a");
  assert.equal(item.providers.react.status, "captured");
});

test("a declared end that lost its capture keeps the pair missing", () => {
  const item = reactOnlyCase("missing");
  markNotApplicable([item]);
  assert.equal(item.pairs.react__android.status, "missing");
  assert.equal(item.providers.react.status, "missing");
  assert.equal(item.providers.android.status, "n/a");
});

test("cases that declare both ends, or nothing, are left alone", () => {
  const both = { ...reactOnlyCase("captured"), declaredProviders: ["react", "android"] };
  const legacy = reactOnlyCase("captured");
  delete legacy.declaredProviders;
  markNotApplicable([both, legacy]);
  assert.equal(both.pairs.react__android.status, "missing");
  assert.equal(both.providers.android.status, "missing");
  assert.equal(legacy.pairs.react__android.status, "missing");
  assert.equal(legacy.providers.android.status, "missing");
});

test("an undeclared end with no provider entry at all is still n/a", () => {
  const item: SiteCase = {
    id: "components.members.create-agent.pi-provider-dialog",
    declaredProviders: ["react"],
    providers: { react: { status: "captured", image: "latest/react/pi.png" } },
    pairs: { react__ios: { leftProvider: "react", rightProvider: "ios", status: "missing" } },
  };
  markNotApplicable([item]);
  assert.equal(item.pairs.react__ios.status, "n/a");
});
