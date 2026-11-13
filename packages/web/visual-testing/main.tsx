import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import VisualTestingCases, { requestedContentLang, requestedMode } from "./VisualTestingCases";
import { VisualTestingRoot } from "./VisualTestingRoot";
import { preloadInitialLocaleMessages } from "../src/i18n/preloadLocaleMessages";
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

// A zh-CN reader's app runs under lang="zh-CN", and Chrome picks the CJK
// fallback font by lang: under the page's lang="en" it drew Chinese with a
// face that centres full-width punctuation (，：；（), which no zh-CN user sees.
// <body> rather than <html>: LocaleProvider owns <html lang> for the UI
// language, and portals (menus, dialogs) mount in <body>, so they inherit it.
document.body.lang = requestedContentLang();

// Captures must not race the on-demand catalog of a non-English case.
const renderCases = () => ReactDOM.createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <VisualTestingRoot mode={requestedMode()}>
      <VisualTestingCases />
    </VisualTestingRoot>
  </StrictMode>
);
const initialLocaleReady = preloadInitialLocaleMessages();
if (initialLocaleReady) void initialLocaleReady.then(renderCases);
else renderCases();
