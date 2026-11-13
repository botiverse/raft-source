import { useCallback, useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Info, Shuffle, TriangleAlert } from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  Banner,
  BannerDescription,
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogCommit,
  DialogFooter,
  DialogHeader,
  DialogSheetContent,
  DialogTitle,
  RadioGroup,
  RadioGroupItem,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  Text,
} from "@botiverse/raft-ui";
import {
  DEFAULT_HUMAN_AVATAR_RECIPE,
  HUMAN_AVATAR_OPTIONS,
  humanAvatarOptionIds,
  isHumanAvatarOptionId,
  withHumanAvatarOption,
  randomHumanAvatarRecipe,
  readHumanAvatarRecipe,
  serializeHumanAvatarRecipe,
} from "@botiverse/raft-shared/src/humanAvatar";
import type { HumanAvatarField, HumanAvatarOptionId, HumanAvatarRecipe } from "@botiverse/raft-shared/src/humanAvatar";
import { saveHumanAvatarRecipe } from "./saveHumanAvatarRecipe";
import { isRaftUploadedHumanAvatarUrl } from "../../utils/humanAvatar";
import type { MessageId } from "../../i18n/messages/en";
import AvatarSlot from "../ui/AvatarSlot";
import { HumanPixelAvatar } from "./HumanPixelAvatar";
import { useHumanAvatarArt } from "./humanPixelAvatarArt";

// Build a pixel avatar from Oscar's layers (shared humanAvatar.ts): the 99px
// preview with Shuffle beside it, five tabs of options, Cancel and Save.
// Raft Design System: a dialog with a long list, a sheet on a phone (raft-ui
// DialogSheetContent: × is Cancel, Save moves to the head); one layout at every
// width, and only Cancel and Save in the footer. Every option is drawn as you
// wearing it, on the avatar component as it is (its own sticker edge, no
// second frame); the chosen one carries an ink ring. Nothing is stored until
// Save, which is off while the look is the stored one; a failed save keeps the
// dialog and every choice, with the old avatar still in place. Opens on the
// stored look, or (over a photo or no avatar) on the default with a note that
// saving replaces the photo.

type Tab = "background" | "skin" | "hair" | "expression" | "accessories";
const TABS: readonly Tab[] = ["background", "skin", "hair", "expression", "accessories"];

const TAB_LABEL: Record<Tab, MessageId> = {
  background: "avatar.builder.tab.background",
  skin: "avatar.builder.tab.skin",
  hair: "avatar.builder.tab.hair",
  expression: "avatar.builder.tab.expression",
  accessories: "avatar.builder.tab.accessories",
};

const BACKGROUND_LABEL: Record<HumanAvatarOptionId<"background">, MessageId> = {
  yellow: "avatar.builder.background.yellow",
  pink: "avatar.builder.background.pink",
  sky: "avatar.builder.background.sky",
  mint: "avatar.builder.background.mint",
  lilac: "avatar.builder.background.lilac",
  cream: "avatar.builder.background.cream",
};
const HAIR_LABEL: Record<HumanAvatarOptionId<"hair">, MessageId> = {
  short: "avatar.builder.hair.short",
  side: "avatar.builder.hair.side",
  long: "avatar.builder.hair.long",
  bun: "avatar.builder.hair.bun",
  curly: "avatar.builder.hair.curly",
  buzz: "avatar.builder.hair.buzz",
};
const HAIR_COLOR_LABEL: Record<HumanAvatarOptionId<"hairColor">, MessageId> = {
  ink: "avatar.builder.hairColor.ink",
  brown: "avatar.builder.hairColor.brown",
  blonde: "avatar.builder.hairColor.blonde",
  ginger: "avatar.builder.hairColor.ginger",
  grey: "avatar.builder.hairColor.grey",
};
const EXPRESSION_LABEL: Record<HumanAvatarOptionId<"expression">, MessageId> = {
  wink: "avatar.builder.expression.wink",
  grin: "avatar.builder.expression.grin",
  oh: "avatar.builder.expression.oh",
  smirk: "avatar.builder.expression.smirk",
  happy: "avatar.builder.expression.happy",
  calm: "avatar.builder.expression.calm",
  blush: "avatar.builder.expression.blush",
};
const HEAD_LABEL: Record<HumanAvatarOptionId<"head">, MessageId> = {
  none: "avatar.builder.none",
  cap: "avatar.builder.head.cap",
  beanie: "avatar.builder.head.beanie",
  headphones: "avatar.builder.head.headphones",
};
const FACE_LABEL: Record<HumanAvatarOptionId<"face">, MessageId> = {
  none: "avatar.builder.none",
  glasses: "avatar.builder.face.glasses",
};

