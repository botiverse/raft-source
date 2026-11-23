import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { TextLink } from "@botiverse/raft-ui";
import Banner from "../ui/Banner";
import type { FirstAgentStartFailureView } from "./useFirstAgentStartFailure";

/**
 * The first agent could not start (mail #214: Cindy exited a second after each
 * start, and the page said nothing). Says so plainly, and what the next step is:
 * a sign-in where the error is one or the Computer reports the runtime signed out,
 * else another runtime. The card holds no button (Cat, Raft DS Banner: never a
 * pink button in a banner): the step's footer carries the action as the page's
 * primary. "Or switch to another runtime." stays in the text, as a word of it.
 */
export function FirstAgentStartFailureNotice({
  start,
  computerName,
  onSwitchRuntime,
}: {
  start: FirstAgentStartFailureView;
  computerName: string;
  /** Where the agent's runtime is changed (its profile). Absent: the copy says only what to do on the Computer. */
  onSwitchRuntime?: () => void;
}) {
  const { formatMessage } = useIntl();
  if (!start.failed) return null;
  const values = { name: start.name, runtime: start.runtimeName, computer: computerName };
  const switchLink = (chunks: ReactNode) => (
    <TextLink key="switch" variant="strong" nativeButton={false} onClick={onSwitchRuntime} data-testid="first-agent-failed-switch-runtime">
      {chunks}
    </TextLink>
  );
  return (
    <Banner
      intent="warning"
      withIcon
      data-testid="first-agent-start-failed"
      title={formatMessage({ id: "onboarding.firstAgentFailed.title" }, { name: start.name })}
    >
      {/* One paragraph: "Or switch to another runtime." runs on after the sentence and wraps with it. */}
      <p>
        {/* Another failure where Switch runtime isn't offered (the native page): the way there is skip, then her profile (Cat). */}
        {formatMessage({
          id: start.signInNext
            ? "onboarding.firstAgentFailed.signIn"
            : onSwitchRuntime ? "onboarding.firstAgentFailed.other" : "onboarding.firstAgentFailed.otherNoSwitch",
        }, values)}
        {start.signInNext && onSwitchRuntime ? (
          <>{" "}{formatMessage({ id: "onboarding.firstAgentFailed.orSwitchRuntime" }, { link: switchLink })}</>
        ) : null}
      </p>
    </Banner>
  );
}
