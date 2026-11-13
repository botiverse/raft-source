// A setting that applies the moment it is chosen (Raft DS › Forms, "Settings
// that apply at once"): a switch, a select or a segmented control saves itself,
// with no Save button. Nothing is said once it is stored: the control showing
// its new value is the confirmation (cindyz, 2026-11-10,
// #proj-raft-ui:4ae1a74e). When the request fails the caller puts the control
// back and the failure is said under it, so a control never shows a value that
// isn't true.
//
// The failure line is raft-ui's SaveStatus: empty, it is hidden and takes no
// room; with the failure in it, it sits 4px under the control (or under the
// row's description, or its title when it has none) and the setting grows by
// that line until the next change.

import { useCallback, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";
import { ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, Switch } from "@botiverse/raft-ui";
import { SaveStatus, SaveStatusError } from "@botiverse/raft-ui/wip";

/**
 * How long a Save button of settings saved together says "Saved"
 * (AppNotificationsControls). A setting that applies at once says nothing.
 */
export const SETTING_SAVED_MS = 2000;

export type ImmediateSaveFeedback =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "failed"; message: string };

const IDLE: ImmediateSaveFeedback = { status: "idle" };

/**
 * Runs one save for one setting and tracks its result. Only the latest save
 * reports: a slower earlier request can't overwrite what the latest one said.
 * Resolves to whether the save went through, so the caller can put the control
 * back when it didn't.
 */
export function useImmediateSave() {
  const [feedback, setFeedback] = useState<ImmediateSaveFeedback>(IDLE);
  const sequence = useRef(0);

  const run = useCallback(async (
    apply: () => Promise<unknown>,
    failureMessage: (error: unknown) => string,
  ): Promise<boolean> => {
    const id = ++sequence.current;
    setFeedback({ status: "saving" });
    try {
      await apply();
      if (id === sequence.current) setFeedback(IDLE);
      return true;
    } catch (error: unknown) {
      if (id === sequence.current) setFeedback({ status: "failed", message: failureMessage(error) });
      return false;
    }
  }, []);

  const reset = useCallback(() => {
    sequence.current += 1;
    setFeedback(IDLE);
  }, []);

  return { feedback, saving: feedback.status === "saving", run, reset };
}

/** The server's own refusal when it sent one, else the setting's message. */
export function apiErrorText(error: unknown, fallback: string): string {
  const message = (error as { response?: { data?: { error?: unknown } } } | null)?.response?.data?.error;
  return typeof message === "string" && message ? message : fallback;
}

/**
 * The failure line of a setting that applies at once: raft-ui's SaveStatus.
 * Render it in every state, right after the control (in a settings row, after
 * the description, or after the title when the row has none). It holds an
 * alert saying what failed, and nothing otherwise: empty, it takes no room.
 */
export function ImmediateSaveStatus({
  feedback,
  testId,
  id,
}: {
  feedback: ImmediateSaveFeedback;
  testId?: string;
  /** Lets the control name its result line in `aria-describedby`. */
  id?: string;
}) {
  return (
    <SaveStatus id={id} data-testid={testId} data-status={feedback.status}>
      {feedback.status === "failed" ? <SaveStatusError>{feedback.message}</SaveStatusError> : null}
    </SaveStatus>
  );
}

/**
 * The Switch at the end of a settings row whose body ends with the failure
 * line. raft-ui's plain ListRow centres it on the whole row (0.84): the empty
 * line takes no room, and while a failure shows, the row grows by it and the
 * switch stays centred on the row, failure included.
 */
export function ImmediateRowSwitch(props: ComponentProps<typeof Switch>) {
  return <Switch {...props} />;
}

/**
 * A settings card with one switch that applies at once (DS ListRow › a setting
 * row: a `plain` display-only row, the Switch is the target). Only a failure
 * shows, under the description; the row (raft-ui) centres the Switch on
 * itself. `footer` takes what belongs to the setting but may come and go,
 * such as a warning about its current value: it goes under the group, not in
 * the row, so the row keeps its height and the Switch doesn't move when it
 * appears.
 */
export function ImmediateSwitchRow({
  idPrefix,
  title,
  description,
  checked,
  disabled,
  onCheckedChange,
  feedback,
  footer,
  testId,
}: {
  idPrefix: string;
  title: ReactNode;
  description: ReactNode;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
  feedback: ImmediateSaveFeedback;
  footer?: ReactNode;
  testId?: string;
}) {
  return (
    <>
      <ListRowGroup data-testid={testId}>
        <ListRow variant="plain" interactive={false}>
          <ListRowBody>
            <ListRowTitle id={`${idPrefix}-label`}>{title}</ListRowTitle>
            <ListRowDescription id={`${idPrefix}-description`} wrap>
              {description}
            </ListRowDescription>
            <ImmediateSaveStatus id={`${idPrefix}-status`} feedback={feedback} testId={testId ? `${testId}-status` : undefined} />
          </ListRowBody>
          <ImmediateRowSwitch
            checked={checked}
            disabled={disabled}
            onCheckedChange={onCheckedChange}
            aria-labelledby={`${idPrefix}-label`}
            aria-describedby={`${idPrefix}-description ${idPrefix}-status`}
            data-testid={testId ? `${testId}-switch` : undefined}
          />
        </ListRow>
      </ListRowGroup>
      {footer ? <div className="mt-3" data-testid={testId ? `${testId}-footer` : undefined}>{footer}</div> : null}
    </>
  );
}
