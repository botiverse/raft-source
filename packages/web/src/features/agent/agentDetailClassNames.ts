// The profile hero avatar is the trigger itself: no control frame around the
// sticker (it carries its own ink edge), a focus ring on keyboard focus.
export const PROFILE_AVATAR_BUTTON_CLASS = "group/avatar-edit relative shrink-0 rounded-sticker outline-none focus-visible:shadow-focus";
// DS runtime chip (`.rf-runtime`): the cyan-soft Badge in machine type, with a cpu icon.
export const RUNTIME_CHIP_CLASS = "font-mono text-mono-meta font-normal";
// The 14px info icon answers a bigger target than it draws: a transparent
// ::after reaching 44px on touch and the 28px bar button with a mouse (stdrc,
// 2026-11-05); the drawing is unchanged.
export const INFO_ICON_BUTTON_CLASS = "relative shrink-0 rounded-sticker text-foreground-muted transition-colors hover:bg-fill-medium hover:text-foreground after:absolute after:-inset-[15px] md:pointer-fine:after:-inset-[7px]";
