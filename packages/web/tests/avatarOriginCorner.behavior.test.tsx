import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@botiverse/raft-ui";
import { afterEach, test } from "vitest";
import { AvatarOriginCorner } from "../src/components/member/MemberLabelParts";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import type { MemberOrigin } from "../src/utils/memberOrigin";

// The mark of someone from another server on a small face (the @ list's `dot`):
// the server's logo in a circle where this client has it, else a plain dot
// (artin, #proj-mobile msg=608719a9; #proj-raft-ui:a30f10a9).

const origin: MemberOrigin = { external: true, servers: [{ id: "srv-acme", name: "Acme Corp" }] };
const initialServers = useServerStore.getState().servers;

afterEach(() => {
  cleanup();
  useServerStore.setState({ servers: initialServers });
});

function renderCorner(dot: boolean, shown: MemberOrigin = origin) {
  render(
    <TooltipProvider>
      <span className="relative inline-block size-5">
        <AvatarOriginCorner origin={shown} dot={dot} />
      </span>
    </TooltipProvider>,
  );
  return screen.getByTestId("avatar-origin-corner");
}

function seedServer(avatarUrl: string | null) {
  useServerStore.setState({ servers: [{ id: "srv-acme", name: "Acme Corp", avatarUrl } as Server] });
}

test("a small face shows the server's logo when this client has it", () => {
  seedServer("/api/attachments/acme-logo.webp");
  const corner = renderCorner(true);
  assert.equal(corner.dataset.originMark, "logo");
  assert.ok(corner.querySelector('[data-origin-tile="logo"]'));
});

test("a small face falls back to the plain dot without a logo", () => {
  seedServer(null);
  assert.equal(renderCorner(true).dataset.originMark, "dot");
});

test("a server this client doesn't know is a plain dot", () => {
  useServerStore.setState({ servers: [] });
  const corner = renderCorner(true);
  assert.equal(corner.dataset.originMark, "dot");
  assert.ok(corner.querySelector('[data-origin-tile="dot"]'));
});

test("a logo sent with the person shows on a server this client doesn't know", () => {
  useServerStore.setState({ servers: [] });
  const corner = renderCorner(true, { external: true, servers: [{ id: "srv-acme", name: "Acme Corp", avatarUrl: "/api/avatars/acme.webp" }] });
  assert.equal(corner.dataset.originMark, "logo");
  assert.ok(corner.querySelector('[data-origin-tile="logo"]'));
});

test("a large face keeps the server's tile", () => {
  seedServer("/api/attachments/acme-logo.webp");
  const corner = renderCorner(false);
  assert.equal(corner.dataset.originMark, "tile");
  assert.ok(corner.querySelector('[data-origin-tile="logo"]'));
});

test("someone from this server has no mark", () => {
  seedServer("/api/attachments/acme-logo.webp");
  render(
    <TooltipProvider>
      <AvatarOriginCorner origin={{ external: false, servers: origin.servers }} dot />
    </TooltipProvider>,
  );
  assert.ok(screen.queryByTestId("avatar-origin-corner") === null, "no mark for someone from this server");
});
