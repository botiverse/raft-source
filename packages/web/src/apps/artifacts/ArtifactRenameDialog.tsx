import { useCallback, useRef, useState } from "react";
import type { ChangeEvent, FocusEvent, FormEvent, KeyboardEvent, RefObject } from "react";
import { useIntl } from "react-intl";
import { TriangleAlert } from "lucide-react";
import {
  Banner,
  BannerDescription,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from "@botiverse/raft-ui";
import { AGENT_API_ARTIFACT_MAX_TITLE_CHARS } from "@botiverse/raft-shared";

import { NarrowDialogContent } from "../../components/ui/NarrowDialog";

import { isInputMethodKey } from "./artifactInputMethodKey";
import type { ArtifactRename } from "./ArtifactViewerMenu";

/**
 * Rename Artifact (#proj-workspace:#169, xxchan's mockup: it replaced editing
 * the header's title in place), opened by ⋯'s Rename: a Raft DS Dialog with
 * one field, the title shown when it opened, focused and selected, and a line
 * under it on who sees the new name. Cancel and Save in its footer; Enter (not
 * while an input method composes) saves, Esc cancels without closing the
 * viewer under it (the surface's Esc, useArtifactSurfaceKeyDown, leaves an Esc
 * already handled). Save waits for the server: off while the title is blank,
 * unchanged or being saved; a refusal says why in an orange banner inside the
 * dialog (Raft DS Forms: a failed request), and the dialog stays with what was
 * typed. On a phone it is a one-field dialog (docs/frontend/narrow-dialogs.md,
 * `top`): while the keyboard is up the card sits in the upper part of the
 * screen, so the keyboard covers neither Save nor the banner; the desktop card
 * is unchanged. Mounted per opening (ArtifactViewerDialogs), so it starts from
 * the title shown then.
 */
export function ArtifactRenameDialog({ title, rename, finalFocus }: {
  title: string;
  rename: ArtifactRename;
  /** Where focus goes back as it closes: ⋯, which opened it. */
  finalFocus: RefObject<HTMLElement | null>;
}) {
  const { formatMessage } = useIntl();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selected = useRef(false);
  // oxlint-disable-next-line react-doctor/no-derived-useState -- mounted per opening: the field starts from the title shown then, and what is typed must not follow later changes.
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const { save, cancel } = rename;
  const next = value.trim();
  const canSave = !saving && next !== "" && next !== title.trim();
  const submit = useCallback(() => {
    if (!canSave) return;
    setSaving(true);
    setRefusal(null);
    void save(next).then((why) => {
      // Saved: the actions close it. Refused: why, here, with what was typed.
      if (why === null) return;
      setRefusal(why);
      setSaving(false);
    });
  }, [canSave, save, next]);
  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit();
  }, [submit]);
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setValue(event.target.value);
    setRefusal(null);
  }, []);
  const handleInputKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || isInputMethodKey(event)) return;
    event.preventDefault();
    submit();
  }, [submit]);
  // The whole title selected as it opens, so typing replaces it; a later focus keeps where the caret was.
  const handleFocus = useCallback((event: FocusEvent<HTMLInputElement>) => {
    if (selected.current) return;
    selected.current = true;
    event.currentTarget.select();
  }, []);
  // Esc is the dialog's (Base UI closes it): marked handled, so the viewer under it stays open.
  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") event.preventDefault();
  }, []);
  // Not while saving: the answer decides (closed when saved, the refusal here).
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && !saving) cancel();
  }, [saving, cancel]);
  const dialogTitle = formatMessage({ id: "artifacts.rename.title" });
  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <NarrowDialogContent
        narrow="centered"
        initialFocus={inputRef}
        finalFocus={finalFocus}
        onKeyDown={handleKeyDown}
        data-testid="artifact-rename-dialog"
        render={<form onSubmit={handleSubmit} noValidate />}
        title={dialogTitle}
        closeLabel={formatMessage({ id: "common.close" })}
        closeDisabled={saving}
        header={(
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
          </DialogHeader>
        )}
      >
        <DialogBody className="grid gap-4">
          <Field>
            {/* One field under a title that says what it is for (the mockup has no label above it): named by aria-label. */}
            <Input
              ref={inputRef}
              value={value}
              onChange={handleChange}
              onKeyDown={handleInputKeyDown}
              onFocus={handleFocus}
              readOnly={saving}
              maxLength={AGENT_API_ARTIFACT_MAX_TITLE_CHARS}
              aria-label={formatMessage({ id: "artifacts.rename.label" })}
              suppressPasswordManager
              data-testid="artifact-rename-input"
            />
          </Field>
          {refusal ? (
            <Banner status="warning" data-testid="artifact-rename-refusal">
              <TriangleAlert />
              <BannerDescription>{refusal}</BannerDescription>
            </Banner>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" size="lg" disabled={saving} onClick={cancel} data-testid="artifact-rename-cancel">
            {formatMessage({ id: "artifacts.rename.cancel" })}
          </Button>
          <Button type="submit" variant="primary" size="lg" loading={saving} disabled={!canSave} data-testid="artifact-rename-save">
            {formatMessage({ id: "artifacts.rename.save" })}
          </Button>
        </DialogFooter>
      </NarrowDialogContent>
    </Dialog>
  );
}
