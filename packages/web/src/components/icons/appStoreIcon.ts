/**
 * The App Store app icon (the blue "A"), from Apple's developer marketing
 * assets (https://developer.apple.com/assets/elements/icons/app-store/
 * app-store-128x128_2x.png), used unmodified (resized only, transparent margin
 * kept, as Apple's guidelines ask for provided artwork). Shown at the
 * start of our own outline button, the same treatment as Google Play's mark
 * (googlePlayIcon.ts): the full black badge clashed with the paper buttons
 * beside it (artin, #triage:#96), and Jasper chose the App Store icon over the
 * Apple logo, which Apple's guidelines do not allow standalone.
 */
export const APP_STORE_ICON_URL = new URL("../../assets/icons/app_store.png", import.meta.url).href;
