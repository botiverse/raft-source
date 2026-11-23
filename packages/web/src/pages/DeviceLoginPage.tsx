import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import { Button, Field, FieldDescription, FieldLabel, Input } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import { useAuthStore } from "../store/authStore";
import AuthPageFrame, { AuthPageIntro } from "../components/auth/AuthPageFrame";
import SignedInAs from "../components/auth/SignedInAs";
import Banner from "../components/ui/Banner";
import FormField from "../components/ui/FormField";
import { StepUpBeforeApproval } from "../components/auth/SecondFactorCodeEntry";
import type { SignInSecondFactorMethod } from "../components/auth/secondFactorSignIn";
import { stepUpBeforeApproval } from "../components/settings/secondFactorApi";
import { DeviceLoginRequestDetails } from "../components/auth/DeviceLoginRequestDetails";
import { deviceLoginApproveLabel, deviceLoginConfirmTitle, grantChoices, normalizeUserCode } from "../components/auth/deviceLoginApproval";
import type { GrantChoice } from "../components/auth/deviceLoginApproval";
import { useDeviceLoginApproval } from "../components/auth/useDeviceLoginApproval";
import type { DeviceLoginStep } from "../components/auth/useDeviceLoginApproval";

// Approving a device login gives whoever started it a session on this account,
// so the page never takes the code from the link (a link with the code in it
// is how someone gets a person to approve *their* login in one click): the
// person types the code their own terminal shows, then sees who asked (the
// name the program gave, when, from where) and a warning before approving.
//
// A login can instead ask for one thing (a one-time grant, deviceLoginGrantService
// on the server): add this machine to a server (computer_attach), move this
// machine's old Raft daemon on a server over to it (computer_migrate), or give
// this program a key for an agent (agent_key). The page then says so in plain words
// and the person picks the server or agent from the list describe returns.
// Nothing is ever picked for them, not even when the list has one entry: the
// pick is the consent, and the server refuses an approve without one.
//
// A loopback login (`?request=<id>`, RFC 8252) has no code to type: the program
// on this computer opened this page for its own request, so the page describes
// it by that id and shows the same confirm screen (same step-up, same picker
// with no default). Approve and deny answer the program's 127.0.0.1 address,
// and the page sends the browser there. The id alone completes nothing: the
// one-time code goes only to that address on this computer, and redeeming it
// needs a secret only that program holds.

// The describe/approve calls and the confirm screen's facts are shared with
// Add Computer's code field (components/auth/useDeviceLoginApproval.ts,
// DeviceLoginRequestDetails.tsx); this page adds the server or agent picker,
// the up-front step-up and the loopback link.

function choiceListItems(choices: GrantChoice[]): ChoiceListItem[] {
  return choices.map((choice) => ({
    value: choice.id,
    label: choice.label,
    searchText: `${choice.label} ${choice.detail}`,
    description: choice.mono ? <span className="font-mono">{choice.detail}</span> : choice.detail,
  }));
}

const NO_CHOICES: GrantChoice[] = [];
const NO_METHODS: SignInSecondFactorMethod[] = [];

/** The loopback request this page was opened for (`?request=`), read once. */
function loopbackRequestIdFromUrl(): string | null {
  return new URLSearchParams(window.location.search).get("request") || null;
}

