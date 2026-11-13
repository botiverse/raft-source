import assert from "node:assert/strict";
import { appLinkDomain, appLinkOpenHref, appLinkShortAddress } from "../src/utils/appLinkAddress";

// The domain Raft shows next to an App's own title (protocol v3.2.3 addendum 5
// §2a; raft-design #749): the full hostname, so a title can't pass the link
// off as somewhere else.
test("the domain is the link's full hostname with only a leading www. removed", () => {
  assert.equal(appLinkDomain("https://www.github.com/acme/repo/pull/123"), "github.com");
  // Never cut to the registrable domain: a subdomain may belong to someone else.
  assert.equal(appLinkDomain("https://pages.attacker.github.io/pr/1"), "pages.attacker.github.io");
  assert.equal(appLinkDomain("https://issues.example.test/acme/repo/pull/7?tab=files#c1"), "issues.example.test");
  assert.equal(appLinkDomain("https://www2.example.test/x"), "www2.example.test");
  assert.equal(appLinkDomain("https://example.test.www/x"), "example.test.www");
});

test("a non-ASCII hostname is shown in its punycode form", () => {
  assert.equal(appLinkDomain("https://gíthub.com/acme/repo/pull/123"), "xn--gthub-zsa.com");
  assert.equal(appLinkDomain("https://www.例子.测试/pr/1"), "xn--fsqu00a.xn--0zwm56d");
});

test("only http and https links have a domain or an address Raft opens", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "file:///etc/passwd", "not a url", ""]) {
    assert.equal(appLinkDomain(url), null, url);
    assert.equal(appLinkOpenHref(url), null, url);
    assert.equal(appLinkShortAddress(url), null, url);
  }
  assert.equal(appLinkOpenHref("https://example.test/pr/1"), "https://example.test/pr/1");
});

test("the short address is the domain and path, without query or fragment", () => {
  assert.equal(appLinkShortAddress("https://www.stamp.build/botiverse/slock/pull/10449?tab=files#top"), "stamp.build/botiverse/slock/pull/10449");
  assert.equal(appLinkShortAddress("https://stamp.build/"), "stamp.build");
});
