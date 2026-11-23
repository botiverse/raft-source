import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { VisualTestingRoot } from "../VisualTestingRoot";
import { preloadInitialLocaleMessages } from "../../src/i18n/preloadLocaleMessages";
import { RuntimeUsageCardStates } from "./RuntimeUsageCardStates";
import "../../src/index.css";

// The runtime usage card (RuntimeUsageSurface) drawn on fixture data; no server.
// ?case=<id>&mode=light|dark picks the state.
const params = new URLSearchParams(window.location.search);
const caseId = params.get("case") ?? "healthy";
const mode = params.get("mode") === "dark" ? "dark" : "light";

const render = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VisualTestingRoot mode={mode}>
      <RuntimeUsageCardStates caseId={caseId} />
    </VisualTestingRoot>
  </StrictMode>,
);
const ready = preloadInitialLocaleMessages();
if (ready) void ready.then(render);
else render();
