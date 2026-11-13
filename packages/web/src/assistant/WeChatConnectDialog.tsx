import { useCallback, useId, useState } from "react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Info, TriangleAlert } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Banner,
  BannerDescription,
  BannerTitle,
  Button,
  CopyableCode,
  CopyableCodeAction,
  CopyableCodeRoot,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
} from "@botiverse/raft-ui";
import FormField from "../components/ui/FormField";
import { DialogActions, DialogCommit, NarrowDialogContent } from "../components/ui/NarrowDialog";
import { useTimeFormatter } from "../hooks/useTimeFormatter";
import { useWeChatConnect } from "./useWeChatConnect";
import type { WeChatConnectFailure, WeChatConnectStep } from "./useWeChatConnect";
import type { WeChatStatus } from "./wechatClient";
import { useWeChatConnectBlock, useWeChatConnectWebUrl } from "./wechatConnectHere";
import type { WeChatConnectBlock } from "./wechatConnectHere";
import { WeChatConnectionView } from "./WeChatConnectionView";
import { WeChatQrCode } from "./WeChatQrCode";

const FAILURE_IDS = {
  expired: "assistant.wechat.failed.expired",
  used: "assistant.wechat.failed.used",
  blocked: "assistant.wechat.failed.blocked",
  already_bound: "assistant.wechat.failed.alreadyBound",
  in_use: "assistant.wechat.failed.inUse",
  unbound: "assistant.wechat.failed.unbound",
  rate_limited: "assistant.wechat.failed.rateLimited",
  upstream: "assistant.wechat.failed.upstream",
  unavailable: "assistant.wechat.failed.unavailable",
  other: "assistant.wechat.failed.other",
} as const satisfies Record<WeChatConnectFailure, string>;

/**
 * Assistant Settings › Connect WeChat / WeChat (design "微信接入 Ottie", PR 3).
 *
 * Not connected: what connecting means first (messages go through Tencent's
 * servers; it replaces a WeChat bot connection the person made themselves,
 * such as their own OpenClaw; the assistant replies in WeChat only within 24
 * hours of their last WeChat message; and the QR code is private), then the
 * QR code with its live state until WeChat answers for good, WeChat's
 * verification code when it asks for one, and Get New QR Code when the code
 * expired or failed. Connected (or right after): WeChatConnectionView.
 *
 * Where connecting can't finish (the desktop app, a phone-width screen:
 * wechatConnectHere) no QR code is shown: the dialog says where to connect,
 * and its one pink button is Open in Browser in the desktop app, Close on a
 * phone (DS Dialog › The footer: a dialog that is only read has one pink
 * button).
 *
 * The steps are a sheet on a phone (DS Dialog › On a phone); what is only
 * read stays centered. A click on the scrim closes it like any small dialog;
 * with a verification code typed, closing asks first (DS Dialog › Asking
 * before closing). Closing stops polling; the code the server made expires.
 */
export function WeChatConnectDialog({ name, status, onClose }: {
  /** The assistant's name (Ottie). */
  name: string;
  status: WeChatStatus;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const { step, start, submitCode, stop } = useWeChatConnect();
  const block = useWeChatConnectBlock();
  const [code, setCode] = useState("");
  // Reconnect from the connection view goes back into the flow.
  const [reconnecting, setReconnecting] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const showConnection = step.kind === "connected" || (status.binding !== null && !reconnecting);
  const blocked = showConnection ? null : block;
  const dirty = !showConnection && step.kind === "verify" && code.trim() !== "";

  const close = useCallback(() => {
    stop();
    onClose();
  }, [onClose, stop]);
  const requestClose = useCallback(() => {
    if (dirty) setConfirmDiscard(true);
    else close();
  }, [close, dirty]);
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) requestClose();
  }, [requestClose]);
  const handleDiscardOpenChange = useCallback((next: boolean) => {
    if (!next) setConfirmDiscard(false);
  }, []);
  const reconnect = useCallback(() => {
    setReconnecting(true);
    setCode("");
    start();
  }, [start]);
  const newCode = useCallback(() => {
    setCode("");
    start();
  }, [start]);
  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (showConnection || blocked) return;
    if (step.kind === "disclosure") start();
    else if (step.kind === "verify" && !step.checking) submitCode(code);
    else if (step.kind === "failed" && step.reason !== "unavailable") newCode();
  }, [blocked, code, newCode, showConnection, start, step, submitCode]);

  const title = formatMessage({ id: showConnection ? "assistant.wechat.connectionTitle" : "assistant.wechat.connectTitle" });
  const closeLabel = formatMessage({ id: "common.close" });
  // Read, not filled in: the centered card on a phone too (DS Dialog › On a phone).
  const narrow = showConnection || blocked ? "centered" : "sheet";
  const onlyClose = blocked === "phone" || (step.kind === "failed" && step.reason === "unavailable");

  return (
    <Dialog open onOpenChange={handleOpenChange}>
      <NarrowDialogContent
        narrow={narrow}
        size="md"
        data-testid="wechat-dialog"
        data-step={showConnection ? "connection" : blocked ? `blocked-${blocked}` : step.kind}
        title={title}
        closeLabel={closeLabel}
        render={<form onSubmit={handleSubmit} noValidate />}
        header={(
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogClose aria-label={closeLabel} />
          </DialogHeader>
        )}
      >
        {showConnection ? (
          <WeChatConnectionView
            name={name}
            binding={status.binding}
            justConnected={step.kind === "connected"}
            available={status.available}
            block={block}
            onReconnect={reconnect}
            onClose={close}
          />
        ) : (
          <>
            <DialogBody className="grid gap-4">
              {blocked
                ? <Blocked name={name} block={blocked} />
                : <ConnectStepBody name={name} step={step} code={code} onCodeChange={setCode} />}
            </DialogBody>
            <DialogActions as={DialogFooter}>
              {blocked === "desktop" ? <OpenInBrowserCommit /> : onlyClose ? <CloseCommit onClose={close} /> : (
                <>
                  <Button type="button" variant="ghost" size="lg" onClick={requestClose}>
                    {formatMessage({ id: "assistant.wechat.cancel" })}
                  </Button>
                  <ConnectCommit step={step} code={code} />
                </>
              )}
            </DialogActions>
          </>
        )}

        <AlertDialog open={confirmDiscard} onOpenChange={handleDiscardOpenChange}>
          <AlertDialogContent data-testid="wechat-discard-confirm">
            <AlertDialogHeader>
              <AlertDialogTitle>{formatMessage({ id: "message.chatPanel.overflow.unsavedTitle" })}</AlertDialogTitle>
            </AlertDialogHeader>
            <AlertDialogBody>{formatMessage({ id: "agent.detail.editProfile.discardBody" })}</AlertDialogBody>
            <AlertDialogFooter>
              <AlertDialogCancel size="lg">
                {formatMessage({ id: "message.chatPanel.overflow.keepEditing" })}
              </AlertDialogCancel>
              <AlertDialogAction variant="danger" size="lg" onClick={close} data-testid="wechat-discard-confirm-action">
                {formatMessage({ id: "message.chatPanel.overflow.discardChanges" })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </NarrowDialogContent>
    </Dialog>
  );
}

