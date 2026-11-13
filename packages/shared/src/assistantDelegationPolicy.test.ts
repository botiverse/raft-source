import { describe, expect, it } from "vitest";
import { AGENT_API_ROUTE_META } from "./agentApiRouteMeta";
import { agentApiContract } from "./agentApiContract";
import {
  ASSISTANT_DELEGATION_POLICY,
  ASSISTANT_DELEGATION_REFUSED_ACTION,
  assistantDelegationCategory,
  assistantDelegationRefusedText,
} from "./assistantDelegationPolicy";

// RFC 080 §4.2. Changing the table is a permission change: update this count
// in the same PR, and get it reviewed (Tenny, Warden).
const PINNED_DELEGABLE_ROUTES = 5;

describe("assistant delegation policy", () => {
  const entries = Object.entries(ASSISTANT_DELEGATION_POLICY);

  it("pins the number of delegable routes", () => {
    expect(entries).toHaveLength(PINNED_DELEGABLE_ROUTES);
  });

  it("names only routes that exist", () => {
    for (const [routeKey] of entries) expect(agentApiContract).toHaveProperty(routeKey);
    for (const routeKey of Object.keys(ASSISTANT_DELEGATION_REFUSED_ACTION)) expect(agentApiContract).toHaveProperty(routeKey);
  });

  it("delegates reads and searches only on read-only routes", () => {
    for (const [routeKey, category] of entries) {
      if (category === "send") continue;
      expect(AGENT_API_ROUTE_META[routeKey as keyof typeof AGENT_API_ROUTE_META].sideEffect, routeKey).toBe("read");
    }
  });

  it("has exactly one send route: the message send that records delegated_by", () => {
    expect(entries.filter(([, category]) => category === "send").map(([routeKey]) => routeKey)).toEqual(["messageSendV2"]);
  });

  it("refuses every route that is not in the table, including inherited object keys", () => {
    expect(assistantDelegationCategory("historyRead")).toBe("read");
    expect(assistantDelegationCategory("messageSearch")).toBe("search");
    expect(assistantDelegationCategory("messageReactionAdd")).toBeNull();
    expect(assistantDelegationCategory("taskUpdateStatus")).toBeNull();
    expect(assistantDelegationCategory("toString")).toBeNull();
    expect(assistantDelegationCategory("__proto__")).toBeNull();
    for (const routeKey of Object.keys(agentApiContract)) {
      expect(assistantDelegationCategory(routeKey) === null, routeKey).toBe(!(routeKey in ASSISTANT_DELEGATION_POLICY));
    }
  });

  it("never puts a route key in the refusal sentence", () => {
    expect(assistantDelegationRefusedText({ owner: "Ada", routeKey: "messageReactionAdd" }))
      .toBe("Ada has to do this themselves: an assistant can't add a reaction as its owner. Tell Ada in your DM what to do.");
    expect(assistantDelegationRefusedText({ owner: "Ada", routeKey: "channelArchive" }))
      .toBe("Ada has to do this themselves: an assistant can't do this as its owner. Tell Ada in your DM what to do.");
  });
});
