/**
 * The runtime reads of the RFC 085 `card` list (delegableCardRoutes.ts) and
 * its summary templates (delegableSummaryTemplates.ts), for the
 * request:prepare card. DELEGABLE_CARD_ROUTES is the only source of what a
 * card may run (Tenny, #proj-apps:#62 ab83c67e): an operation is preparable,
 * and a stored card runs, only while its route has an entry there and its
 * entry's template exists. Product code never reads the route classification
 * table (src/test/routeAuthorityClassification.ts).
 *
 * Tests replace both lists with entries of their own
 * (setDelegableCardRegistryForTest); production has no such entries.
 */
import { DELEGABLE_CARD_ROUTES, type DelegableCardRoute, type DelegableRouteKey } from "./delegableCardRoutes";
import { DELEGABLE_SUMMARY_TEMPLATES, type DelegableSummaryTemplate } from "./delegableSummaryTemplates";

export interface DelegableCardEntry {
  routeKey: DelegableRouteKey;
  route: DelegableCardRoute;
  template: DelegableSummaryTemplate;
}

let registryForTest: {
  routes: Readonly<Record<DelegableRouteKey, DelegableCardRoute>>;
  templates: Readonly<Record<string, DelegableSummaryTemplate>>;
} | null = null;

/** Replace the list and its templates (null restores them). Test only. */
export function setDelegableCardRegistryForTest(next: typeof registryForTest): void {
  if (process.env.NODE_ENV !== "test") throw new Error("the delegable card registry hook is test-only");
  registryForTest = next;
}

function routes(): Readonly<Record<DelegableRouteKey, DelegableCardRoute>> {
  return registryForTest?.routes ?? DELEGABLE_CARD_ROUTES;
}

/** A summary template by its id (a stored card's `template`), whether or not its route is still on the list. */
export function delegableSummaryTemplateFor(id: string): DelegableSummaryTemplate | null {
  const templates = registryForTest?.templates ?? DELEGABLE_SUMMARY_TEMPLATES;
  return Object.hasOwn(templates, id) ? templates[id]! : null;
}

/** The list's entry for a route, with its template; null when the route is not (or no longer) on the list. */
export function delegableCardEntryForRoute(routeKey: string): DelegableCardEntry | null {
  const all = routes();
  if (!Object.hasOwn(all, routeKey)) return null;
  const route = all[routeKey as DelegableRouteKey];
  const template = delegableSummaryTemplateFor(route.summaryTemplate);
  return template ? { routeKey: routeKey as DelegableRouteKey, route, template } : null;
}

/** Every entry with its template, in the list's order (entries without one are left out, as prepare refuses them). */
export function delegableCardEntries(): DelegableCardEntry[] {
  return Object.keys(routes()).flatMap((routeKey) => {
    const entry = delegableCardEntryForRoute(routeKey);
    return entry ? [entry] : [];
  });
}

/** The entry whose operation an agent named; null when no entry declares it. */
export function delegableCardEntryForOperation(name: string): DelegableCardEntry | null {
  for (const [routeKey, route] of Object.entries(routes())) {
    if (route.operation.name === name) return delegableCardEntryForRoute(routeKey);
  }
  return null;
}