/** The step's one commit button (a submit: Enter in the code field sends it too). */
function ConnectCommit({ step, code }: { step: WeChatConnectStep; code: string }) {
  const { formatMessage } = useIntl();
  let label: string | null = null;
  let busy = false;
  let disabled = false;
  if (step.kind === "disclosure") label = formatMessage({ id: "assistant.wechat.showCode" });
  if (step.kind === "verify") {
    label = formatMessage({ id: "assistant.wechat.verify" });
    busy = step.checking;
    disabled = code.trim() === "";
  }
  if (step.kind === "failed" && step.reason !== "unavailable") label = formatMessage({ id: "assistant.wechat.newCode" });
  if (label === null) return null;
  return (
    <DialogCommit>
      {(inHead) => (
        <Button
          type="submit"
          variant="primary"
          size={inHead ? "md" : "lg"}
          loading={busy}
          loadingLabel={busy ? formatMessage({ id: "assistant.wechat.verifying" }) : undefined}
          disabled={disabled}
          data-testid="wechat-commit"
        >
          {label}
        </Button>
      )}
    </DialogCommit>
  );
}

/** The only button of a dialog that is only read: pink, and it closes. */
function CloseCommit({ onClose }: { onClose: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <DialogCommit>
      {(inHead) => (
        <Button type="button" variant="primary" size={inHead ? "md" : "lg"} onClick={onClose} data-testid="wechat-close">
          {formatMessage({ id: "common.close" })}
        </Button>
      )}
    </DialogCommit>
  );
}

/** The desktop app's way out: the web app's assistant page, in the system browser. */
function OpenInBrowserCommit() {
  const { formatMessage } = useIntl();
  const webUrl = useWeChatConnectWebUrl();
  if (!webUrl) return null;
  const label = formatMessage({ id: "assistant.wechat.openInBrowser" });
  return (
    <DialogCommit>
      {(inHead) => (
        <Button
          variant="primary"
          size={inHead ? "md" : "lg"}
          // The desktop shell hands a new window's https URL to the system browser
          // (setWindowOpenHandler → openInBrowser); a browser opens a tab.
          render={<a href={webUrl} target="_blank" rel="noopener noreferrer" aria-label={label} />}
          data-testid="wechat-open-browser"
        >
          {label}
        </Button>
      )}
    </DialogCommit>
  );
}

function ConnectStepBody({ name, step, code, onCodeChange }: {
  name: string;
  step: WeChatConnectStep;
  code: string;
  onCodeChange: (code: string) => void;
}) {
  if (step.kind === "disclosure") return <Disclosure name={name} />;
  if (step.kind === "verify") return <VerifyCode error={step.error} code={code} onCodeChange={onCodeChange} />;
  if (step.kind === "failed") return <Failed reason={step.reason} />;
  if (step.kind === "starting" || step.kind === "qr") return <QrStep name={name} step={step} />;
  return null;
}

