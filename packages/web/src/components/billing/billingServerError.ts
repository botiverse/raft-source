/** The server's own sentence in a failed billing request (`{ error }` in the body), if it sent one. */
export function billingServerError(err: unknown): string | undefined {
  return (err as { response?: { data?: { error?: string } } }).response?.data?.error;
}
