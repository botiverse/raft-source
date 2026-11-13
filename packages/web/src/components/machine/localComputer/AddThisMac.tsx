// "Add This Mac" in place (design §4.2; the one flow, inline): the same hero
// as This device's page ("Let agents work on this Mac", one button), then the
// same "Setting up this Mac" steps as Add Computer's dialog (install → connect
// → start → online, waiting for the server to list it, a failure with Try
// Again and the logs, Ready), from the same setup
// (addThisComputerStore), shown where the person already is: onboarding's
// connect step. No confirmation: the button starts it.
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Step, Steps } from "@botiverse/raft-ui";
import type { LocalComputerHost } from "./useLocalComputerHost";
import { ThisDeviceSetupFlow } from "./AddThisDeviceFlow";
import { setupForServer, startAddThisComputer, useAddThisComputerStore } from "./addThisComputerStore";
import { completeEnableProgress, ENABLE_PROGRESS_START } from "./addThisDeviceChoice";

export function AddThisMac({ host, serverSlug, serverName, onStart, errorText, testId = "add-this-mac", listedOutcome = null }: {
  host: LocalComputerHost;
  serverSlug: string;
  serverName: string;
  /** Told when the person starts it (onboarding's funnel counts it). */
  onStart?: () => void;
  /** How a failure reads here. */
  errorText?: (error: unknown) => string;
  testId?: string;
  /**
   * Once the server lists this Mac, the card stays, finished, and shows these
   * lines (onboarding: "<name> is connected.", the runtimes detected) in the
   * steps' own type, so the step does not change layout.
   */
  listedOutcome?: ReadonlyArray<{ key: string; text: string; done: boolean; pending: boolean; failed?: boolean }> | null;
}) {
  const { formatMessage } = useIntl();
  const mac = host.self.deviceKind === "mac";
  const stored = useAddThisComputerStore();
  const own = setupForServer(stored, serverSlug);
  // Already on this server (listed, or attached and waiting to be listed), say
  // so, whatever this window started: after a relaunch, or added elsewhere,
  // it is never "Add to this server" again.
  const alreadyHere = own.phase === "idle" && (host.self.machineId !== null || host.self.state.flags.awaitingListing);
  const phase = alreadyHere ? "ready" : own.phase;
  const progress = alreadyHere ? completeEnableProgress(ENABLE_PROGRESS_START) : own.progress;
  const error = alreadyHere ? null : own.error;
  const setup = useMemo(() => ({ phase, progress, error }), [error, phase, progress]);
  const listed = host.self.machineId !== null && !host.self.state.flags.awaitingListing;
  const run = useCallback(() => {
    startAddThisComputer(host, serverSlug);
  }, [host, serverSlug]);
  const start = useCallback(() => {
    onStart?.();
    run();
  }, [onStart, run]);
  const noop = useCallback(() => {}, []);

  const finished = listedOutcome !== null && listed && phase === "ready";
  return (
    <Card variant="inset" data-testid={testId} data-phase={phase}>
      <CardHeader>
        <CardTitle>{formatMessage({ id: mac ? "computerHost.thisDevice.empty.titleMac" : "computerHost.thisDevice.empty.titleOther" })}</CardTitle>
        <CardDescription>{formatMessage({ id: "computerHost.thisDevice.empty.body" })}</CardDescription>
      </CardHeader>
      <CardContent>
        {finished ? (
          <Steps vertical current={listedOutcome.length} data-testid={`${testId}-outcome`}>
            {listedOutcome.map((line) => (
              <Step key={line.key} title={line.text} status={line.done ? "finish" : line.failed ? "error" : "process"} data-line={line.key} data-state={line.done ? "done" : line.failed ? "failed" : "pending"} />
            ))}
          </Steps>
        ) : phase === "idle" ? (
          <Button variant="primary" size="md" onClick={start} data-computer-op="enable" data-testid={`${testId}-start`}>
            {formatMessage({ id: "computerHost.thisDevice.addToServer" })}
          </Button>
        ) : (
          <ThisDeviceSetupFlow
            host={host}
            setup={setup}
            onRun={run}
            serverName={serverName}
            onFinish={noop}
            onCancel={noop}
            presentation="inline"
            errorText={errorText}
          />
        )}
      </CardContent>
    </Card>
  );
}
