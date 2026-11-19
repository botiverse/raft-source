import type { IntlShape } from "react-intl";

import type { MessageId } from "../../../i18n/messages/en";

/** The client's own platform claim (X-Raft-Client-Platform) as a person names it; a browser tab and an installed web app are both Web. */
const PLATFORM_LABEL_IDS: Record<string, MessageId> = {
  browser: "settings.account.signedInDevices.platformWeb",
  pwa: "settings.account.signedInDevices.platformWeb",
  desktop_app: "settings.account.signedInDevices.platformDesktop",
  ios: "settings.account.signedInDevices.platformIos",
  android: "settings.account.signedInDevices.platformAndroid",
  harmonyos: "settings.account.signedInDevices.platformHarmonyOs",
};

/** "Web", "Desktop", "iOS", ...; "Unknown device" for a sign-in from before platforms were recorded. */
export function signedInDeviceLabel(platform: string | null, formatMessage: IntlShape["formatMessage"]): string {
  const id = (platform && PLATFORM_LABEL_IDS[platform]) || "settings.account.signedInDevices.platformUnknown";
  return formatMessage({ id });
}
