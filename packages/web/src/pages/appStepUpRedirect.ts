/** Leaving AppStepUpPage for the app's custom scheme; replaceable in tests. */
export const appStepUpRedirect = {
  assign: (url: string) => window.location.assign(url),
};
