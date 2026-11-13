// Installing an app or approving its update sends back the login scopes and
// data groups the admin was shown; the server records them only while they
// still match the app's declaration. Send the set you displayed,
// and display the set you send: AppPermissionSetList renders it unfiltered.
export type AppPermissionSet = {
  scopes: string[];
  groups: string[];
};

export function expectedAppPermissionsBody(scopes: readonly string[], groups: readonly string[]) {
  return { expected_scopes: [...scopes], expected_groups: [...groups] };
}

type ApiErrorShape = {
  response?: {
    status?: number;
    data?: { code?: unknown; current_scopes?: unknown; current_groups?: unknown };
  };
} | null;

function responseOf(error: unknown) {
  return (error as ApiErrorShape)?.response;
}

/** The app's scopes or groups changed after they were shown: reload, then let the admin confirm again. */
export function isAppPermissionsChangedError(error: unknown): boolean {
  const response = responseOf(error);
  return response?.status === 409 && response.data?.code === "APP_PERMISSIONS_CHANGED";
}

/** The request carried no expected set: this page predates the check. Only a reload fixes it. */
export function isExpectedPermissionsRequiredError(error: unknown): boolean {
  const response = responseOf(error);
  return response?.status === 400 && response.data?.code === "EXPECTED_PERMISSIONS_REQUIRED";
}

function stringList(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.every((value) => typeof value === "string") ? raw as string[] : null;
}

/**
 * The app's current set from an APP_PERMISSIONS_CHANGED response, so the page
 * can show what the next confirm would approve without a reload. Null when the
 * response doesn't carry it (the action card execute path, for one).
 */
export function appPermissionsChangedCurrentSet(error: unknown): AppPermissionSet | null {
  if (!isAppPermissionsChangedError(error)) return null;
  const data = responseOf(error)?.data;
  const scopes = stringList(data?.current_scopes);
  const groups = stringList(data?.current_groups);
  return scopes && groups ? { scopes, groups } : null;
}