// Options are fixed 72px columns packed from the start of the row, 8px apart
// (12px between rows), as in the agent avatar picker: never stretched across
// the width. A tile is the avatar at `lg` (51px, the DS scale) with its caption
// 4px under it. A chosen option is a value, so its mark is ink (DS states:
// selection of a value is ink, yellow is where you are): a 2px ink ring round
// the avatar's own sticker and a bold caption. Hover and press add the medium
// overlay to an unchosen tile; keyboard focus rings the whole tile.
const OPTION_GRID_CLASS = "grid grid-cols-[repeat(auto-fill,4.5rem)] justify-start gap-x-2 gap-y-3";
const TILE_CLASS = "group/tile flex w-18 cursor-pointer flex-col items-center gap-1 rounded-control py-1.5 outline-none transition-colors has-[:focus-visible]:shadow-focus has-disabled:cursor-not-allowed not-has-[[data-checked]]:hover:bg-fill-medium not-has-[[data-checked]]:active:bg-fill-medium";
const TILE_AVATAR_CLASS = "flex rounded-sticker outline-2 outline-offset-2 outline-transparent transition-[outline-color] duration-100 group-has-[[data-checked]]/tile:outline-foreground";
const TILE_LABEL_CLASS = "line-clamp-2 max-w-full text-center text-caption text-foreground-muted group-has-[[data-checked]]/tile:font-bold group-has-[[data-checked]]/tile:text-foreground";
// A swatch's tile is the 44px touch target, the 32px dot centred in it.
const SWATCH_TILE_CLASS = "group/tile flex size-11 cursor-pointer items-center justify-center rounded-full outline-none transition-colors has-[:focus-visible]:shadow-focus has-disabled:cursor-not-allowed not-has-[[data-checked]]:hover:bg-fill-medium not-has-[[data-checked]]:active:bg-fill-medium";
const SWATCH_CLASS = "block size-8 rounded-full border-[1.5px] border-sticker-ink outline-2 outline-offset-2 outline-transparent transition-[outline-color] duration-100 group-has-[[data-checked]]/tile:outline-foreground";

/** Choose `value` for `field`; a value that isn't one of its ids changes nothing. */
type PickOption = (field: HumanAvatarField, value: unknown) => void;

function applyOption(recipe: HumanAvatarRecipe, field: HumanAvatarField, value: unknown): HumanAvatarRecipe {
  return isHumanAvatarOptionId(field, value) ? withHumanAvatarOption(recipe, field, value) : recipe;
}

/** The name of each option, for its radio (and its caption when shown). */
const OPTION_LABEL: { [F in HumanAvatarField]?: Record<string, MessageId> } = {
  background: BACKGROUND_LABEL,
  hair: HAIR_LABEL,
  hairColor: HAIR_COLOR_LABEL,
  expression: EXPRESSION_LABEL,
  head: HEAD_LABEL,
  face: FACE_LABEL,
};

function useOptionLabel(field: HumanAvatarField): (id: string) => string {
  const { formatMessage } = useIntl();
  return useCallback((id: string) => {
    const labelId = OPTION_LABEL[field]?.[id];
    return labelId ? formatMessage({ id: labelId }) : formatMessage({ id: "avatar.builder.skinTone" }, { n: id });
  }, [field, formatMessage]);
}

/** Each option of one field, drawn as the current look wearing it. */
function OptionTiles({
  field,
  recipe,
  onPick,
  label,
  showLabels,
  withoutHead = false,
  disabled,
}: {
  field: HumanAvatarField;
  recipe: HumanAvatarRecipe;
  onPick: PickOption;
  label: string;
  showLabels: boolean;
  /** Draw the tiles bare-headed (hair styles: a hat would hide them). */
  withoutHead?: boolean;
  disabled: boolean;
}) {
  const optionLabel = useOptionLabel(field);
  const handleChange = useCallback((value: unknown) => onPick(field, value), [field, onPick]);
  return (
    <RadioGroup
      value={recipe[field]}
      onValueChange={handleChange}
      aria-label={label}
      disabled={disabled}
      className={OPTION_GRID_CLASS}
      data-avatar-builder-options={field}
    >
      {humanAvatarOptionIds(field).map((id) => {
        const look = withHumanAvatarOption(withoutHead ? withHumanAvatarOption(recipe, "head", "none") : recipe, field, id);
        return (
          <label key={id} className={TILE_CLASS} data-avatar-builder-option={`${field}:${id}`}>
            <RadioGroupItem appearance="none" value={id} aria-label={optionLabel(id)} />
            <span className={TILE_AVATAR_CLASS}>
              <AvatarSlot context="profile-tile" type="human" humanAvatarUrl={serializeHumanAvatarRecipe(look)} />
            </span>
            {showLabels ? <span className={TILE_LABEL_CLASS} aria-hidden="true">{optionLabel(id)}</span> : null}
          </label>
        );
      })}
    </RadioGroup>
  );
}

