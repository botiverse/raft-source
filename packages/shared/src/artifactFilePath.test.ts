import assert from "node:assert/strict";
import { isGitPathSegment, isWellFormedArtifactFilePath } from "./artifactFilePath";

// Inputs as the router hands them over: percent-decoded once.
test("paths a version can hold pass", () => {
  for (const path of ["index.html", "assets/logo.png", "a b/c d.txt", "..hidden", "a..b", "é/ü.md", "x.html."]) {
    assert.equal(isWellFormedArtifactFilePath(path), true, path);
  }
});

test("malformed paths are refused, however they were encoded", () => {
  const refused = [
    "", ".", "..", "../index.html", "assets/../../secret", "assets/./logo.png", // dot segments
    "/index.html", "assets/", "assets//logo.png", // empty segments
    "assets\\logo.png", "index.html\u0000", "index\n.html", "index\u007f.html", "index‎.html", // backslash, control, format
    "a?b", "a#b", // query and fragment characters
    "100%.html", // a stray percent sign
    "%2e%2e/index.html", "%2E%2E", "..%2Findex.html", // still encoded after the router's decode
    "%2e%2e%2f%zz", "%zz%2f..%2findex.html", "%2e%2e%25", // encoded traversal beside a stray `%`
    "%252e%252e", // deeper encodings
  ];
  for (const path of refused) assert.equal(isWellFormedArtifactFilePath(path), false, JSON.stringify(path));
});

test("no part of a path may be git's own: .git in any case, with trailing dots or spaces, or git~1", () => {
  const refused = [".git", ".git/config", ".git/HEAD", "site/.git/hooks/post-checkout", ".GIT/config", ".Git", ".git.", ".git ", ".git. .", "git~1/config", "GIT~1", ".git::$INDEX_ALLOCATION/config", ".GIT:stream", "git~1::$DATA"];
  for (const path of refused) assert.equal(isWellFormedArtifactFilePath(path), false, JSON.stringify(path));
  for (const path of [".gitignore", ".github/workflows/ci.yml", "a.git", "git", "my.git.html", ".gitkeep", "git~2", "notes 10:30.md", "a:.git"]) {
    assert.equal(isWellFormedArtifactFilePath(path), true, path);
  }
  assert.equal(isGitPathSegment(".GiT"), true);
  assert.equal(isGitPathSegment(".gitignore"), false);
});
