import { useState } from "react";
import { useChannelStore } from "../../store/channelStore";

const NO_ACTIVITY: Record<string, string | null> = {};

/**
 * Each conversation's latest activity, for the order of the forward dialog's
 * destinations, as it was when the dialog opened: the order then holds while
 * the dialog is open, so a row does not move under the pointer when a message
 * arrives somewhere. Not asked for: no activity, the list's own order.
 */
export function useForwardActivity(orderByChannelActivity: boolean): Record<string, string | null> {
  const [activity] = useState(() => (orderByChannelActivity ? useChannelStore.getState().channelActivity : NO_ACTIVITY));
  return activity;
}
