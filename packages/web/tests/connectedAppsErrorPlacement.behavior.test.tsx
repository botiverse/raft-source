import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  ConnectedAppsErrorBanner,
  CONNECTED_APPS_ERROR_FORM,
  CONNECTED_APPS_ERROR_LISTING,
  CONNECTED_APPS_ERROR_PAGE,
  getConnectedAppsErrorSurface,
} from "../src/components/settings/connectedAppsErrorSurface";

afterEach(cleanup);

test("connected apps error surface selects exactly one visible target", () => {
  const base = {
    selectedListing: null,
    selectedBuiltInApp: null,
    showRegisterDrawer: false,
    deleteClientTarget: null,
    offlineRequestTarget: null,
    marketplaceUninstallTarget: null,
  };

  const getSurface = (overrides: Partial<typeof base> & { error: string }) => getConnectedAppsErrorSurface(
    overrides.error,
    overrides.selectedListing ?? base.selectedListing,
    overrides.selectedBuiltInApp ?? base.selectedBuiltInApp,
    overrides.showRegisterDrawer ?? base.showRegisterDrawer,
    overrides.deleteClientTarget ?? base.deleteClientTarget,
    overrides.offlineRequestTarget ?? base.offlineRequestTarget,
    overrides.marketplaceUninstallTarget ?? base.marketplaceUninstallTarget,
  );

  assert.equal(getSurface({ error: "" }), "none");
  assert.equal(getSurface({ error: "Load failed" }), "page");
  assert.equal(getSurface({ error: "Install failed", selectedListing: {} }), "listing");
  assert.equal(getSurface({ error: "Publish failed", showRegisterDrawer: true }), "form");
  assert.equal(getSurface({ error: "Hidden", selectedBuiltInApp: {} }), "modal");
  assert.equal(getSurface({ error: "Hidden", deleteClientTarget: {} }), "modal");
  assert.equal(getSurface({ error: "Hidden", offlineRequestTarget: {} }), "modal");
  assert.equal(getSurface({ error: "Hidden", marketplaceUninstallTarget: {} }), "modal");
});

test("connected apps error banner renders only for the selected surface", () => {
  const { rerender } = render(
    <>
      <ConnectedAppsErrorBanner surface="page" target={CONNECTED_APPS_ERROR_PAGE} error="Load failed" />
      <ConnectedAppsErrorBanner surface="page" target={CONNECTED_APPS_ERROR_LISTING} error="Load failed" />
      <ConnectedAppsErrorBanner surface="page" target={CONNECTED_APPS_ERROR_FORM} error="Load failed" />
    </>,
  );

  assert.equal(screen.getAllByText("Load failed").length, 1);

  rerender(
    <>
      <ConnectedAppsErrorBanner surface="listing" target={CONNECTED_APPS_ERROR_PAGE} error="Install failed" />
      <ConnectedAppsErrorBanner surface="listing" target={CONNECTED_APPS_ERROR_LISTING} error="Install failed" />
      <ConnectedAppsErrorBanner surface="listing" target={CONNECTED_APPS_ERROR_FORM} error="Install failed" />
    </>,
  );

  assert.equal(screen.getAllByText("Install failed").length, 1);

  rerender(
    <>
      <ConnectedAppsErrorBanner surface="form" target={CONNECTED_APPS_ERROR_PAGE} error="Publish failed" />
      <ConnectedAppsErrorBanner surface="form" target={CONNECTED_APPS_ERROR_LISTING} error="Publish failed" />
      <ConnectedAppsErrorBanner surface="form" target={CONNECTED_APPS_ERROR_FORM} error="Publish failed" />
    </>,
  );

  assert.equal(screen.getAllByText("Publish failed").length, 1);
});
