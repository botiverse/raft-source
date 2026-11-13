import type { ComponentProps } from "react";

/**
 * An anchor that opens its page in a new tab, for a raft-ui Button or
 * TextLink `render`. It drops the `type` a Button passes: an anchor has none.
 */
export function NewTabLink({ children, type: _buttonType, ...props }: ComponentProps<"a">) {
  return <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>;
}
