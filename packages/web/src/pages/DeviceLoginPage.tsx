import { useCallback, useEffect, useId, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useIntl } from "react-intl";
import { Button, Field, FieldDescription, FieldLabel, Input } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import api from "../api/client";
import { useAuthStore } from "../store/authStore";
import AuthPageFrame, { AuthPageIntro } from "../components/auth/AuthPageFrame";
import SignedInAs from "../components/auth/SignedInAs";
import Banner from "../components/ui/Banner";
import FormField from "../components/ui/FormField";
import { StepUpBeforeApproval } from "../components/auth/SecondFactorCodeEntry";
import { parseMethods } from "../components/auth/secondFactorSignIn";
import type { SignInSecondFactorMethod } from "../components/auth/secondFactorSignIn";
import { stepUpBeforeApproval } from "../components/settings/secondFactorApi";

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

/** A server the person may add a machine to (describe's `grant.servers`). */
type AttachableServer = { id: string; slug: string; name: string };

/** An agent the person may give a key to (describe's `grant.agents`). */
type KeyableAgent = { id: string; name: string; displayName: string | null; serverId: string; serverName: string };

/** The machine's own account of itself: whoever started the login chose every field. */
type GrantRequester = { machineName: string | null; hostname: string | null; os: string | null };

/** A one-time grant: what the login asks for, and what this person may pick. */
type DeviceLoginGrant =
  | (GrantRequester & { kind: "computer_attach"; servers: AttachableServer[] })
  // The same server pick as an attach; the computer then adopts one of the
  // person's own old daemons on that server.
  | (GrantRequester & { kind: "computer_migrate"; servers: AttachableServer[] })
  // requestedAgentId is deliberately unused: the requester sets it, so it must
  // not steer which agent the approver picks.
  | (GrantRequester & { kind: "agent_key"; requestedAgentId: string | null; agents: KeyableAgent[] });

type GrantKind = DeviceLoginGrant["kind"];

/** What `POST /auth/device/describe` answers for a code that can still be approved. */
type DeviceLoginRequest = {
  /** The typed code in its stored form. */
  userCode: string;
  clientName: string | null;
  requestedAt: string;
  requester: { ip: string | null; location: string | null };
  /** Approve needs it: proof this page checked the code (a page that approves from its link has none). */
  approvalTicket: string;
  /** Present when the login asks for a one-time grant instead of a session. */
  grant?: DeviceLoginGrant;
};

/** One row of the picker, the same shape for a server and an agent. */
type GrantChoice = { id: string; label: string; detail: string; mono: boolean };

function grantChoices(grant: DeviceLoginGrant): GrantChoice[] {
  if (grant.kind === "computer_attach" || grant.kind === "computer_migrate") {
    // DS › Switching servers: a server is its name and its address in Space Mono.
    return grant.servers.map((server) => ({ id: server.id, label: server.name, detail: `/${server.slug}`, mono: true }));
  }
  return grant.agents.map((agent) => ({
    id: agent.id,
    label: agent.displayName || agent.name,
    detail: agent.displayName && agent.displayName !== agent.name ? `${agent.name} · ${agent.serverName}` : agent.serverName,
    mono: false,
  }));
}

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

/** A grant this page knows how to show; any other kind is refused before a pick. */
function isKnownGrant(grant: DeviceLoginGrant | undefined): boolean {
  return grant === undefined || grant.kind === "computer_attach" || grant.kind === "computer_migrate" || grant.kind === "agent_key";
}

/** What the approved page says was granted (null: a legacy device session). */
type GrantOutcome = { kind: GrantKind; requesterName: string | null; pickedName: string };

/** What a refused describe or approve call carries (axios error). */
type DeviceLoginFailure = { response?: { data?: { code?: string; error?: string; methods?: unknown } } };

