// The keyboard shortcuts the signed-in account changed (#proj-frontend:#37), handed to the registry's state
// (overridesState.ts) as authStore changes. Imported for its effect by the app shell (MainLayout), the panel's editor,
// Settings' entry and the otter's shortcut, never by the dispatcher: modules that only register a key (a lightbox in
// rendered Markdown) stay importable where authStore can't load (node tests with no localStorage).

import { useAuthStore } from "../../store/authStore";
import { publishShortcutUser } from "./overridesState";

publishShortcutUser(useAuthStore.getState().user);
useAuthStore.subscribe((state) => publishShortcutUser(state.user));
