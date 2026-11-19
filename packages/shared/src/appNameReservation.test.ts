import assert from "node:assert/strict";
import { appNameReservedMessage, foldAppName, refusalSentenceProblem, reservedAppNameBrand } from "./index";

test("names that read as Raft (or Slock, Botiverse) are reserved", () => {
  const reserved: Array<[string, string]> = [
    ["Raft", "raft"],
    ["raft", "raft"],
    ["  RAFT  ", "raft"],
    ["R a f t", "raft"],
    ["R.A.F.T.", "raft"],
    ["Raft!", "raft"],
    ["Raft @", "raft"],
    ["R4FT", "raft"],
    ["R@ft", "raft"],
    ["Rаft", "raft"], // Cyrillic а
    ["ʀᴀꜰᴛ", "raft"], // small capitals
    ["Ｒａｆｔ", "raft"], // full width
    ["𝐑𝐚𝐟𝐭", "raft"], // mathematical bold
    ["Ráft", "raft"],
    ["Ra​ft", "raft"], // zero-width space
    ["Raft Bot", "raft"],
    ["Raft Official", "raft"],
    ["Official Raft", "raft"],
    ["The Raft", "raft"],
    ["Raft-Notifications", "raft"],
    ["Raft Security", "raft"],
    ["Raft 官方", "raft"],
    ["Slock", "slock"],
    ["S1ock", "slock"],
    ["Botiverse", "botiverse"],
    ["Botiverse Team", "botiverse"],
    // Combinations of role words (1.28.0 security review)
    ["Raft Billing", "raft"],
    ["Raft Security Team", "raft"],
    ["Official Raft Bot", "raft"],
    ["The Official Raft Support Team", "raft"],
    ["Raft 账单通知", "raft"],
    // Look-alikes from other scripts
    ["\u13A1\uAB7Aft", "raft"], // Cherokee R, A (upper case folds to the listed lower case)
    ["Rαƒт", "raft"], // Greek, Latin, Cyrillic mixed
    ["Raֆt", "raft"], // Armenian letter nobody listed (ֆ): unknown look-alike, 3 of 4 spelled
    ["ɼaft Billing", "raft"],
    ["Ѕlock", "slock"],
    ["Bօtiverse", "botiverse"],
    // Role words around "official" only
    ["Official", "official"],
    ["Official Support Bot", "official"],
    ["Official Billing", "official"],
  ];
  for (const [name, brand] of reserved) assert.equal(reservedAppNameBrand(name), brand, name);
});

test("an App's own name that only contains the word stays allowed", () => {
  for (const name of ["Raft Notes Sync", "Rafter", "Aircraft", "Crafty", "Draft", "Raft2Jira", "Stamp", "Mail", "Life Raft Tracker", "Slocker", "Raftable",
    "Draft Bot", "Raft 日记", "Support Bot", "Billing Helper", "Officially Yours", "Рафт", "Плот", "Ψψψψ", "Official Notes"]) {
    assert.equal(reservedAppNameBrand(name), null, name);
  }
});

test("folding drops case, accents, spacing and look-alikes", () => {
  assert.equal(foldAppName("  Ŕáfṭ  Bot "), "raftbot");
  assert.equal(foldAppName("R4FT"), "r4ft");
  assert.equal(foldAppName("R4FT", { symbolsAsLetters: true }), "raft");
});

test("the refusal is one sentence the refusal envelope accepts", () => {
  for (const brand of ["raft", "slock", "botiverse", "official"] as const) {
    assert.equal(refusalSentenceProblem(appNameReservedMessage(brand)), null, brand);
  }
});

test("a very long name is checked in time linear in its length", () => {
  const started = performance.now();
  for (const name of ["raft".repeat(2_500), "bot".repeat(3_400) + "raft", "official".repeat(1_250) + "x"]) reservedAppNameBrand(name);
  assert.ok(performance.now() - started < 2_000, "10,000-character names must not take seconds");
});
