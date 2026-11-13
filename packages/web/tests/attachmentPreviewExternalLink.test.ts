import assert from "node:assert/strict";

import {
  openAttachmentPreviewExternalLink,
  validateAttachmentPreviewExternalLink,
} from "../src/components/message/attachmentPreviewExternalLink";
import type {
  AttachmentPreviewExternalLink,
} from "../src/components/message/attachmentPreviewExternalLink";
import { parseExternalLinkHotspots } from "../src/components/message/attachmentPreviewBridge";
import { resetRaftAppHostsForTests, setRaftAppHosts } from "../src/store/raftAppHosts";

const appOrigin = "https://app.raft.build";

test("attachment preview allows ordinary public HTTPS travel links, including site-owned xsec_token", () => {
  const validated = validateAttachmentPreviewExternalLink(
    "https://www.xiaohongshu.com/search_result/6a24?xsec_token=site-token&xsec_source=",
    appOrigin,
  );

  assert.deepEqual(validated, {
    ok: true,
    link: {
      href: "https://www.xiaohongshu.com/search_result/6a24?xsec_token=site-token&xsec_source=",
      hostname: "www.xiaohongshu.com",
    },
  });

  assert.equal(
    validateAttachmentPreviewExternalLink(
      "https://www.booking.com/search?q=access_token%3Dhotel-description",
      appOrigin,
    ).ok,
    true,
    "only an exact sensitive parameter key is authority-bearing",
  );
});

test("attachment preview rejects non-HTTPS, credentials, private/internal hosts, and scoped token URLs", () => {
  const cases: Array<[string, string]> = [
    ["/relative", "invalid_url"],
    ["javascript:alert(1)", "non_https"],
    ["http://booking.com/", "non_https"],
    ["https://user:pass@booking.com/", "credentials"],
    ["https://booking.com:444/", "nonstandard_port"],
    ["https://localhost/", "private_host"],
    ["https://127.0.0.1/", "private_host"],
    ["https://[::1]/", "private_host"],
    ["https://printer.internal/", "private_host"],
    ["https://app.raft.build/s/acme", "internal_origin"],
    ["https://api.slock.ai/v1", "internal_origin"],
    ["https://api-aws-staging.botiverse.dev/", "internal_origin"],
    ["https://booking.com/?previewToken=secret", "sensitive_query"],
    ["https://booking.com/?access_token=secret", "sensitive_query"],
    ["https://booking.com/#token=secret", "sensitive_query"],
  ];

  for (const [href, reason] of cases) {
    assert.deepEqual(
      validateAttachmentPreviewExternalLink(href, appOrigin),
      { ok: false, reason },
      href,
    );
  }
});

// Tenny (#proj-workspace:fbc76200): every Raft app host this deployment's
// server lists (its appHosts(), from the client config:
// store/raftAppHosts.ts) is Raft's own origin too, beside the fixed list and
// botiverse.dev. Only stricter: before the list arrives, the fixed rules alone.
test("attachment preview refuses a host on the server's app hosts list as internal_origin, read when the link is checked; look-alikes and subdomains are not on it", () => {
  const configured = "https://raft-staging.pages.dev/s/acme/channel/c1?msg=m1";
  try {
    assert.equal(validateAttachmentPreviewExternalLink(configured, appOrigin).ok, true, "before the list arrives: an ordinary public host");

    setRaftAppHosts(["app.raft.build", "chat.example.dev", "raft-staging.pages.dev"]);
    for (const href of [configured, "https://RAFT-STAGING.pages.dev./x", "https://chat.example.dev/"]) {
      assert.deepEqual(validateAttachmentPreviewExternalLink(href, appOrigin), { ok: false, reason: "internal_origin" }, href);
    }
    // The fixed list and the botiverse.dev rule still hold.
    assert.deepEqual(validateAttachmentPreviewExternalLink("https://api.slock.ai/v1", appOrigin), { ok: false, reason: "internal_origin" });
    assert.deepEqual(validateAttachmentPreviewExternalLink("https://api-aws-staging.botiverse.dev/", appOrigin), { ok: false, reason: "internal_origin" });
    for (const href of [
      "https://raft-staging.pages.dev.evil.example/",
      "https://sub.raft-staging.pages.dev/",
      "https://evil-raft-staging.pages.dev/",
      "https://pages.dev/",
    ]) {
      assert.equal(validateAttachmentPreviewExternalLink(href, appOrigin).ok, true, href);
    }
  } finally {
    resetRaftAppHostsForTests();
  }
});

