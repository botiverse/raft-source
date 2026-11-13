import { useIntl } from "react-intl";
import type { GuestChannelField } from "@botiverse/raft-shared";
import KeyValueRow from "../ui/KeyValueRow";

/** "Channel: Guest in #x" in a Guest's profile Info (design D1/D2); nothing otherwise. */
export function GuestChannelRow({ human }: { human: GuestChannelField & { role: string | null } }) {
  const { formatMessage } = useIntl();
  if (human.role !== "guest" || !human.guestChannel) return null;
  return (
    <KeyValueRow
      label={formatMessage({ id: "member.detail.channel" })}
      value={formatMessage({ id: "member.detail.guestInChannel" }, { channel: human.guestChannel.name })}
    />
  );
}
