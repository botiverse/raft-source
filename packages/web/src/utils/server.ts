import { assertValidDesktopRuntimeEnvironment, RUNTIME_API_ORIGIN } from "../desktopRuntimeEnvironment";

/**
 * Derive the server URL for machine connections.
 */
export function getServerUrl(): string {
  assertValidDesktopRuntimeEnvironment();

  if (RUNTIME_API_ORIGIN.includes(":5173")) {
    return RUNTIME_API_ORIGIN.replace(":5173", ":3001");
  }
  if (RUNTIME_API_ORIGIN) {
    return RUNTIME_API_ORIGIN;
  }
  return window.location.origin;
}
