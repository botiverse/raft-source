// Settings › Account › Data & privacy (DataExportSection.tsx; server
// routes/dataExports.ts): hidden while data export is off for the person
// (the list's 404), the request and the proof the server asks for (a
// password after reauth_required), the refusal for a sign-in under a day
// old, Download asking the API for that volume, and the emailed link
// (`/?data_export=<id>`) landing on the section with that export marked.
// The API is stubbed at the axios client.
import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, test } from "vitest";

import api from "../../../api/client";
import SecondFactorStepUpHost from "../../../components/settings/SecondFactorStepUpHost";
import { resetSecondFactorStepUpForTests } from "../../../components/settings/secondFactorStepUp";
import { IntlProviderWrapper } from "../../../i18n/IntlProviderWrapper";
import { LocaleProvider } from "../../../i18n/LocaleProvider";
import { useAuthStore } from "../../../store/authStore";
import { dataExportLandingPath } from "../../../utils/dataExportLink";
import { DataPrivacySection } from "../account/DataExportSection";

const READY = "44444444-4444-4444-8444-444444444444";
const originalGet = api.get;
const originalPost = api.post;
const originalClick = HTMLAnchorElement.prototype.click;

afterEach(() => {
  cleanup();
  resetSecondFactorStepUpForTests();
  api.get = originalGet;
  api.post = originalPost;
  HTMLAnchorElement.prototype.click = originalClick;
  useAuthStore.setState({ user: null } as never);
});

type Call = { method: string; url: string; body: unknown };

function httpError(status: number, data: Record<string, unknown>) {
  return Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } });
}

const readyExport = {
  id: READY,
  kind: "personal",
  status: "ready",
  createdAt: "2026-11-10T10:00:00.000Z",
  expiresAt: "2026-11-17T10:00:00.000Z",
  sizeBytes: 2048,
  volumes: [{ index: 1, sizeBytes: 2048 }],
  errorCode: null,
};

