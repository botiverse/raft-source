import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { VisualTestingRoot } from "../VisualTestingRoot";
import { preloadInitialLocaleMessages } from "../../src/i18n/preloadLocaleMessages";
import { AgentUsageStates } from "./AgentUsageStates";
import { MembersUsageStates } from "./MembersUsageStates";
import "../../src/index.css";

// The agent panel's Usage tab (agent_usage_v0) drawn with the real
// component on the fixture (agentUsageFixture.ts) and no server, for local
// screenshots: ?agent=codex|mixed|claude&mode=light|dark; Members › Agents ›
// Usage with ?view=members&width=<px>.
const params = new URLSearchParams(window.location.search);
const mode = params.get("mode") === "dark" ? "dark" : "light";
const agent = params.get("agent") ?? "codex";
const members = params.get("view") === "members";
const width = Number(params.get("width")) || 1100;

const render = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VisualTestingRoot mode={mode}>
      {members ? <MembersUsageStates width={width} /> : <AgentUsageStates agent={agent} />}
    </VisualTestingRoot>
  </StrictMode>,
);
const ready = preloadInitialLocaleMessages();
if (ready) void ready.then(render);
else render();
