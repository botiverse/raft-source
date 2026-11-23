// #457: the fixes offered for each warning (every intent, widening never
// first) and their English words for agents and people; an unavailable
// link's text names only the link.
import assert from "node:assert/strict";
import { DESCRIPTION_AUDIENCE_REMINDER, DESCRIPTION_LINK_WARNING_CODES, descriptionLinkFixes, descriptionLinkFixesOf, descriptionLinkFixTexts, descriptionLinkProblem, formatDescriptionLinkWarnings } from "./descriptionLinkWarnings";

const object = { kind: "artifact", id: "pt_abc" };
const url = "https://app.raft.build/artifacts/TUCt9hmScMEdBpHaTXatxr";

test("each code offers every fix that applies; the widest audience is never first and comes last", () => {
  for (const subject of ["agent", "person"] as const) {
    for (const code of DESCRIPTION_LINK_WARNING_CODES) {
      const fixes = descriptionLinkFixes(code, subject);
      assert.ok(fixes.length > 0, code);
      assert.notEqual(fixes[0], "widen_to_server", code);
      assert.notEqual(fixes[0], "make_public", code);
      if (fixes.includes("make_public")) assert.equal(fixes.at(-1), "make_public", `${subject} ${code}: anyone with the link last`);
    }
  }
  // An agent's description is read by its server only: the whole server reaches every reader, so never "anyone with the link" (Sage).
  assert.deepEqual(descriptionLinkFixes("conversation", "agent"), ["public_copy", "leave_out", "widen_to_server"]);
  assert.deepEqual(descriptionLinkFixes("other_server", "agent"), ["public_copy", "leave_out", "make_public"], "another server's object: only public reaches the readers");
  assert.deepEqual(descriptionLinkFixes("conversation", "person"), ["public_copy", "leave_out", "widen_to_server", "make_public"]);
  assert.deepEqual(descriptionLinkFixes("server_partial", "person"), ["public_copy", "leave_out", "make_public"]);
  assert.deepEqual(descriptionLinkFixes("unavailable", "agent"), ["replace_link"]);
  // One link warned of in two servers: each fix once, in the same order.
  assert.deepEqual(descriptionLinkFixesOf(["conversation", "other_server"], "person"), ["public_copy", "leave_out", "widen_to_server", "make_public"]);
  for (const subject of ["agent", "person"] as const) {
    for (const code of DESCRIPTION_LINK_WARNING_CODES) assert.deepEqual(descriptionLinkFixesOf([code], subject), descriptionLinkFixes(code, subject), code);
  }
});

test("an agent gets commands with the real id and asks a person to make it public; a person gets the web's menu", () => {
  const agent = descriptionLinkFixTexts("conversation", object, { writer: "agent", subject: "agent", channel: null });
  assert.ok(agent.some((fix) => fix.includes("raft artifact move pt_abc --to server") && fix.includes("everyone in the server will be able to see all of its contents")));
  assert.ok(agent.every((fix) => !fix.includes("Anyone with the link")), "an agent's description never asks for public");
  assert.ok(agent.some((fix) => fix.includes("separate version") && fix.includes("raft artifact move <new id> --to server")), "the copy only needs to reach the server");
  assert.ok(agent.some((fix) => fix.includes("pin it where its readers already are")), "no channel: no announcement command");
  const other = descriptionLinkFixTexts("other_server", object, { writer: "agent", subject: "agent", channel: null });
  assert.ok(other.some((fix) => fix.includes("only a person can do this; ask its author, your owner or a server admin")));
  const person = descriptionLinkFixTexts("conversation", object, { writer: "person", subject: "person" });
  assert.ok(person.every((fix) => !fix.includes("raft ")));
  assert.ok(person.some((fix) => fix.includes(`"Anyone with the link" under "Who can see"`)));
  assert.ok(person.some((fix) => fix.includes("change who can see it to everyone in the server")), "the server's option is labelled by its name: not quoted");
});

test("an unavailable link is named by its link only; the warning text is one line per fix after its Warning line", () => {
  const problem = descriptionLinkProblem({ code: "unavailable", url, object });
  assert.equal(problem, `some readers of this description can't open the link ${url} (it doesn't exist, was deleted, or you can't open it either).`);
  const text = formatDescriptionLinkWarnings([{ code: "unavailable", url, object, fixes: descriptionLinkFixTexts("unavailable", object, { writer: "agent", subject: "agent" }) }]);
  assert.deepEqual(text.split("\n"), [`Warning: your description was saved, but ${problem}`, "  Fix: Check the link, or take it out of the description", DESCRIPTION_AUDIENCE_REMINDER]);
  assert.equal(formatDescriptionLinkWarnings([]), "");
  const named = descriptionLinkProblem({ code: "server_partial", url, object, server: { id: "s", name: "Acme" }, unreadable: ["guests", "other_servers"] });
  assert.match(named, /^Artifact pt_abc \(https:.*\) is open to the members of its server in Acme only, so its guests and people of other servers in its shared channels, who can see the description, can't open it\.$/);
});