type Step =
  | { kind: "enter" }
  | { kind: "confirm"; request: DeviceLoginRequest }
  // Two-step verification is on and this sign-in hasn't passed it: verify
  // first, then the same approval goes through (design v2 device-stepup).
  | { kind: "stepUp"; request: DeviceLoginRequest; pick: string | null; methods: SignInSecondFactorMethod[] }
  | { kind: "approved"; outcome: GrantOutcome | null }
  | { kind: "denied" };

function normalizeUserCode(value: string): string {
  return value.trim().toUpperCase();
}

export default function DeviceLoginPage() {
  const intl = useIntl();
  const { formatMessage } = intl;
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [userCode, setUserCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "enter" });
  const [submitting, setSubmitting] = useState<"describe" | "approve" | "deny" | null>(null);
  const [closeAttempted, setCloseAttempted] = useState(false);
  const [error, setError] = useState("");
  // The server or agent picked for a one-time grant; never defaulted.
  const [pickedId, setPickedId] = useState<string | null>(null);
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

  const showFailure = useCallback((
    err: DeviceLoginFailure,
    fallbackId: "pages.deviceLogin.describeFailedFallback" | "pages.deviceLogin.approveFailedFallback" | "pages.deviceLogin.denyFailedFallback",
  ) => {
    const code = err.response?.data?.code;
    if (code === "user_code_invalid") {
      setError(formatMessage({ id: "pages.deviceLogin.codeInvalid" }));
    } else if (code === "expired") {
      setError(formatMessage({ id: "pages.deviceLogin.codeExpired" }));
    } else if (code === "already_resolved") {
      setError(formatMessage({ id: "pages.deviceLogin.codeAlreadyUsed" }));
    } else {
      setError(err.response?.data?.error || formatMessage({ id: fallbackId }));
    }
  }, [formatMessage]);

  async function describeDeviceLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedCode) return;

    setSubmitting("describe");
    setError("");
    try {
      const { data } = await api.post<DeviceLoginRequest>("/auth/device/describe", { userCode: normalizedCode });
      if (!isKnownGrant(data.grant)) {
        setError(formatMessage({ id: "pages.deviceLogin.grantKindUnsupported" }));
        return;
      }
      setPickedId(null);
      setStep({ kind: "confirm", request: data });
    } catch (err) {
      showFailure(err as DeviceLoginFailure, "pages.deviceLogin.describeFailedFallback");
    } finally {
      setSubmitting(null);
    }
  }

  const resolveDeviceLogin = useCallback(async (request: DeviceLoginRequest, approve: boolean, pick: string | null) => {
    const { grant } = request;
    // A grant is approved only for an explicit pick (the button stays disabled
    // without one; the server refuses one anyway).
    if (approve && grant && !pick) return;
    setSubmitting(approve ? "approve" : "deny");
    setError("");
    const selection = approve && grant && pick
      ? (grant.kind === "agent_key" ? { agentId: pick } : { serverId: pick })
      : {};
    try {
      await api.post("/auth/device/approve", approve
        ? { userCode: request.userCode, approve, approvalTicket: request.approvalTicket, ...selection }
        : { userCode: request.userCode, approve });
      if (!approve) {
        setStep({ kind: "denied" });
        return;
      }
      const picked = grant && pick ? grantChoices(grant).find((choice) => choice.id === pick) : undefined;
      setStep({
        kind: "approved",
        outcome: grant && picked ? { kind: grant.kind, requesterName: grant.machineName, pickedName: picked.label } : null,
      });
    } catch (err) {
      const code = (err as DeviceLoginFailure).response?.data?.code;
      if (approve && code === "second_factor_step_up_required") {
        // Only for people with two-step verification on; the code stays pending.
        setStep({ kind: "stepUp", request, pick, methods: parseMethods((err as DeviceLoginFailure).response?.data?.methods) });
        return;
      }
      if (grant && (code === "grant_selection_required" || code === "grant_selection_not_allowed")) {
        // The code is still pending: stay here so the person can pick again.
        const server = grant.kind !== "agent_key";
        setPickedId(null);
        setError(formatMessage({
          id: code === "grant_selection_required"
            ? (server ? "pages.deviceLogin.serverSelectionRequired" : "pages.deviceLogin.agentSelectionRequired")
            : (server ? "pages.deviceLogin.serverSelectionNotAllowed" : "pages.deviceLogin.agentSelectionNotAllowed"),
        }));
        return;
      }
      // The code can't be approved any more (expired, used): back to typing one.
      setStep({ kind: "enter" });
      if (code === "grant_kind_unsupported") {
        setError(formatMessage({ id: "pages.deviceLogin.grantKindUnsupported" }));
        return;
      }
      showFailure(err as DeviceLoginFailure, approve ? "pages.deviceLogin.approveFailedFallback" : "pages.deviceLogin.denyFailedFallback");
    } finally {
      setSubmitting(null);
    }
  }, [formatMessage, showFailure]);

  const handleApprove = useCallback(() => {
    if (step.kind === "confirm") void resolveDeviceLogin(step.request, true, pickedId);
  }, [step, pickedId, resolveDeviceLogin]);
  const handleDeny = useCallback(() => {
    if (step.kind === "confirm") void resolveDeviceLogin(step.request, false, null);
  }, [step, resolveDeviceLogin]);
  const handlePick = useCallback((value: string) => {
    setPickedId(value);
    setError("");
  }, []);
  const handleDifferentCode = useCallback(() => {
    setUserCode("");
    setError("");
    setPickedId(null);
    setStep({ kind: "enter" });
  }, []);

  const closePage = useCallback(() => {
    setCloseAttempted(true);
    window.close();
  }, []);
  const handleUseAnotherAccount = useCallback(() => logout(), [logout]);
  const handleSteppedUp = useCallback(async () => {
    if (step.kind !== "stepUp") return;
    setStep({ kind: "confirm", request: step.request });
    setPickedId(step.pick);
    await resolveDeviceLogin(step.request, true, step.pick);
  }, [resolveDeviceLogin, step]);
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
            onVerified={step.kind === "stepUp" ? handleSteppedUp : handleUpFrontVerified}
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

  if (step.kind === "confirm") {
    const { request } = step;
    const { grant } = request;
    // A migration picks a server like an attach; only its wording differs.
    const migrate = grant?.kind === "computer_migrate";
    const attach = grant?.kind === "computer_attach" || migrate;
    const requestedAt = new Date(request.requestedAt);
    const minutesAgo = Math.max(0, Math.round((Date.now() - requestedAt.getTime()) / 60_000));
    const from = [request.requester.ip, request.requester.location].filter(Boolean).join(" · ");
    // The requester's own name is plain text everywhere (quoted, never a link):
    // whoever started the login chose it.
    let title = formatMessage({ id: "pages.deviceLogin.confirmTitle" });
    if (grant) {
      const name = grant.machineName;
      title = migrate
        ? (name ? formatMessage({ id: "pages.deviceLogin.migrateTitle" }, { name }) : formatMessage({ id: "pages.deviceLogin.migrateTitleUnnamed" }))
        : attach
        ? (name ? formatMessage({ id: "pages.deviceLogin.attachTitle" }, { name }) : formatMessage({ id: "pages.deviceLogin.attachTitleUnnamed" }))
        : (name ? formatMessage({ id: "pages.deviceLogin.agentKeyTitle" }, { name }) : formatMessage({ id: "pages.deviceLogin.agentKeyTitleUnnamed" }));
    }
    const machineDetail = grant ? [grant.hostname, grant.os].filter(Boolean).join(" · ") : "";
    return (
      <AuthPageFrame>
        <div className="w-full">
          <AuthPageIntro
            title={title}
            description={(
              <SignedInAs user={user} prefix={formatMessage({ id: "pages.deviceLogin.signedInAsPrefix" })} suffix="." />
            )}
          />

          <Banner intent="warning" withIcon className="mb-4">
            {formatMessage({
              id: !grant
                ? "pages.deviceLogin.phishingWarning"
                : migrate ? "pages.deviceLogin.migratePhishingWarning"
                  : attach ? "pages.deviceLogin.attachPhishingWarning" : "pages.deviceLogin.agentKeyPhishingWarning",
            })}
          </Banner>

          {/* Static facts, not targets: raft-ui's ListRow is a clickable row, so
              a plain description list in the field rhythm. */}
          <dl className="stack-y-3 mb-6 text-body">
            <div>
              <dt className="text-caption text-foreground-hint">{formatMessage({ id: "pages.deviceLogin.codeLabel" })}</dt>
              <dd className="font-mono">{request.userCode}</dd>
            </div>
            {grant ? (
              <div>
                <dt className="text-caption text-foreground-hint">
                  {formatMessage({ id: attach ? "pages.deviceLogin.machineLabel" : "pages.deviceLogin.requesterLabel" })}
                </dt>
                <dd>
                  <bdi>
                    {grant.machineName
                      ? formatMessage({ id: "pages.deviceLogin.programNamed" }, { name: grant.machineName })
                      : formatMessage({ id: "pages.deviceLogin.programNotGiven" })}
                  </bdi>
                </dd>
                {machineDetail ? (
                  <dd className="text-caption text-foreground-muted"><bdi>{machineDetail}</bdi></dd>
                ) : null}
                <dd className="text-caption text-foreground-hint">
                  {formatMessage({ id: "pages.deviceLogin.machineSelfReported" })}
                </dd>
              </div>
            ) : (
              <div>
                <dt className="text-caption text-foreground-hint">{formatMessage({ id: "pages.deviceLogin.programLabel" })}</dt>
                {/* Every name the same way, quoted as given: the requester picks it,
                    so no name earns a friendlier label than another. <bdi> keeps
                    it from reordering the text around it. */}
                <dd>
                  <bdi>
                    {request.clientName
                      ? formatMessage({ id: "pages.deviceLogin.programNamed" }, { name: request.clientName })
                      : formatMessage({ id: "pages.deviceLogin.programNotGiven" })}
                  </bdi>
                </dd>
                <dd className="text-caption text-foreground-hint">
                  {formatMessage({ id: "pages.deviceLogin.programSelfReported" })}
                </dd>
              </div>
            )}
            <div>
              <dt className="text-caption text-foreground-hint">{formatMessage({ id: "pages.deviceLogin.startedLabel" })}</dt>
              <dd>
                {formatMessage(
                  { id: "pages.deviceLogin.startedValue" },
                  {
                    ago: intl.formatRelativeTime(-minutesAgo, "minute", { numeric: "auto" }),
                    time: intl.formatTime(requestedAt, { hour: "numeric", minute: "2-digit" }),
                  },
                )}
              </dd>
            </div>
            <div>
              <dt className="text-caption text-foreground-hint">{formatMessage({ id: "pages.deviceLogin.fromLabel" })}</dt>
              <dd>{from || formatMessage({ id: "pages.deviceLogin.fromUnknown" })}</dd>
            </div>
          </dl>

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
                onValueChange={handlePick}
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
                {!grant
                  ? formatMessage({ id: submitting === "approve" ? "pages.deviceLogin.approving" : "pages.deviceLogin.approve" })
                  : migrate
                    ? formatMessage({ id: submitting === "approve" ? "pages.deviceLogin.movingToServer" : "pages.deviceLogin.moveToServer" })
                  : attach
                    ? formatMessage({ id: submitting === "approve" ? "pages.deviceLogin.addingToServer" : "pages.deviceLogin.addToServer" })
                    : formatMessage({ id: submitting === "approve" ? "pages.deviceLogin.givingKey" : "pages.deviceLogin.giveKey" })}
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={handleDeny}
              disabled={submitting !== null}
              size="lg"
              variant="outline"
              className="w-full"
            >
              {submitting === "deny" ? formatMessage({ id: "pages.deviceLogin.denying" }) : formatMessage({ id: "pages.deviceLogin.deny" })}
            </Button>
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
