// Grok Build agents on the Computer's sign-in share one provider-limit key
// (`shared:grok`, docs/contracts/runtime-auth.md): a usage-limit or billing
// hold one of them hits holds the others too. An agent with its own
// GROK_HOME, HOME or XAI_API_KEY keeps a key of its own.
import assert from "node:assert/strict";
import { providerLimitCredentialKey } from "./providerLimitLedger";
import { promptConfig } from "./testing/promptFixture";

const grok = (envVars: Record<string, string> | null = null) => promptConfig({ runtime: "grok", model: "grok-4.5", envVars });

test("two default Grok agents share shared:grok", () => {
  assert.equal(providerLimitCredentialKey("agent-a", grok()), "shared:grok");
  assert.equal(providerLimitCredentialKey("agent-b", grok()), providerLimitCredentialKey("agent-a", grok()));
});

test("a Grok agent with its own XAI_API_KEY, GROK_HOME or HOME keeps its own key", () => {
  assert.equal(providerLimitCredentialKey("agent-key", grok({ XAI_API_KEY: "xai-own" })), "agent:agent-key");
  assert.equal(providerLimitCredentialKey("agent-home", grok({ GROK_HOME: "/srv/grok-b" })), "agent:agent-home");
  assert.equal(providerLimitCredentialKey("agent-userhome", grok({ HOME: "/srv/home-b" })), "agent:agent-userhome");
});
