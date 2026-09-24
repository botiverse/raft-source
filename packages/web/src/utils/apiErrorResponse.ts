export interface ApiErrorResponse {
  status?: number;
  error?: string;
}

export function getApiErrorResponse(error: unknown): ApiErrorResponse | undefined {
  if (!error || typeof error !== "object" || !("response" in error)) return undefined;
  const response = error.response;
  if (!response || typeof response !== "object") return undefined;

  const status = "status" in response && typeof response.status === "number"
    ? response.status
    : undefined;
  const data = "data" in response ? response.data : undefined;
  const message = data && typeof data === "object" && "error" in data && typeof data.error === "string"
    ? data.error
    : undefined;

  return { status, error: message };
}