export default function DeviceLoginPage() {
  const { formatMessage } = useIntl();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [userCode, setUserCode] = useState("");
  const [loopbackRequestId] = useState(loopbackRequestIdFromUrl);
  const approval = useDeviceLoginApproval((): DeviceLoginStep => (loopbackRequestId ? { kind: "opening" } : { kind: "enter" }));
  const { step, submitting, error, pickedId, describe, approve, deny, pick, reset, steppedUp } = approval;
  const [closeAttempted, setCloseAttempted] = useState(false);
  // Two-step verification is on and this sign-in hasn't passed it (GET
  // /auth/second-factor/status): verify before typing the code (design
  // device-stepup). Null for everyone else, and whenever the status can't be
  // read: then the approval's 403 asks instead.
  const [upFrontMethods, setUpFrontMethods] = useState<SignInSecondFactorMethod[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void stepUpBeforeApproval().then((methods) => {
      if (!cancelled && methods) setUpFrontMethods(methods);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Links from older servers still carry `?user_code=`: drop it unread, so the
  // code a person approves is always one they typed.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("user_code")) return;
    url.searchParams.delete("user_code");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }, []);

  const handleUserCodeChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setUserCode(event.target.value);
  }, []);

  const normalizedCode = normalizeUserCode(userCode);

  // Opened for a loopback request: straight to its confirm screen.
  useEffect(() => {
    if (!loopbackRequestId) return;
    let current = true;
    void describe({ requestId: loopbackRequestId }, () => current);
    return () => {
      current = false;
    };
  }, [describe, loopbackRequestId]);

  function describeDeviceLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedCode) return;
    void describe({ userCode: normalizedCode });
  }

  const handleApprove = useCallback(() => approve(pickedId), [approve, pickedId]);
  const handleDifferentCode = useCallback(() => {
    setUserCode("");
    reset();
  }, [reset]);

  const closePage = useCallback(() => {
    setCloseAttempted(true);
    window.close();
  }, []);
  const handleUseAnotherAccount = useCallback(() => logout(), [logout]);
  const handleUpFrontVerified = useCallback(() => setUpFrontMethods(null), []);
  // Up front only before a code is described: once the person is past it, the approval's 403 asks.
  const upFront = step.kind === "enter" && submitting === null ? upFrontMethods : null;
  const pickerLabelId = useId();
  const confirmGrant = step.kind === "confirm" ? step.request.grant : undefined;
  const choices = useMemo(() => (confirmGrant ? grantChoices(confirmGrant) : NO_CHOICES), [confirmGrant]);
  const choiceItems = useMemo(() => choiceListItems(choices), [choices]);

  if (step.kind === "approved" || step.kind === "denied") {
    const outcome = step.kind === "approved" ? step.outcome : null;
    let title: string;
    let description: string;
    if (step.kind === "denied") {
      title = formatMessage({ id: "pages.deviceLogin.deniedTitle" });
      description = formatMessage({ id: "pages.deviceLogin.deniedDescription" });
    } else if (outcome?.kind === "computer_attach") {
      title = formatMessage({ id: "pages.deviceLogin.attachApprovedTitle" });
      description = outcome.requesterName
        ? formatMessage({ id: "pages.deviceLogin.attachApprovedDescription" }, { machine: outcome.requesterName, server: outcome.pickedName })
        : formatMessage({ id: "pages.deviceLogin.attachApprovedDescriptionUnnamed" }, { server: outcome.pickedName });
    } else if (outcome?.kind === "computer_migrate") {
      title = formatMessage({ id: "pages.deviceLogin.migrateApprovedTitle" });
      description = outcome.requesterName
        ? formatMessage({ id: "pages.deviceLogin.migrateApprovedDescription" }, { machine: outcome.requesterName, server: outcome.pickedName })
        : formatMessage({ id: "pages.deviceLogin.migrateApprovedDescriptionUnnamed" }, { server: outcome.pickedName });
    } else if (outcome?.kind === "agent_key") {
      title = formatMessage({ id: "pages.deviceLogin.agentKeyApprovedTitle" });
      description = outcome.requesterName
        ? formatMessage({ id: "pages.deviceLogin.agentKeyApprovedDescription" }, { requester: outcome.requesterName, agent: outcome.pickedName })
        : formatMessage({ id: "pages.deviceLogin.agentKeyApprovedDescriptionUnnamed" }, { agent: outcome.pickedName });
    } else {
      title = formatMessage({ id: "pages.deviceLogin.approvedTitle" });
      description = formatMessage({ id: "pages.deviceLogin.approvedDescription" });
    }
    return (
      <AuthPageFrame>
        <div className="w-full">
          <AuthPageIntro title={title} description={description} />
          <Button
            type="button"
            onClick={closePage}
            size="xl"
            variant="accent"
            className="w-full"
          >
            {formatMessage({ id: "pages.deviceLogin.closePage" })}
          </Button>
          {closeAttempted ? (
            <p className="mt-3 text-center text-caption text-foreground-hint">
              {formatMessage({ id: "pages.deviceLogin.closeManually" })}
            </p>
          ) : null}
        </div>
      </AuthPageFrame>
    );
  }

  if (step.kind === "stepUp" || upFront) {
    return (
      <AuthPageFrame>
        <div className="w-full">
          <AuthPageIntro
            title={formatMessage({ id: "pages.deviceLogin.approveTitle" })}
            description={(
              <SignedInAs user={user} prefix={formatMessage({ id: "pages.deviceLogin.signedInAsPrefix" })} suffix="." />
            )}
          />
          <StepUpBeforeApproval
            notice={formatMessage({ id: "pages.deviceLogin.stepUpNotice" })}
            methods={step.kind === "stepUp" ? step.methods : upFront ?? NO_METHODS}
            onVerified={step.kind === "stepUp" ? steppedUp : handleUpFrontVerified}
          />
          <Button
            type="button"
            onClick={handleUseAnotherAccount}
            size="lg"
            variant="outline"
            className="mt-3 w-full"
          >
            {formatMessage({ id: "pages.deviceLogin.useAnotherAccount" })}
          </Button>
        </div>
      </AuthPageFrame>
    );
  }

  if (step.kind === "opening") {
    return (
      <AuthPageFrame>
        <div className="w-full">
          <AuthPageIntro
            title={formatMessage({ id: "pages.deviceLogin.approveTitle" })}
            description={formatMessage({ id: "pages.deviceLogin.checking" })}
          />
        </div>
      </AuthPageFrame>
    );
  }

  if (step.kind === "confirm") {
    const { request } = step;
    const { grant } = request;
    // A migration picks a server like an attach; only its wording differs.
    const migrate = grant?.kind === "computer_migrate";
    const attach = grant?.kind === "computer_attach" || migrate;
    const loopback = request.mode === "loopback";
    return (
      <AuthPageFrame>
        <div className="w-full">
          <AuthPageIntro
            title={deviceLoginConfirmTitle(formatMessage, grant)}
            description={(
              <SignedInAs user={user} prefix={formatMessage({ id: "pages.deviceLogin.signedInAsPrefix" })} suffix="." />
            )}
          />

          <DeviceLoginRequestDetails request={request} />

          {grant && choices.length === 0 ? (
            // Nothing to pick: say why, offer no approve (deny still ends the login).
            <Banner intent="info" withIcon className="mb-4">
              {formatMessage({ id: attach ? "pages.deviceLogin.noAttachableServers" : "pages.deviceLogin.noKeyableAgents" })}
            </Banner>
          ) : null}

          {grant && choices.length > 0 ? (
            <Field className="mb-6">
              <FieldLabel id={pickerLabelId}>
                {formatMessage({ id: attach ? "pages.deviceLogin.serverPickerLabel" : "pages.deviceLogin.agentPickerLabel" })}
              </FieldLabel>
              {/* Under the label, not the list: with a long list this is what
                  says why the approve button is still disabled. */}
              <FieldDescription>
                {formatMessage({ id: migrate ? "pages.deviceLogin.migrateServerPickerHint" : attach ? "pages.deviceLogin.serverPickerHint" : "pages.deviceLogin.agentPickerHint" })}
              </FieldDescription>
              {/* An open list at any count (DS › Picking something: choosing is
                  this page's job). No default, even for one choice: the pick
                  is the consent. */}
              <ChoiceList
                aria-labelledby={pickerLabelId}
                items={choiceItems}
                value={pickedId}
                onValueChange={pick}
                disabled={submitting !== null}
                searchLabel={formatMessage({ id: attach ? "pages.deviceLogin.serverSearch" : "pages.deviceLogin.agentSearch" })}
                searchPlaceholder={formatMessage({ id: attach ? "pages.deviceLogin.serverSearch" : "pages.deviceLogin.agentSearch" })}
                clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
                noMatchLabel={formatMessage({ id: "ui.selectionPopover.emptyLabel" })}
              />
            </Field>
          ) : null}

          {error ? (
            <Banner intent="warning" className="mb-4">{error}</Banner>
          ) : null}

          <div className="stack-y-3">
            {!grant || choices.length > 0 ? (
              <Button
                type="button"
                onClick={handleApprove}
                disabled={submitting !== null || (grant !== undefined && pickedId === null)}
                size="xl"
                variant="accent"
                className="w-full"
              >
                {deviceLoginApproveLabel(formatMessage, grant, submitting === "approve")}
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={deny}
              disabled={submitting !== null}
              size="lg"
              variant="outline"
              className="w-full"
            >
              {submitting === "deny" ? formatMessage({ id: "pages.deviceLogin.denying" }) : formatMessage({ id: "pages.deviceLogin.deny" })}
            </Button>
            {loopback ? null : (
              <Button
                type="button"
                onClick={handleDifferentCode}
                disabled={submitting !== null}
                size="lg"
                variant="ghost"
                className="w-full"
              >
                {formatMessage({ id: "pages.deviceLogin.differentCode" })}
              </Button>
            )}
          </div>
        </div>
      </AuthPageFrame>
    );
  }

  return (
    <AuthPageFrame>
      <div className="w-full">
        <AuthPageIntro
          title={formatMessage({ id: "pages.deviceLogin.approveTitle" })}
          description={(
            <SignedInAs user={user} prefix={formatMessage({ id: "pages.deviceLogin.signedInAsPrefix" })} suffix="." />
          )}
        />

        {error ? (
          <Banner intent="warning" className="mb-4">{error}</Banner>
        ) : null}

        <form onSubmit={describeDeviceLogin} className="stack-y-4 md:pointer-fine:stack-y-3">
          <FormField
            label={formatMessage({ id: "pages.deviceLogin.deviceCodeLabel" })}
            hint={formatMessage({ id: "pages.deviceLogin.deviceCodeHint" })}
          >
            {/* A device code is machine text: Space Mono, centred, in the
                standard 44px ink-line field. */}
            <Input
              type="text"
              value={userCode}
              onChange={handleUserCodeChange}
              placeholder={formatMessage({ id: "pages.deviceLogin.codePlaceholder" })}
              autoCapitalize="characters"
              autoComplete="off"
              className="w-full text-center font-mono"
            />
          </FormField>

          <Button
            type="submit"
            disabled={submitting !== null || !normalizedCode}
            size="xl"
            variant="accent"
            className="w-full"
          >
            {submitting === "describe" ? formatMessage({ id: "pages.deviceLogin.checking" }) : formatMessage({ id: "pages.deviceLogin.continue" })}
          </Button>
        </form>

        <Button
          type="button"
          onClick={handleUseAnotherAccount}
          size="lg"
          variant="outline"
          className="mt-3 w-full"
        >
          {formatMessage({ id: "pages.deviceLogin.useAnotherAccount" })}
        </Button>
      </div>
    </AuthPageFrame>
  );
}