function Swatch({ color }: { color: string | undefined }) {
  const style = useMemo<CSSProperties>(() => ({ backgroundColor: color }), [color]);
  return <span aria-hidden="true" className={SWATCH_CLASS} style={style} />;
}

/** The hair colours as round swatches of the art's own palette. */
function HairColorSwatches({ recipe, onPick, label, disabled }: { recipe: HumanAvatarRecipe; onPick: PickOption; label: string; disabled: boolean }) {
  const { art } = useHumanAvatarArt();
  const optionLabel = useOptionLabel("hairColor");
  const handleChange = useCallback((value: unknown) => onPick("hairColor", value), [onPick]);
  return (
    <RadioGroup
      value={recipe.hairColor}
      onValueChange={handleChange}
      aria-label={label}
      disabled={disabled}
      className="flex flex-wrap gap-1"
      data-avatar-builder-options="hairColor"
    >
      {humanAvatarOptionIds("hairColor").map((id) => (
        <label key={id} className={SWATCH_TILE_CLASS} title={optionLabel(id)} data-avatar-builder-option={`hairColor:${id}`}>
          <RadioGroupItem appearance="none" value={id} aria-label={optionLabel(id)} />
          <Swatch color={art?.palettes.hair[HUMAN_AVATAR_OPTIONS.hairColor[id]]} />
        </label>
      ))}
    </RadioGroup>
  );
}

function Group({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="grid gap-1.5" aria-labelledby={id}>
      <Text.Sans size="group" id={id} render={<h3>{title}</h3>} />
      {children}
    </section>
  );
}

export interface HumanAvatarBuilderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The avatar now: the builder opens on it when it is a built one. */
  avatarUrl: string | null | undefined;
  /** After a save the server confirmed. */
  onSaved?: () => void;
}

export function HumanAvatarBuilderDialog({ open, onOpenChange, avatarUrl, onSaved }: HumanAvatarBuilderDialogProps) {
  // A fresh builder per opening: the stored look, the first tab, no error.
  return open ? <BuilderDialog onOpenChange={onOpenChange} avatarUrl={avatarUrl} onSaved={onSaved} /> : null;
}

