import type { ButtonHTMLAttributes } from "react";

/**
 * The inline text-link used for secondary actions across auth and onboarding.
 *
 * Every one of these — Sign In / Create One, Forgot Password, Log out, and the
 * setup gate's Later — is the same control in one of two emphasis variants.
 * Each surface used to hand-roll the className, which is how "Later" ended up
 * as a dashed-underline mono one-off while "Log out" was a plain grey link.
 * Reuse this instead of re-writing the classes.
 *
 * - `primary`: the alternate primary action (Create One / Sign In) — pink, bold.
 * - `muted`: a low-key secondary escape hatch (Forgot Password / Log out / Later) — grey.
 */
export type TextLinkVariant = "primary" | "muted";

const VARIANT_CLASS: Record<TextLinkVariant, string> = {
  primary: "font-bold text-brutal-pink underline",
  muted: "text-black/50 underline hover:text-black",
};

export default function TextLink({
  variant = "muted",
  type = "button",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: TextLinkVariant }) {
  return (
    <button
      type={type}
      className={`${VARIANT_CLASS[variant]} disabled:opacity-50 ${className}`.trim()}
      {...props}
    />
  );
}
