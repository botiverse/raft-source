/**
 * The task conversation bar's name, shared by the loaded bar and its loading
 * placeholder so the placeholder is the loaded bar's size and follows it: on a
 * desktop one line (a 44px head), the label then the ref after it; on a phone
 * the ref over the label.
 */
export const BAR_NAME_CLASS = "@container min-w-0 flex-1 md:pointer-fine:flex md:pointer-fine:flex-row-reverse md:pointer-fine:items-baseline md:pointer-fine:justify-end md:pointer-fine:gap-2";
export const BAR_REF_CLASS = "truncate font-mono text-mono-meta text-foreground-muted md:pointer-fine:shrink-[1000]";
export const BAR_LABEL_CLASS = "truncate text-subhead font-bold";
