import assert from "node:assert/strict";
import { descriptionPieces, descriptionUrls } from "../src/components/message/descriptionLinks";

// A profile description is cut around its addresses so the Artifact ones can
// be drawn as their title chip (ProfileDescription; artin).
const ARTIFACT = "https://app.raft.build/artifacts/TUCt9hmScMEdBpHaTXatxr";

test("a description with no address is one piece of text", () => {
  assert.deepEqual(descriptionPieces("Stamp 负责人。"), [{ kind: "text", text: "Stamp 负责人。" }]);
  assert.deepEqual(descriptionPieces(""), []);
});

test("an address after CJK punctuation, at the end, is cut out whole", () => {
  assert.deepEqual(descriptionPieces(`Stamp 负责人。工作清单：${ARTIFACT}`), [
    { kind: "text", text: "Stamp 负责人。工作清单：" },
    { kind: "link", url: ARTIFACT },
  ]);
});

test("full-width punctuation straight after an address ends it", () => {
  for (const mark of ["，", "。", "、", "；", "：", "！", "？", "）", "」", "】"]) {
    assert.deepEqual(descriptionPieces(`清单：${ARTIFACT}${mark}其余`), [
      { kind: "text", text: "清单：" },
      { kind: "link", url: ARTIFACT },
      { kind: "text", text: `${mark}其余` },
    ], mark);
  }
});

test("sentence punctuation after an address is the sentence's, not the address's", () => {
  assert.deepEqual(descriptionPieces(`See ${ARTIFACT}.`), [
    { kind: "text", text: "See " },
    { kind: "link", url: ARTIFACT },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(descriptionPieces(`(list: ${ARTIFACT}), then`), [
    { kind: "text", text: "(list: " },
    { kind: "link", url: ARTIFACT },
    { kind: "text", text: "), then" },
  ]);
});

test("every address is its own piece, in order, the other links included", () => {
  const other = "https://github.com/botiverse/slock/pull/1";
  const pinned = "https://app.raft.build/artifacts/TUCt9hmScMEdBpHaTXatxr/v/2";
  const pieces = descriptionPieces(`清单 ${ARTIFACT} 代码 ${other} 旧版 ${pinned}`);
  assert.deepEqual(pieces, [
    { kind: "text", text: "清单 " },
    { kind: "link", url: ARTIFACT },
    { kind: "text", text: " 代码 " },
    { kind: "link", url: other },
    { kind: "text", text: " 旧版 " },
    { kind: "link", url: pinned },
  ]);
  assert.deepEqual(descriptionUrls(pieces), [ARTIFACT, other, pinned]);
});

test("the pieces always join back into the description", () => {
  for (const text of [`a ${ARTIFACT}，b http://x.test/y. c`, "https:// alone", `${ARTIFACT}${ARTIFACT}`]) {
    const joined = descriptionPieces(text).map((piece) => (piece.kind === "text" ? piece.text : piece.url)).join("");
    assert.equal(joined, text);
  }
});
