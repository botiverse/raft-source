type SocialAuthCompletionMode = "login" | "link" | string | null;

function isLinkAuthRequired(error: unknown): boolean {
  const response = (error as {
    response?: { status?: number; data?: { code?: string } };
  } | null)?.response;
  return response?.status === 401 && response.data?.code === "auth_required";
}

/**
 * Link completion must prove the current Raft user. If its short-lived access
 * token expired during the provider round-trip, refresh the existing session
 * once and retry the same one-time completion. Login completions and all other
 * failures remain untouched.
 */
export async function completeSocialAuthWithOneLinkRefresh<T>(params: {
  mode: SocialAuthCompletionMode;
  complete: () => Promise<T>;
  refresh: () => Promise<unknown>;
}): Promise<T> {
  try {
    return await params.complete();
  } catch (error) {
    if (params.mode !== "link" || !isLinkAuthRequired(error)) throw error;
    await params.refresh();
    return params.complete();
  }
}