function popupFixture() {
  const appended: unknown[] = [];
  let anchorClicked = false;
  let closed = false;
  const meta = { name: "", content: "" };
  const anchor = { href: "", rel: "", referrerPolicy: "", click: () => { anchorClicked = true; } };
  const popup = {
    opener: {} as unknown,
    document: {
      createElement: (tag: string) => {
        if (tag === "meta") return meta;
        if (tag === "a") return anchor;
        throw new Error(`unexpected element ${tag}`);
      },
      head: { append: (node: unknown) => appended.push(node) },
      body: { append: (node: unknown) => appended.push(node) },
      documentElement: { append: (node: unknown) => appended.push(node) },
    },
    close: () => { closed = true; },
  };
  return {
    popup: popup as unknown as Window,
    meta,
    anchor,
    appended,
    get anchorClicked() { return anchorClicked; },
    get closed() { return closed; },
  };
}

test("controlled parent opener severs opener and navigates with no-referrer before external bytes load", () => {
  const fixture = popupFixture();
  const calls: Array<[string, string]> = [];
  const link: AttachmentPreviewExternalLink = {
    href: "https://www.booking.com/search?ss=Atami",
    hostname: "www.booking.com",
  };

  const opened = openAttachmentPreviewExternalLink(link, (url, target) => {
    calls.push([url, target]);
    return fixture.popup;
  });

  assert.equal(opened, true);
  assert.deepEqual(calls, [["about:blank", "_blank"]]);
  assert.equal(fixture.popup.opener, null);
  assert.deepEqual(fixture.meta, { name: "referrer", content: "no-referrer" });
  assert.deepEqual(fixture.anchor, {
    href: link.href,
    rel: "noopener noreferrer",
    referrerPolicy: "no-referrer",
    click: fixture.anchor.click,
  });
  assert.equal(fixture.anchorClicked, true);
  assert.equal(fixture.closed, false);
});

test("parent rejects malformed external-link inventories and clamps hostile geometry", () => {
  assert.equal(parseExternalLinkHotspots(null), null);
  assert.equal(parseExternalLinkHotspots({ links: [] }), null);
  assert.deepEqual(parseExternalLinkHotspots([
    { href: "", rects: [{ x: 1, y: 2, w: 3, h: 4 }] },
    { href: "https://www.booking.com/", rects: [{ x: -2, y: 3, w: 30_000_000, h: 0 }] },
    {
      href: "https://www.booking.com/",
      text: " Booking\u0000 link ",
      rects: [
        { x: -2, y: 3, w: 30_000_000, h: 4 },
        { x: Number.NaN, y: 0, w: 1, h: 1 },
      ],
    },
  ]), [{
    href: "https://www.booking.com/",
    text: "Booking  link",
    rects: [{ x: 0, y: 3, w: 10_000_000, h: 4 }],
  }]);
});

test("controlled parent opener reports blocked reservations without navigating", () => {
  const link: AttachmentPreviewExternalLink = {
    href: "https://www.booking.com/",
    hostname: "www.booking.com",
  };
  let openCalls = 0;
  assert.equal(openAttachmentPreviewExternalLink(link, () => {
    openCalls += 1;
    return null;
  }), false);
  assert.equal(openCalls, 1);
});
