// Small shared parts of the This device panel (ThisDeviceSections.tsx): the
// collapsible section title, the Technical details disclosure, and the
// confirmation dialogs. raft-ui throughout; the collapsible title is the DS
// `button.rf-section__title` (SectionEyebrow as="button"), as the runtime
// "More" disclosure draws it, because raft-ui has no Collapsible.
import { useCallback, useId, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  CopyableCode,
  CopyableCodeAction,
  CopyableCodeRoot,
} from "@botiverse/raft-ui";
import type { ButtonProps } from "@botiverse/raft-ui";
import SectionEyebrow from "../../ui/SectionEyebrow";

/** A section title that opens and closes the content below it. */
export function DisclosureTitle({ open, onOpenChange, controls, children, testId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  controls: string;
  children: ReactNode;
  testId?: string;
}) {
  const toggle = useCallback(() => onOpenChange(!open), [onOpenChange, open]);
  return (
    <SectionEyebrow
      as="button"
      onClick={toggle}
      aria-expanded={open}
      aria-controls={controls}
      data-testid={testId}
      className="flex items-center gap-2 rounded-control outline-none hover:text-foreground focus-visible:shadow-focus"
    >
      {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
      {children}
    </SectionEyebrow>
  );
}

/**
 * The raw error, collapsed, for support to read (design decision 6): never
 * an instruction, so it is closed by default and set as code to copy.
 */
export function TechnicalDetails({ text }: { text: string }) {
  const { formatMessage } = useIntl();
  const [open, setOpen] = useState(false);
  const id = `this-device-technical-details-${useId()}`;
  return (
    <div className="mt-2" data-testid="this-device-technical-details">
      <DisclosureTitle open={open} onOpenChange={setOpen} controls={id}>
        {formatMessage({ id: "computerHost.thisDevice.technicalDetails" })}
      </DisclosureTitle>
      {open ? (
        <div id={id} className="mt-2">
          <CopyableCodeRoot>
            <CopyableCode className="whitespace-pre-wrap break-all">{text}</CopyableCode>
            <CopyableCodeAction aria-label={formatMessage({ id: "computerHost.thisDevice.copyDetails" })} className="shrink-0" />
          </CopyableCodeRoot>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A confirmation (raft-ui AlertDialog): the commit button's colour says the
 * consequence (warning: interrupts but can be recovered). `secondary` is a
 * second way to go on (Stop now beside Stop when finished).
 */
export function ThisDeviceConfirm({ title, body, confirmLabel, confirmVariant = "warning", onConfirm, secondary, onClose, testId }: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  confirmVariant?: ButtonProps["variant"];
  onConfirm: () => void;
  secondary?: { label: string; onClick: () => void; variant?: ButtonProps["variant"] };
  onClose: () => void;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const onOpenChange = useCallback((open: boolean) => { if (!open) onClose(); }, [onClose]);
  return (
    <AlertDialog open onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid={testId}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
        </AlertDialogHeader>
        <AlertDialogBody>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel size="md">{formatMessage({ id: "common.confirm.cancel" })}</AlertDialogCancel>
          {secondary ? (
            <AlertDialogAction size="md" variant={secondary.variant ?? "outline"} onClick={secondary.onClick} data-testid={testId ? `${testId}-secondary` : undefined}>
              {secondary.label}
            </AlertDialogAction>
          ) : null}
          <AlertDialogAction size="md" variant={confirmVariant} onClick={onConfirm} data-testid={testId ? `${testId}-confirm` : undefined}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
