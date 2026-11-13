import { Check } from "lucide-react";
import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Card, RadioGroup, RadioGroupItem } from "@botiverse/raft-ui";
import { useOptionalAppTheme } from "../../hooks/useAppTheme";
import { APP_APPEARANCE_MODES, isAppAppearanceMode } from "../../theme/appTheme";
import type { AppAppearanceMode, AppResolvedMode } from "../../theme/appTheme";

export interface AppearanceThemePickerProps {
  mode: AppAppearanceMode;
  onModeChange: (mode: AppAppearanceMode) => void;
  /** `large` is the onboarding picker, where the cards are the whole step. */
  size?: "default" | "large";
}

const MODE_LABEL_IDS = {
  light: "settings.appearance.modeLight",
  dark: "settings.appearance.modeDark",
  system: "settings.appearance.modeSystem",
} as const satisfies Record<AppAppearanceMode, string>;

/**
 * Light, Dark or follow the system. Each card previews the Raft Design System
 * in that mode, so the choice reads before it is made. Selecting applies
 * immediately; the app behind the picker restyles under the cursor.
 */
export function AppearanceThemePicker({ mode, onModeChange, size = "default" }: AppearanceThemePickerProps) {
  const { formatMessage } = useIntl();
  const handleValueChange = useCallback((value: string) => {
    if (isAppAppearanceMode(value)) onModeChange(value);
  }, [onModeChange]);

  // Columns follow the picker's own width (`@container`): the settings column
  // can be 360px on a wide window. One column when narrow, three side by side
  // from @sm, and from @3xl the theme tiles' size, columns of at least 14rem
  // (cindyz, #proj-raft-ui:#220).
  return (
    <div className="@container">
    <RadioGroup
      value={mode}
      onValueChange={handleValueChange}
      aria-label={formatMessage({ id: "settings.appearance.themeAria" })}
      className={size === "large" ? "grid grid-cols-1 gap-3 @sm:grid-cols-3" : "grid grid-cols-1 gap-3 @sm:grid-cols-3 @3xl:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]"}
      data-testid="appearance-theme-picker"
    >
      {APP_APPEARANCE_MODES.map((option) => (
        <ThemeModeCard
          key={option}
          mode={option}
          label={formatMessage({ id: MODE_LABEL_IDS[option] })}
          selected={mode === option}
          savedLabel={formatMessage({ id: "settings.appearance.savedOnDevice" })}
          size={size}
          onSelect={onModeChange}
        />
      ))}
    </RadioGroup>
    </div>
  );
}

function ThemeModeCard({
  mode,
  label,
  selected,
  savedLabel,
  size,
  onSelect,
}: {
  mode: AppAppearanceMode;
  label: string;
  selected: boolean;
  savedLabel: string;
  size: "default" | "large";
  onSelect: (mode: AppAppearanceMode) => void;
}) {
  const handleClick = useCallback(() => onSelect(mode), [mode, onSelect]);
  return (
    <div className="group min-w-0" data-testid={`appearance-theme-${mode}`}>
      <RadioGroupItem appearance="none" value={mode} aria-label={label} className="peer" />
      <Card
        onClick={handleClick}
        className={[
          "h-full gap-2 p-2",
          "hover:overlay-subtle active:overlay-medium",
          "peer-focus-visible:shadow-focus",
          "peer-data-checked:border-[1.5px] peer-data-checked:border-line-strong peer-data-checked:p-[7.5px]",
        ].join(" ")}
      >
        {mode === "system" ? (
          // Follow system: half light, half dark, split on the diagonal.
          <div className="relative" aria-hidden="true">
            <ThemePreviewSurface mode="light" size={size} />
            <div className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
              <ThemePreviewSurface mode="dark" size={size} />
            </div>
          </div>
        ) : (
          <ThemePreviewSurface mode={mode} size={size} />
        )}
        <div className="flex min-w-0 items-center gap-2 px-1">
          <span className="min-w-0 flex-1 truncate text-callout font-semibold text-foreground">{label}</span>
          {selected ? <Check size={16} className="shrink-0 text-foreground" aria-hidden="true" /> : null}
        </div>
        <span className="min-h-4 px-1 text-caption text-foreground-hint">{selected ? savedLabel : null}</span>
      </Card>
    </div>
  );
}

/**
 * A miniature of the app in one mode: yellow (or neutral) frame, cream
 * sidebar with the selected row as a yellow sticker, white paper with the
 * one pink button. Its mode class (`.light` / `.dark`) makes it render that
 * mode whatever the page is in.
 */
function ThemePreviewSurface({ mode, size }: { mode: AppResolvedMode; size: "default" | "large" }) {
  return (
    <div
      className={`${mode} flex overflow-hidden rounded-control border border-line-seam bg-layer-canvas ${size === "large" ? "h-28" : "h-20"}`}
      aria-hidden="true"
    >
      <div className="w-3 shrink-0 border-r border-line-seam bg-layer-frame" />
      <div className="flex w-1/3 shrink-0 flex-col gap-1 border-r border-line-seam bg-layer-sidebar p-1.5">
        <div className="h-1.5 w-3/4 rounded-[2px] bg-foreground/30" />
        <div className="h-3 rounded-[3px] border border-sticker-ink bg-brand" />
        <div className="h-1.5 w-2/3 rounded-[2px] bg-foreground/15" />
        <div className="h-1.5 w-1/2 rounded-[2px] bg-foreground/15" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
        <div className="h-1.5 w-1/2 rounded-[2px] bg-foreground/40" />
        <div className="flex items-center gap-1.5">
          <div className="size-3 shrink-0 rounded-[2px] border border-sticker-ink bg-palette-lavender" />
          <div className="h-1.5 flex-1 rounded-[2px] bg-foreground/15" />
        </div>
        <div className="mt-auto flex items-center gap-1.5 rounded-[4px] border border-line-strong bg-layer-card p-1">
          <div className="h-1.5 flex-1 rounded-[2px] bg-foreground/15" />
          <div className="h-3 w-6 shrink-0 rounded-[3px] border border-sticker-ink bg-attention" />
        </div>
      </div>
    </div>
  );
}

export default AppearanceThemePicker;

/** The picker bound to the app's theme: Settings › Theme, or Appearance where there is no Theme page. */
export function AppearanceThemeSettingsControl() {
  const theme = useOptionalAppTheme();
  if (!theme) return null;
  return <AppearanceThemePicker mode={theme.mode} onModeChange={theme.setMode} />;
}
