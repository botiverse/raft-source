import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { VisualTestingRoot } from "../VisualTestingRoot";
import { preloadInitialLocaleMessages } from "../../src/i18n/preloadLocaleMessages";
import api from "../../src/api/client";
import { useServerStore } from "../../src/store/serverStore";
import { AgentVoiceSection } from "../../src/features/agent/AgentVoiceSection";
import "../../src/index.css";

// Raft voice's Voice section (AgentVoiceSection) drawn with the real component
// on fixture data and a fake API; no server. ?case=askers|empty&mode=light|dark.
const params = new URLSearchParams(window.location.search);
const caseId = params.get("case") ?? "askers";
const mode = params.get("mode") === "dark" ? "dark" : "light";

const ASKERS = [
  { asker: { id: "u1", name: "Artin" }, at: "2026-11-13T18:42:00.000Z", app: { name: "Raft Deck" } },
  { asker: null, at: "2026-11-13T17:05:00.000Z", app: { name: "Raft Deck" } },
  { asker: { id: "u2", name: "Kevin Zhow" }, at: "2026-11-12T09:30:00.000Z", app: null },
];

useServerStore.setState({ current: { id: "server-visual" } } as never);
api.post = (async (url: string, body?: { keys?: string[] }) => {
  if (url === "/feature-flags/evaluate") {
    return { data: { evaluations: (body?.keys ?? []).map((key) => ({ key, enabled: key === "agent_voice_v1" })) } };
  }
  return { data: {} };
}) as typeof api.post;
api.get = (async (url: string) => {
  if (url.endsWith("/voice-settings")) return { data: { askable: true, callable: false } };
  if (url.endsWith("/voice-questions")) return { data: { questions: caseId === "empty" ? [] : ASKERS } };
  return { data: {} };
}) as typeof api.get;
api.put = (async (_url: string, body: Record<string, boolean>) => ({ data: { askable: true, callable: false, ...body } })) as typeof api.put;

const render = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VisualTestingRoot mode={mode}>
      <div data-shot="scene" className="mx-auto w-full max-w-[420px] bg-background">
        <AgentVoiceSection agentId="agent-visual" />
      </div>
    </VisualTestingRoot>
  </StrictMode>,
);
const ready = preloadInitialLocaleMessages();
if (ready) void ready.then(render);
else render();
