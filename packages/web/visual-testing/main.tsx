import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import VisualTestingCases, { requestedTheme } from "./VisualTestingCases";
import { VisualTestingRoot } from "./VisualTestingRoot";
import { useTranslationStore } from "../src/store/translationStore";
import fixtureData from "../../visual-testing/shared/fixtureData.json";
import "../src/index.css";

// The shared fixture declares its own clock (`locale.timezone` / `locale.timeFormat`);
// Android's visual host already renders with it. Without this seed the web capture
// falls back to the CI browser's zone and hour cycle, so the same fixture instant
// rendered "06/22 02:30 AM" on web and "06/22 10:30" on Android (task #536, S1).
// Language is deliberately NOT seeded here: the UI locale must keep following the
// case, not the fixture's translation language.
useTranslationStore.setState((state) => ({
  settings: {
    ...state.settings,
    preferredTimezone: fixtureData.locale.timezone,
    effectiveTimezone: fixtureData.locale.timezone,
    preferredTimeFormat: fixtureData.locale.timeFormat as "12h" | "24h",
    effectiveTimeFormat: fixtureData.locale.timeFormat as "12h" | "24h",
  },
}));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VisualTestingRoot defaultTheme={requestedTheme()}>
      <VisualTestingCases />
    </VisualTestingRoot>
  </StrictMode>
);
