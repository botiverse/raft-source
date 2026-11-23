import { Text } from "@botiverse/raft-ui";
import { AppCard, AppCardSkeleton } from "../src/features/apps/AppCard";
import type { AppCardProps } from "../src/features/apps/AppCard";
import type { AppView } from "../src/features/apps/appView";

// The redesigned App card (features/apps/AppCard.tsx) in every state and
// variant, one sheet per case (the React provider shoots one image per case),
// from fixture AppViews, with no page around it: each card under its state's
// name, wrapped in [data-app-card-case].
// `.states`: two columns, as the Apps page lays cards out on a desktop.
// `.narrow`: one column in a 360px window, where each card is under 360px
// wide and its button takes a line of its own.
// `.dark`: the same sheets in the dark theme.

export const APP_CARD_CASE_IDS = [
  "components.apps.app-card.states",
  "components.apps.app-card.states.dark",
  "components.apps.app-card.narrow",
  "components.apps.app-card.narrow.dark",
] as const;

const BASE: AppView = {
  id: "visual-app",
  kind: "raftApp",
  appId: "visual-app",
  name: "Linear",
  description: "Plan work, track issues and keep the roadmap in one place.",
  logoUrl: null,
  logoSeed: "linear",
  official: false,
  origin: "marketplace",
  publisherName: "Linear",
  listedByRaft: false,
  createdByUserId: null,
  reach: null,
  added: true,
  state: "normal",
  needsAttention: false,
};

type CardFixture = readonly [state: string, app: AppView, props?: Pick<AppCardProps, "variant" | "creatorName"> & { member?: boolean }];

/** The fixture cards, by the state each shows. */
export const APP_CARD_STATES: readonly CardFixture[] = [
  ["normal", { ...BASE, reach: "100_plus" }],
  ["official", { ...BASE, id: "stamp", name: "Stamp", logoSeed: "stamp", description: "Connect GitHub: agents push code and open pull requests; you review and merge.", official: true, publisherName: "Raft", reach: "1k_plus" }],
  ["internal", { ...BASE, id: "deploys", name: "Deploy bot", logoSeed: "deploys", description: "Posts each deploy to #releases.", origin: "internal", publisherName: null, createdByUserId: "visual-alice" }, { creatorName: "Alice" }],
  ["shared", { ...BASE, id: "ledger", name: "Ledger", logoSeed: "ledger", description: "Expense reports for the finance team.", origin: "shared", publisherName: "Acme Finance" }],
  ["long-name-long-description", {
    ...BASE,
    id: "long",
    name: "Customer Relationship and Revenue Operations Workbench for Enterprise Teams",
    logoSeed: "long",
    description: "Find any account, contact or opportunity, read its whole history, draft the follow-up and log the call, without leaving the conversation you are in. Works across every pipeline and region your team has set up, and keeps each record in step with the source.",
    official: true,
    publisherName: "Customer Relationship and Revenue Operations Software Incorporated",
    reach: "10_plus",
  }],
  ["updateNeedsApproval", { ...BASE, id: "figma", name: "Figma", logoSeed: "figma", description: "Read files and comments, and post design updates.", publisherName: "Figma", state: "updateNeedsApproval", needsAttention: true }],
  ["signInExpired", { ...BASE, id: "notion", kind: "connectedService", name: "Notion", logoSeed: "notion", description: "Search and edit your team's pages.", publisherName: "Notion", listedByRaft: true, state: "signInExpired", needsAttention: true }],
  ["cannotConnect", { ...BASE, id: "wiki", kind: "connectedService", name: "Team wiki", logoSeed: "wiki", description: null, origin: "internal", publisherName: null, state: "cannotConnect", needsAttention: true }],
  ["discover-add", { ...BASE, id: "sentry", name: "Sentry", logoSeed: "sentry", description: "See errors and releases, and triage issues.", publisherName: "Sentry", reach: "100_plus", added: false }, { variant: "discover" }],
  ["discover-added", { ...BASE, reach: "100_plus", added: true }, { variant: "discover" }],
];

const noop = () => undefined;

export function AppCardCase({ caseId }: { caseId: string }) {
  const narrow = caseId.includes(".narrow");
  return (
    <main className="min-h-screen bg-layer-canvas font-display text-foreground">
      <div
        data-visual-case={caseId}
        className={narrow ? "grid w-[360px] grid-cols-1 gap-3 p-4" : "grid w-[960px] grid-cols-2 gap-3 p-6"}
      >
        {APP_CARD_STATES.map(([state, app, props]) => (
          <div key={state} data-app-card-case={state} className="flex min-w-0 flex-col gap-1">
            <Text.Mono size="meta">{state}</Text.Mono>
            <AppCard
              app={app}
              variant={props?.variant}
              creatorName={props?.creatorName}
              onOpen={noop}
              onAction={props?.member ? undefined : noop}
              onAdd={props?.member ? undefined : noop}
            />
          </div>
        ))}
        <div data-app-card-case="skeleton" className="flex min-w-0 flex-col gap-1">
          <Text.Mono size="meta">skeleton</Text.Mono>
          <AppCardSkeleton />
        </div>
      </div>
    </main>
  );
}
