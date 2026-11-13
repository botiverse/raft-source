import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { VisualTestingRoot } from "../VisualTestingRoot";
import { preloadInitialLocaleMessages } from "../../src/i18n/preloadLocaleMessages";
import { ClaudeLimitResetStates } from "./ClaudeLimitResetStates";
import "../../src/index.css";

// The Claude limit-reset card and dialogs (claude_limit_reset) drawn with the
// real components on fixture data and a fake client; no server.
// ?case=<id>&mode=light|dark picks the state.
const params = new URLSearchParams(window.location.search);
const caseId = params.get("case") ?? "card-wall";
const mode = params.get("mode") === "dark" ? "dark" : "light";

const render = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VisualTestingRoot mode={mode}>
      <ClaudeLimitResetStates caseId={caseId} />
    </VisualTestingRoot>
  </StrictMode>,
);
const ready = preloadInitialLocaleMessages();
if (ready) void ready.then(render);
else render();
