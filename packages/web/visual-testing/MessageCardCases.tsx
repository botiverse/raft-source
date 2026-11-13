import { MessageCardBody } from "../src/components/message/MessageCardBody";
import { readMessageCard } from "../src/components/message/messageCardRead";

// RFC 082 v2.0 (§4.8) card messages for Kirby's review: the card header (three
// tags, light and dark), Fields on a phone-width card, and a Markdown block
// with a list and a quote. The real MessageCardBody, reading each card through
// the shared stored-card schema as the web reads a message (`?case=…`).

export const MESSAGE_CARD_CASE_IDS = [
  "components.message-card.header",
  "components.message-card.header.dark",
  "components.message-card.fields.phone",
  "components.message-card.markdown",
] as const;

const column = (children: string[]) => ({ type: "Stack", props: {}, children });
const text = (value: string, tone = "default") => ({ type: "Text", props: { text: value, tone } });

const HEADER_CARDS = [
  {
    version: 1,
    header: {
      title: "Play rejected this submission: 1.20.0",
      subtitle: "Raft Android · Google Play · production",
      tags: [{ text: "Failed", tone: "danger" }, { text: "Policy issue", tone: "warning" }, { text: "Android", tone: "neutral" }],
    },
    root: "root",
    elements: { root: column(["note"]), note: text("Resubmit after the target API fix.") },
  },
  {
    version: 1,
    header: {
      title: "Deploy to production: web 2026.11.05",
      subtitle: "3 of 4 regions",
      tags: [{ text: "Rolling out", tone: "info" }, { text: "Healthy", tone: "success" }, { text: "Web", tone: "neutral" }],
    },
    root: "root",
    elements: { root: column(["note"]), note: text("eu-west is next.", "muted") },
  },
];

const FIELDS_CARD = {
  version: 1,
  header: { title: "TestFlight build ready", tags: [{ text: "Ready", tone: "success" }] },
  root: "facts",
  elements: {
    facts: { type: "Fields", props: { items: [
      { label: "Version", value: "1.20.0 (12000003)", mono: true },
      { label: "Groups", value: "Internal, Botiverse beta testers, External reviewers" },
      { label: "Uploaded", value: "2026-11-05 09:12 UTC", mono: true },
      { label: "Commit", value: "4e4bcbd15d8f0c2a91b7e3d64f5a0c1e9b2d7f36", mono: true },
      { label: "What to test", value: "Sign in with Apple, push notifications after a cold start, and the new card messages in a thread." },
    ] } },
  },
};

const MARKDOWN_CARD = {
  version: 1,
  root: "root",
  elements: {
    root: column(["notes", "rule", "open"]),
    notes: { type: "Markdown", props: { content: [
      "Google says the **target API level** is too low for new submissions.",
      "",
      "- raise `targetSdk` to 35 in `app/build.gradle.kts`",
      "- rebuild and upload **1.20.1**",
      "  - keep the release notes",
      "- ask @artin before resubmitting",
      "",
      "> Your app currently targets API level 34 and must target at least API level 35.",
      "",
      "See [the target API policy](https://support.google.com/googleplay/android-developer/answer/11926878).",
    ].join("\n") } },
    rule: { type: "Divider", props: {} },
    open: { type: "Button", props: { label: "Open in Play Console", action: { kind: "navigate", url: "https://play.google.com/console/" } } },
  },
};

function cardsFor(caseId: string): unknown[] {
  if (caseId === "components.message-card.fields.phone") return [FIELDS_CARD];
  if (caseId === "components.message-card.markdown") return [MARKDOWN_CARD];
  return HEADER_CARDS;
}

export function MessageCardCase({ caseId }: { caseId: string }) {
  const phone = caseId.endsWith(".phone");
  return (
    <main className="min-h-screen bg-layer-canvas p-0 font-display text-foreground">
      <div data-visual-case={caseId} className="flex flex-col gap-4 p-4" style={{ width: phone ? 390 : 640 }}>
        {cardsFor(caseId).map((card, index) => {
          const read = readMessageCard({ kind: "message-card", card, revision: 1, updatedAt: "2026-11-05T09:12:00.000Z" });
          if (!read) throw new Error(`${caseId}: the web can't read card ${index}`);
          return (
            <div key={index} className="flex min-w-0 gap-3">
              <div className="size-9 shrink-0 rounded-full bg-fill-muted" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-sm"><span className="font-semibold">Hands</span><span className="text-xs text-foreground-hint">09:12</span></div>
                <MessageCardBody read={read} />
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
