import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { currentTimeMs } from "@botiverse/raft-shared";
import { subscribeLiveTime } from "../../hooks/liveTimeClock";
import Banner from "../ui/Banner";
import type { DeviceLoginRequest } from "./deviceLoginApproval";

/**
 * The confirm screen's body for one device login, wherever it is approved
 * (the device login page, Add Computer): the warning against approving
 * someone else's login, then who asked (the code, the program or computer
 * by the name it gave, its hostname and OS), when, and from where.
 * `extraFacts` adds rows at the end (Add Computer: the server it is for).
 */
export function DeviceLoginRequestDetails({ request, extraFacts }: { request: DeviceLoginRequest; extraFacts?: ReactNode }) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const { grant } = request;
  const migrate = grant?.kind === "computer_migrate";
  const attach = grant?.kind === "computer_attach" || migrate;
  const loopback = request.mode === "loopback";
  // How long ago the login was started, from the live clock: the screen may wait open while the person decides.
  const readMinutesAgo = () => Math.max(0, Math.round((currentTimeMs() - new Date(request.requestedAt).getTime()) / 60_000));
  const minutesAgo = useSyncExternalStore(subscribeLiveTime, readMinutesAgo, readMinutesAgo);
  const requestedAt = new Date(request.requestedAt);
  const from = [request.requester.ip, request.requester.location].filter(Boolean).join(" · ");
  const machineDetail = grant ? [grant.hostname, grant.os].filter(Boolean).join(" · ") : "";

  return (
    <>
      <Banner intent="warning" withIcon className="mb-4">
        {formatMessage({
          id: !grant
            ? "pages.deviceLogin.phishingWarning"
            : migrate ? "pages.deviceLogin.migratePhishingWarning"
              : attach ? "pages.deviceLogin.attachPhishingWarning" : "pages.deviceLogin.agentKeyPhishingWarning",
        })}
        {loopback ? (
          <span className="mt-2 block">{formatMessage({ id: "pages.deviceLogin.loopbackSameComputer" })}</span>
        ) : null}
      </Banner>

      {/* Static facts, not targets: raft-ui's ListRow is a clickable row, so
          a plain description list in the field rhythm. The requester's own
          name is plain text everywhere (quoted, never a link): whoever
          started the login chose it. */}
      <dl className="stack-y-3 mb-6 text-body">
        {request.userCode ? (
          <div>
            <dt className="text-caption text-foreground-hint">{formatMessage({ id: "pages.deviceLogin.codeLabel" })}</dt>
            <dd className="font-mono">{request.userCode}</dd>
          </div>
        ) : null}
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
        {extraFacts}
      </dl>
    </>
  );
}