function Disclosure({ name }: { name: string }) {
  const { formatMessage } = useIntl();
  return (
    <>
      <DialogDescription>{formatMessage({ id: "assistant.wechat.intro" }, { name })}</DialogDescription>
      {/* Hand-rolled: raft-ui has no text list. Dialog body text (text-subhead). */}
      <ul className="grid list-disc gap-1 pl-5 text-subhead text-foreground-muted" data-testid="wechat-disclosure">
        <li>{formatMessage({ id: "assistant.wechat.disclosureTencent" })}</li>
        <li>{formatMessage({ id: "assistant.wechat.disclosureReplaces" })}</li>
        <li>{formatMessage({ id: "assistant.wechat.disclosureWindow" }, { name })}</li>
      </ul>
      <Banner status="warning" size="sm">
        <TriangleAlert />
        <BannerTitle>{formatMessage({ id: "assistant.wechat.privacyTitle" })}</BannerTitle>
        <BannerDescription>{formatMessage({ id: "assistant.wechat.privacyBody" }, { name })}</BannerDescription>
      </Banner>
    </>
  );
}

function QrStep({ name, step }: { name: string; step: Extract<WeChatConnectStep, { kind: "starting" | "qr" }> }) {
  const { formatMessage } = useIntl();
  const { formatClock } = useTimeFormatter();
  const attempt = step.kind === "qr" ? step.attempt : null;
  let line: ReactNode;
  if (!attempt) line = formatMessage({ id: "assistant.wechat.gettingCode" });
  else if (step.kind === "qr" && step.scanned) line = formatMessage({ id: "assistant.wechat.scanned" });
  else {
    // A time in a sentence is still Space Mono (DS Typography › Usage).
    line = formatMessage(
      { id: "assistant.wechat.waiting" },
      { time: <span key="time" className="font-mono">{formatClock(attempt.expiresAt)}</span> },
    );
  }
  return (
    <>
      <DialogDescription>{formatMessage({ id: "assistant.wechat.scanInstruction" })}</DialogDescription>
      <WeChatQrCode content={attempt?.qrContent ?? null} label={formatMessage({ id: "assistant.wechat.qrLabel" })} />
      {/* Hand-rolled: a centered live line under the code; raft-ui has no part for it. */}
      <p role="status" className="flex items-center justify-center gap-2 text-center text-footnote text-foreground-muted" data-testid="wechat-qr-status">
        {attempt ? null : <Spinner aria-hidden="true" />}
        <span>{line}</span>
      </p>
      <Banner status="warning" size="sm">
        <TriangleAlert />
        <BannerDescription>{formatMessage({ id: "assistant.wechat.privacyReminder" }, { name })}</BannerDescription>
      </Banner>
    </>
  );
}

function VerifyCode({ error, code, onCodeChange }: {
  error: "wrong" | "malformed" | null;
  code: string;
  onCodeChange: (code: string) => void;
}) {
  const { formatMessage } = useIntl();
  const id = useId();
  const handleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => onCodeChange(event.target.value), [onCodeChange]);
  const message = error === "wrong"
    ? formatMessage({ id: "assistant.wechat.verifyWrong" })
    : error === "malformed" ? formatMessage({ id: "assistant.wechat.verifyMalformed" }) : undefined;
  return (
    <>
      <DialogDescription>{formatMessage({ id: "assistant.wechat.verifyBody" })}</DialogDescription>
      <FormField label={formatMessage({ id: "assistant.wechat.verifyLabel" })} htmlFor={id} error={message}>
        <Input
          id={id}
          type="text"
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus
          maxLength={16}
          value={code}
          onChange={handleChange}
          data-testid="wechat-verify-code"
        />
      </FormField>
    </>
  );
}

function Failed({ reason }: { reason: WeChatConnectFailure }) {
  const { formatMessage } = useIntl();
  return (
    <Banner status="warning" size="sm" data-testid="wechat-failed" data-reason={reason}>
      <TriangleAlert />
      <BannerDescription>{formatMessage({ id: FAILURE_IDS[reason] })}</BannerDescription>
    </Banner>
  );
}

/** No QR code here: where to connect instead, and in the desktop app the address it opens. */
function Blocked({ name, block }: { name: string; block: Exclude<WeChatConnectBlock, null> }) {
  const { formatMessage } = useIntl();
  const webUrl = useWeChatConnectWebUrl();
  return (
    <>
      <DialogDescription>{formatMessage({ id: "assistant.wechat.intro" }, { name })}</DialogDescription>
      <Banner status="info" size="sm" data-testid={`wechat-${block}-blocked`}>
        <Info />
        <BannerDescription>
          {formatMessage({ id: block === "desktop" ? "assistant.wechat.desktopBlocked" : "assistant.wechat.phoneBlocked" })}
        </BannerDescription>
      </Banner>
      {block === "desktop" && webUrl ? (
        <CopyableCodeRoot size="sm">
          <CopyableCode truncate data-testid="wechat-web-url">{webUrl}</CopyableCode>
          <CopyableCodeAction aria-label={formatMessage({ id: "assistant.wechat.copyAddress" })} />
        </CopyableCodeRoot>
      ) : null}
    </>
  );
}
