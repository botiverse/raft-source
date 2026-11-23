import type { RuntimeAuthRuntime } from "@botiverse/raft-shared";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages/en";

/**
 * How a runtime Raft does not sign in (`runtimeAuthStatusOnly`) gets its
 * credentials on the Computer, by runtime. DeepSeek Harness: dsh resolves its
 * key itself (a key saved in dsh's settings, in a mode-600 credentials file,
 * else DEEPSEEK_API_KEY in its environment); OAR has no sign-in for it
 * (docs/contracts/runtime-auth.md).
 */
const CREDENTIALS_NOTE: Partial<Record<RuntimeAuthRuntime, MessageId>> = {
  dsh: "machine.runtimeAuth.dsh.credentials",
};

/** The card line for a status-only runtime; nothing for a runtime with no note. */
export function RuntimeCredentialsNote({ runtime }: { runtime: RuntimeAuthRuntime }) {
  const { formatMessage } = useIntl();
  const id = CREDENTIALS_NOTE[runtime];
  if (!id) return null;
  return (
    <p className="text-caption text-foreground-hint" data-testid="runtime-auth-credentials-note">
      {formatMessage({ id })}
    </p>
  );
}
