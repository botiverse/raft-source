import "./helpers/domSetup";

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { PaletteAuditRoute } from "../src/App";
import { en } from "../src/i18n/messages/en";
import { TestIntlProvider } from "./helpers/intl";

afterEach(cleanup);

function CurrentPath() {
  return <output data-testid="current-path">{useLocation().pathname}</output>;
}

test("the palette audit surface renders only when the route is explicitly in dev mode", () => {
  const dev = render(
    <MemoryRouter initialEntries={["/palette-audit"]}>
      <TestIntlProvider>
        <Routes>
          <Route path="/palette-audit" element={<PaletteAuditRoute isDev />} />
        </Routes>
      </TestIntlProvider>
    </MemoryRouter>,
  );

  assert.ok(screen.getByRole("heading", { name: en["pages.paletteAudit.title"] }));
  dev.unmount();

  render(
    <MemoryRouter initialEntries={["/palette-audit"]}>
      <Routes>
        <Route path="/palette-audit" element={<PaletteAuditRoute isDev={false} />} />
        <Route path="/" element={<CurrentPath />} />
      </Routes>
    </MemoryRouter>,
  );

  assert.equal(screen.getByTestId("current-path").textContent, "/");
  assert.equal(screen.queryByRole("heading", { name: en["pages.paletteAudit.title"] }), null);
});