/** GET answers `list()` (a function so a test can change it); POSTs by url, each queue in turn (the last repeats). */
function stubApi(list: () => unknown, posts: Record<string, Array<(body: unknown) => unknown>> = {}) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  api.get = (async (url: string) => {
    calls.push({ method: "GET", url, body: undefined });
    if (url === "/me/data-exports") return { data: list() };
    throw new Error(`Unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    calls.push({ method: "POST", url, body });
    const queue = posts[url];
    if (!queue) throw new Error(`Unexpected POST ${url}`);
    const n = counts.get(url) ?? 0;
    counts.set(url, n + 1);
    return queue[Math.min(n, queue.length - 1)]!(body);
  }) as typeof api.post;
  return calls;
}

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

function renderSection(entry = "/s/home/settings/account") {
  return render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <MemoryRouter initialEntries={[entry]}>
          <DataPrivacySection />
          <Where />
          <SecondFactorStepUpHost />
        </MemoryRouter>
      </IntlProviderWrapper>
    </LocaleProvider>,
  );
}

test("data export off for the person (the list's 404): only the usage data switch, no Data & privacy, no Export", async () => {
  const calls = stubApi(() => {
    throw httpError(404, { code: "not_found", error: "Data export is not available here." });
  });
  renderSection();
  await waitFor(() => assert.ok(calls.some((call) => call.url === "/me/data-exports")));
  await screen.findByTestId("account-usage-data");
  assert.ok(screen.queryByTestId("data-export-section") === null, "no export section");
  assert.ok(screen.queryByText("Data & privacy") === null, "no Data & privacy heading");
});

test("request: Export, then the password the server asks for (reauth_required), sent with the same scope; the new export shows as preparing", async () => {
  const created = { ...readyExport, id: "55555555-5555-4555-8555-555555555555", status: "queued", expiresAt: null, sizeBytes: null, volumes: [], createdAt: new Date().toISOString() };
  let exports: unknown[] = [];
  const calls = stubApi(() => ({ exports, available: true }), {
    "/me/data-exports": [
      () => { throw httpError(403, { code: "reauth_required", error: "Confirm it's you before exporting data.", details: { methods: ["password"] } }); },
      () => {
        exports = [created];
        return { data: { export: created } };
      },
    ],
  });
  renderSection();
  fireEvent.click(await screen.findByTestId("data-export-request"));
  const scopeDialog = await screen.findByTestId("data-export-dialog-scope");
  fireEvent.click(within(scopeDialog).getByTestId("data-export-include-files"));
  fireEvent.click(within(scopeDialog).getByTestId("data-export-submit"));

  const passwordDialog = await screen.findByTestId("data-export-dialog-password");
  fireEvent.change(within(passwordDialog).getByLabelText("Password"), { target: { value: "hunter2" } });
  fireEvent.click(within(passwordDialog).getByTestId("data-export-submit"));

  await waitFor(() => assert.ok(screen.queryByTestId("data-export-dialog-password") === null, "the dialog closed"));
  const scope = { serverIds: "all", includeContext: false, includeFiles: true };
  assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => call.body), [{ scope }, { scope, password: "hunter2" }]);
  const row = await screen.findByTestId(`data-export-row-${created.id}`);
  assert.match(row.textContent ?? "", /Preparing/);
  assert.equal(screen.getByTestId("data-export-request").hasAttribute("disabled"), true, "one in flight at a time");
});

test("a sign-in under a day old: the dialog says to export from an older one, and nothing is created", async () => {
  stubApi(() => ({ exports: [], available: true }), {
    "/me/data-exports": [() => { throw httpError(403, { code: "data_export_session_too_new", error: "This sign-in is less than a day old." }); }],
  });
  renderSection();
  fireEvent.click(await screen.findByTestId("data-export-request"));
  const dialog = await screen.findByTestId("data-export-dialog-scope");
  fireEvent.click(within(dialog).getByTestId("data-export-submit"));
  const banner = await within(dialog).findByTestId("data-export-dialog-banner");
  assert.match(banner.textContent ?? "", /less than a day ago/);
});

test("ready: its expiry shows, and Download asks the API for that volume and opens the link it answers", async () => {
  const clicked: string[] = [];
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    clicked.push(this.href);
  };
  const calls = stubApi(() => ({ exports: [readyExport], available: true }), {
    [`/me/data-exports/${READY}/download`]: [() => ({
      data: new Blob([JSON.stringify({ url: "https://exports.example.test/one.zip?signed=1" })], { type: "application/json" }),
      headers: { "content-type": "application/json; charset=utf-8" },
    })],
  });
  renderSection();
  const row = await screen.findByTestId(`data-export-row-${READY}`);
  assert.match(row.textContent ?? "", /Ready/);
  assert.match(row.textContent ?? "", /November 17/);
  fireEvent.click(within(row).getByTestId(`data-export-download-${READY}-1`));
  await waitFor(() => assert.deepEqual(clicked, ["https://exports.example.test/one.zip?signed=1"]));
  assert.deepEqual(calls.filter((call) => call.method === "POST").map((call) => [call.url, call.body]), [[`/me/data-exports/${READY}/download`, { volume: 1 }]]);
});

test("Download from a sign-in under a day old: the refusal (a JSON body read back from the blob request) says why, not just to try again", async () => {
  const refusal = httpError(403, {});
  (refusal.response as { data: unknown }).data = new Blob([JSON.stringify({ code: "data_export_session_too_new", error: "This sign-in is less than a day old." })], { type: "application/json" });
  stubApi(() => ({ exports: [readyExport], available: true }), {
    [`/me/data-exports/${READY}/download`]: [() => { throw refusal; }],
  });
  renderSection();
  const row = await screen.findByTestId(`data-export-row-${READY}`);
  fireEvent.click(within(row).getByTestId(`data-export-download-${READY}-1`));
  await waitFor(() => assert.match(row.textContent ?? "", /less than a day ago.*download from a device you've been signed in on for at least a day/));
  assert.doesNotMatch(row.textContent ?? "", /Try again\./);
});

test("what's included: with other people's messages offered, the dialog never says they're left out", async () => {
  stubApi(() => ({ exports: [], available: true, contextServerIds: ["66666666-6666-4666-8666-666666666666"] }));
  renderSection();
  fireEvent.click(await screen.findByTestId("data-export-request"));
  const dialog = await screen.findByTestId("data-export-dialog-scope");
  within(dialog).getByTestId("data-export-include-context");
  const text = dialog.textContent ?? "";
  assert.match(text, /Not included: other people's files/);
  assert.match(text, /Other people's messages only when you include them/);
  assert.doesNotMatch(text, /Not included: other people's messages/);
});

test("the emailed link: /?data_export=<id> lands on Settings › Account at the section; that export is marked and the parameter taken off", async () => {
  assert.equal(dataExportLandingPath(`?data_export=${READY}`, [{ slug: "first" }, { slug: "last" }], "last"), `/s/last/settings/account?data_export=${READY}#data-export`);
  assert.equal(dataExportLandingPath(`?data_export=${READY}`, [{ slug: "first" }], null), `/s/first/settings/account?data_export=${READY}#data-export`);
  assert.equal(dataExportLandingPath("?data_export=not-an-id", [{ slug: "first" }], null), null);
  assert.equal(dataExportLandingPath(`?data_export=${READY}`, [], null), null);

  stubApi(() => ({ exports: [readyExport], available: true }));
  renderSection(`/s/last/settings/account?data_export=${READY}`);
  const row = await screen.findByTestId(`data-export-row-${READY}`);
  await waitFor(() => assert.equal(row.getAttribute("aria-current"), "true"));
  await waitFor(() => assert.equal(screen.getByTestId("where").textContent, "/s/last/settings/account"));
});

test("the 7-day wait comes from the server's nextAllowedAt: an export deleted from the list still counts, so Export is off and says when", async () => {
  const nextAllowedAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  stubApi(() => ({ exports: [], available: true, nextAllowedAt }));
  renderSection();
  const request = await screen.findByTestId("data-export-request");
  await waitFor(() => assert.equal(request.hasAttribute("disabled"), true));
  assert.match(screen.getByTestId("data-export-cooldown").textContent ?? "", /ask again on/);
});
