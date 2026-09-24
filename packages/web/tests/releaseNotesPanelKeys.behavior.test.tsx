// DOM-mount contract for the in-app Release Notes panel.
//
// Guards the React key uniqueness of the RELEASE_NOTES list. The list keys on a
// per-entry key that must be unique across ALL entries — including several that
// share a date (e.g. same-day 1.6.1/1.6.0, 1.5.0/1.4.0, and legacy date-only
// pairs). A source-only check does not catch a key collision; only a real mount
// surfaces React's "Encountered two children with the same key" error, under
// which React may drop or duplicate siblings. This spec mounts the panel and
// fails on any such error, and independently asserts every entry renders once.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import ReleaseNotesPanel, {
  RELEASE_NOTES,
} from "../src/components/settings/ReleaseNotesPanel";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";
import { version as packageVersion } from "../package.json";

afterEach(() => cleanup());

function mountPanel() {
  return render(
    <MemoryRouter>
      <LocaleProvider>
        <IntlProviderWrapper>
          <ReleaseNotesPanel />
        </IntlProviderWrapper>
      </LocaleProvider>
    </MemoryRouter>,
  );
}

test("ReleaseNotesPanel mounts with no duplicate-key error across all release entries", () => {
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(args.map((a) => String(a)).join(" "));
  };
  try {
    mountPanel();
  } finally {
    console.error = originalError;
  }
  const duplicateKeyErrors = captured.filter((line) =>
    /Encountered two children with the same key|duplicate key/i.test(line),
  );
  assert.deepEqual(
    duplicateKeyErrors,
    [],
    `React reported duplicate keys on mount: ${duplicateKeyErrors.join(" | ")}`,
  );
});

test("ReleaseNotesPanel renders exactly one node per RELEASE_NOTES entry", () => {
  mountPanel();
  // A duplicate key would let React drop or merge siblings, so the rendered
  // count would drift from the source array length.
  const rendered = screen.getAllByTestId("release-entry");
  assert.equal(
    rendered.length,
    RELEASE_NOTES.length,
    `rendered ${rendered.length} entries, expected ${RELEASE_NOTES.length}`,
  );
});

test("RELEASE_NOTES render keys are unique (same-date multi-version safe)", () => {
  // Mirrors the key expression in ReleaseNotesPanel: version when present,
  // otherwise date + index (the list is an immutable compile-time array).
  const keys = RELEASE_NOTES.map((r, i) => r.version ?? `${r.date}-${i}`);
  assert.equal(
    new Set(keys).size,
    keys.length,
    "release-note render keys must be unique across all entries",
  );
});

test("RELEASE_NOTES user-facing text contains no unapproved CJK (except 简体中文 product name)", () => {
  // Guards the Chinese-only release-batch defect class (regression: 1.9.2 was
  // Chinese-only, leaking to English users). This check is deliberately narrow:
  // it detects unapproved CJK, NOT arbitrary non-English languages (a Spanish/
  // French batch would pass by design).
  const ALLOWED_CJK = "简体中文";
  const cjk = /[\u4e00-\u9fff]/;
  const offenders: string[] = [];
  for (const entry of RELEASE_NOTES) {
    for (const item of entry.items) {
      let text = item.text;
      // strip the allowed product-name literal
      while (text.includes(ALLOWED_CJK)) {
        text = text.replace(ALLOWED_CJK, "");
      }
      if (cjk.test(text)) {
        offenders.push(`${entry.version ?? entry.date}: ${item.text}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `release-note text contains non-product-name CJK: ${offenders.join(" | ")}`,
  );
});

  // ReleaseNotesPanel renders the "Current" badge on releaseIndex === 0, so the
  // first entry must be the newest release — never an older version left on top.
  // Guards the class of "why is Current 1.0.1" surprises: a mis-ordered insert
  // would silently label a stale version as Current.
  test("RELEASE_NOTES Current entry (index 0) carries the highest version", () => {
  const parse = (v: string) => v.split(".").map((n) => Number(n));
  const cmp = (a: number[], b: number[]) =>
    (a[0] ?? 0) - (b[0] ?? 0) ||
    (a[1] ?? 0) - (b[1] ?? 0) ||
    (a[2] ?? 0) - (b[2] ?? 0);
  const current = RELEASE_NOTES[0];
  assert.ok(
    current.version,
    "index 0 renders the Current badge, so it must carry a version",
  );
  for (const r of RELEASE_NOTES) {
    if (!r.version) continue;
    assert.ok(
      cmp(parse(current.version), parse(r.version)) >= 0,
      `Current entry (${current.version}) must be >= every other entry, found ${r.version}`,
    );
  }
});

test("the Current entry (index 0) matches the shipped web package version", () => {
  // The stronger binding: the note rendered as "Current" must equal the version
  // the web app actually ships (packages/web/package.json). The highest-version
  // check above cannot catch bumping the package to a new version while
  // forgetting to add its release note — that would leave a stale Current with
  // no user-facing note, yet still pass ordering. Bind the two together here.
  const current = RELEASE_NOTES[0];
  assert.equal(
    current.version,
    packageVersion,
    `Current note entry (${current.version}) must equal web package version (${packageVersion}); a package bump without a matching release note would otherwise ship silently`,
  );
  mountPanel();
  const firstEntry = screen.getAllByTestId("release-entry")[0];
  assert.ok(firstEntry, "the Current release entry must render first");
  assert.ok(within(firstEntry).getByText("Current"));
  assert.match(
    firstEntry.textContent ?? "",
    new RegExp(`(?:^|\\s)${packageVersion.replaceAll(".", "\\.")}(?:\\s|\\()`),
    "the mounted Current entry must visibly show the shipped package version",
  );
});
