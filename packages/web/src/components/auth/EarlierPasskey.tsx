/**
 * "Use an earlier passkey" in the sign-in's second step and every step-up:
 * shown while useEarlierPasskey.ts offers the other RP group; its click asks
 * for that group's options and prompts once.
 */
import { TextLink } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";

export function EarlierPasskeyLink({ onUse, disabled, className }: { onUse: () => void; disabled: boolean; className?: string }) {
  const { formatMessage } = useIntl();
  return (
    <div className={className}>
      <TextLink type="button" className="text-footnote" onClick={onUse} disabled={disabled}>
        {formatMessage({ id: "auth.secondFactor.useEarlierPasskey" })}
      </TextLink>
    </div>
  );
}