function BuilderDialog({ onOpenChange, avatarUrl, onSaved }: Omit<HumanAvatarBuilderDialogProps, "open">) {
  const { formatMessage } = useIntl();
  // Where it starts: the stored look, else the default.
  const [recipe, setRecipe] = useState<HumanAvatarRecipe>(() => readHumanAvatarRecipe(avatarUrl) ?? { ...DEFAULT_HUMAN_AVATAR_RECIPE });
  const [tab, setTab] = useState<Tab>("background");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const replacesPhoto = isRaftUploadedHumanAvatarUrl(avatarUrl);
  const t = (id: MessageId) => formatMessage({ id });
  const look = serializeHumanAvatarRecipe(recipe);
  const stored = readHumanAvatarRecipe(avatarUrl);
  const changed = !stored || serializeHumanAvatarRecipe(stored) !== look;

  const pick = useCallback<PickOption>((field, value) => {
    // A new choice clears a failed save's banner: its "save again" would be
    // wrong once Save is off (back to the stored look).
    setFailed(false);
    setRecipe((current) => applyOption(current, field, value));
  }, []);
  const shuffle = useCallback(() => {
    setFailed(false);
    setRecipe(randomHumanAvatarRecipe());
  }, []);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  // Esc, × and the scrim close it, except while a save is in flight.
  const handleOpenChange = useCallback((next: boolean) => {
    if (!saving) onOpenChange(next);
  }, [saving, onOpenChange]);

  const save = useCallback(async () => {
    setSaving(true);
    setFailed(false);
    try {
      await saveHumanAvatarRecipe(recipe);
      onOpenChange(false);
      onSaved?.();
    } catch {
      // The dialog stays with every choice; the old avatar is untouched.
      setFailed(true);
    } finally {
      setSaving(false);
    }
  }, [recipe, onOpenChange, onSaved]);
  const handleSave = useCallback(() => { if (!saving && changed) void save(); }, [saving, changed, save]);

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <DialogSheetContent size="lg" data-avatar-builder="">
        <DialogHeader>
          <DialogTitle>{t("avatar.builder.title")}</DialogTitle>
          <DialogClose aria-label={t("common.close")} disabled={saving} />
        </DialogHeader>
        {/* One layout at every width: the preview with Shuffle beside it, then
            the tabs at the body's full width, then the options. */}
        <DialogBody className="grid grid-cols-[minmax(0,1fr)] content-start gap-4">
          <div className="flex items-center gap-4">
            {/* The avatar component as it is, at `xl` (99px): its own sticker
                edge and shadow, no frame around it. */}
            <Avatar size="xl" type="human" role="img" aria-label={t("avatar.builder.preview")} data-avatar-builder-preview={look}>
              <AvatarFallback className="relative overflow-hidden">
                <HumanPixelAvatar avatarUrl={look} />
              </AvatarFallback>
            </Avatar>
            <Button type="button" variant="default" size="md" onClick={shuffle} disabled={saving} data-avatar-builder-shuffle="">
              <Shuffle aria-hidden="true" />
              {t("avatar.builder.shuffle")}
            </Button>
          </div>
          {replacesPhoto ? (
            <Banner status="info" size="sm" data-avatar-builder-replaces-photo="">
              <Info aria-hidden="true" />
              <BannerDescription>{t("avatar.builder.replacesPhoto")}</BannerDescription>
            </Banner>
          ) : null}
          {failed ? (
            // Something went wrong in a dialog: an orange banner in it. Save,
            // still there, is the way out; the sentence says so.
            <Banner status="warning" size="sm" role="alert" data-avatar-builder-error="">
              <TriangleAlert aria-hidden="true" />
              <BannerDescription>{t("avatar.builder.saveFailed")}</BannerDescription>
            </Banner>
          ) : null}
          <Tabs value={tab} onValueChange={setTab}>
            {/* raft-ui's row scrolls sideways (overflow-x auto, so y is hidden
                too) and is exactly a tab tall: the chosen tab's 1.5px outer ring
                was cut at the top, bottom and the row's ends. 2px of padding
                inside the scroller holds the whole ring; raft-ui's
                scroll-into-view already counts the row's padding. */}
            <TabsList aria-label={t("avatar.builder.parts")} className="p-0.5">
              {TABS.map((value) => (
                <TabsTab key={value} value={value} data-avatar-builder-tab={value}>{t(TAB_LABEL[value])}</TabsTab>
              ))}
            </TabsList>
            <TabsPanel value="background" className="pt-3">
              <OptionTiles field="background" recipe={recipe} onPick={pick} disabled={saving} showLabels={false} label={t("avatar.builder.tab.background")} />
            </TabsPanel>
            <TabsPanel value="skin" className="pt-3">
              <OptionTiles field="skin" recipe={recipe} onPick={pick} disabled={saving} showLabels={false} label={t("avatar.builder.tab.skin")} />
            </TabsPanel>
            <TabsPanel value="hair" className="grid gap-3 pt-3">
              <Group id="avatar-builder-hair-style" title={t("avatar.builder.hairStyle")}>
                <OptionTiles field="hair" recipe={recipe} onPick={pick} disabled={saving} showLabels withoutHead label={t("avatar.builder.hairStyle")} />
              </Group>
              <Group id="avatar-builder-hair-color" title={t("avatar.builder.hairColor")}>
                <HairColorSwatches recipe={recipe} onPick={pick} disabled={saving} label={t("avatar.builder.hairColor")} />
              </Group>
            </TabsPanel>
            <TabsPanel value="expression" className="pt-3">
              <OptionTiles field="expression" recipe={recipe} onPick={pick} disabled={saving} showLabels label={t("avatar.builder.tab.expression")} />
            </TabsPanel>
            <TabsPanel value="accessories" className="grid gap-3 pt-3">
              <Group id="avatar-builder-head" title={t("avatar.builder.head")}>
                <OptionTiles field="head" recipe={recipe} onPick={pick} disabled={saving} showLabels label={t("avatar.builder.head")} />
              </Group>
              <Group id="avatar-builder-face" title={t("avatar.builder.face")}>
                <OptionTiles field="face" recipe={recipe} onPick={pick} disabled={saving} showLabels label={t("avatar.builder.face")} />
              </Group>
            </TabsPanel>
          </Tabs>
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" size="lg" onClick={close} disabled={saving}>
            {t("common.confirm.cancel")}
          </Button>
          <DialogCommit
            type="button"
            variant="primary"
            size="lg"
            loading={saving}
            loadingLabel={t("avatar.builder.saving")}
            // Nothing to save while it is the stored look; over a photo or no
            // avatar, Save always does something.
            disabled={!changed}
            onClick={handleSave}
            data-avatar-builder-save=""
          >
            {t("avatar.builder.save")}
          </DialogCommit>
        </DialogFooter>
      </DialogSheetContent>
    </Dialog>
  );
}
