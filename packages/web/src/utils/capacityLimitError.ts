/**
 * Whether a create error is the server's agent or seat limit. The server
 * answers 400 with `formatBillingCapacityLimitMessage` ("Seat limit reached
 * (1/1 on Pro plan).") and no code, so the message is the contract. Create
 * Agent and Create Assistant both show it with a link to the plans.
 */
export function isCapacityLimitError(message: string): boolean {
  return message.includes("limit reached");
}
