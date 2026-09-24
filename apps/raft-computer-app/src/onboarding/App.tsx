import React, { useEffect, useRef, useState } from "react";
import type { OnboardingStep, OnboardingTarget, WorkspaceEntry } from "./types.js";
import { SignIn } from "./SignIn.js";
import { SignInWaiting } from "./SignInWaiting.js";
import { Workspaces } from "./Workspaces.js";
import { WorkspacesEmpty } from "./WorkspacesEmpty.js";
import { decideWorkspaceStep, hasAvailableWorkspace } from "./workspaceStep.js";
import { SpinnerScreen } from "./SpinnerScreen.js";
import { Success } from "./Success.js";
import { Recovery } from "./Recovery.js";
import {
  createOnboardingActionId,
  recoveryFailureFromError,
} from "./recoveryDiagnostics.js";

const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_POLL_MS = 2_000;

export function App() {
  const [step, setStep] = useState<OnboardingStep>({ step: "loading" });
  const dashboardUrlRef = useRef("https://app.slock.ai");

  // Fetch configured dashboard URL once on mount
  useEffect(() => {
    void window.onboardingApi
      .getDashboardUrl()
      .then((url) => {
        dashboardUrlRef.current = url;
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    return window.onboardingApi.onTargetChanged((target) => {
      if (target === null) {
        void loadWorkspaces(setStep, false);
        return;
      }
      void loadExistingServerTarget(target, setStep, false);
    });
  }, []);

  useEffect(() => {
    if (step.step !== "loading") return;
    let cancelled = false;
    void (async () => {
      try {
        const loggedIn = await window.onboardingApi.isLoggedIn();
        if (cancelled) return;
        if (loggedIn) {
          const target = await window.onboardingApi.getInitialTarget().catch(() => null);
          if (target) {
            await loadExistingServerTarget(target, setStep, cancelled);
          } else {
            await loadWorkspaces(setStep, cancelled);
          }
        } else {
          setStep({ step: "sign-in" });
        }
      } catch {
        if (!cancelled) setStep({ step: "sign-in" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step.step]);

  // D3 verifying: poll getStatus for serverConnected on the specific workspace
  useEffect(() => {
    if (step.step !== "verifying") return;
    const { workspaceName, workspaceSlug, serverId, machineId } = step;
    let cancelled = false;
    const actionId = createOnboardingActionId();

    const timeoutId = setTimeout(() => {
      if (!cancelled) {
        setStep({
          step: "recovery",
          failedStep: "bring-online",
          message: "Verification timed out",
          errorCode: "VERIFY_TIMEOUT",
          actionId,
          workspaceName,
          workspaceSlug,
          serverId,
        });
      }
    }, VERIFY_TIMEOUT_MS);

    const poll = async () => {
      while (!cancelled) {
        try {
          const status = await window.onboardingApi.getStatus();
          const server = status.servers.find(
            (s) =>
              s.serverId === serverId &&
              s.health === "ok" &&
              s.serverConnected,
          );
          if (server && !cancelled) {
            const canConnectMore = await canConnectAnotherWorkspace(serverId);
            if (cancelled) return;
            setStep({
              step: "success",
              workspaceName,
              workspaceSlug,
              machineId,
              canConnectMore,
            });
            return;
          }
        } catch {
          // transient poll failure — keep trying
        }
        if (!cancelled) {
          await new Promise((r) => setTimeout(r, VERIFY_POLL_MS));
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [step.step]);

  const handleSignIn = async () => {
    const actionId = createOnboardingActionId();
    const cleanup = window.onboardingApi.onEvent((event) => {
      if (event.kind === "login.device-code") {
        const url = (event.verifyUrl ?? event.verificationUri ?? "") as string;
        setStep({
          step: "sign-in-waiting",
          verifyUrl: url,
          userCode: (event.userCode ?? "") as string,
        });
        if (url) void window.onboardingApi.openExternal(url);
      }
    });

    let signedIn = false;
    try {
      await window.onboardingApi.login();
      signedIn = true;
    } catch (err) {
      setStep({
        step: "recovery",
        failedStep: "sign-in",
        ...recoveryFailureFromError(err, actionId, "Could not sign in"),
      });
    } finally {
      cleanup();
    }

    if (!signedIn) return;
    await continueAfterSignIn(setStep, false, actionId);
  };

  const handleSelectWorkspace = (slug: string) => {
    if (step.step !== "workspaces") return;
    setStep({ ...step, selected: slug });
  };

  const handleConnect = async () => {
    if (step.step !== "workspaces" || !step.selected) return;
    const ws = step.workspaces.find((w) => w.slug === step.selected);
    if (!ws) return;
    const actionId = createOnboardingActionId();
    const { name, slug } = ws;

    setStep({ step: "connecting", workspaceName: name, workspaceSlug: slug });

    let serverId: string;
    let machineId: string | null;
    try {
      const result = await window.onboardingApi.attach(slug);
      serverId = result.serverId;
      machineId = result.machineId;
    } catch (err) {
      setStep({
        step: "recovery",
        failedStep: "connect",
        ...recoveryFailureFromError(
          err,
          actionId,
          "Could not attach this Computer",
        ),
        workspaceName: name,
        workspaceSlug: slug,
      });
      return;
    }

    setStep({
      step: "bringing-online",
      workspaceName: name,
      workspaceSlug: slug,
      serverId,
      machineId,
    });

    try {
      const cleanup = window.onboardingApi.onEvent(() => {});
      try {
        await window.onboardingApi.startService({ serverId, serverLabel: slug });
      } finally {
        cleanup();
      }
      setStep({
        step: "verifying",
        workspaceName: name,
        workspaceSlug: slug,
        serverId,
        machineId,
      });
    } catch (err) {
      setStep({
        step: "recovery",
        failedStep: "bring-online",
        ...recoveryFailureFromError(
          err,
          actionId,
          "Could not bring this Computer online",
        ),
        workspaceName: name,
        workspaceSlug: slug,
        serverId,
      });
    }
  };

  const handleRefreshWorkspaces = () => {
    void loadWorkspaces(setStep, false);
  };

  const handleOpenRaft = () => {
    const base = dashboardUrlRef.current.replace(/\/+$/, "");
    void window.onboardingApi.openExternal(`${base}/servers`);
  };

  const handleOpenBrowserAgain = () => {
    if (step.step === "sign-in-waiting") {
      void window.onboardingApi.openExternal(step.verifyUrl);
    }
  };

  const handleOpenWorkspace = () => {
    if (step.step === "success") {
      const base = `${dashboardUrlRef.current}/s/${step.workspaceSlug}`;
      const url = step.machineId ? `${base}/computer/${step.machineId}` : `${base}/computers`;
      void window.onboardingApi.openExternal(url);
      window.onboardingApi.closeWindow();
    }
  };

  const handleConnectMore = () => {
    void loadWorkspaces(setStep, false);
  };

  const handleDone = () => {
    window.onboardingApi.closeWindow();
  };

  const handleRetry = () => {
    if (step.step !== "recovery") return;
    switch (step.failedStep) {
      case "sign-in":
        setStep({ step: "sign-in" });
        break;
      case "connect":
        void loadWorkspaces(setStep, false);
        break;
      case "bring-online":
        if (step.workspaceName && step.workspaceSlug && step.serverId) {
          void retryBringOnline(
            step.workspaceName,
            step.workspaceSlug,
            step.serverId,
            setStep,
            null,
            createOnboardingActionId(),
          );
        } else {
          void loadWorkspaces(setStep, false);
        }
        break;
    }
  };

  let screen: React.ReactNode;
  switch (step.step) {
    case "loading":
    case "workspaces-loading":
      screen = <SpinnerScreen title="Loading..." description="" />;
      break;

    case "sign-in":
      screen = <SignIn onSignIn={handleSignIn} />;
      break;

    case "sign-in-waiting":
      screen = (
        <SignInWaiting
          userCode={step.userCode}
          onOpenBrowser={handleOpenBrowserAgain}
        />
      );
      break;

    case "workspaces":
      screen = (
        <Workspaces
          workspaces={step.workspaces}
          selected={step.selected}
          onSelect={handleSelectWorkspace}
          onConnect={handleConnect}
        />
      );
      break;

    case "workspaces-empty":
      screen = (
        <WorkspacesEmpty
          reason={step.reason}
          onOpenRaft={handleOpenRaft}
          onRefresh={handleRefreshWorkspaces}
        />
      );
      break;

    case "connecting":
    case "bringing-online":
    case "verifying":
      screen = (
        <SpinnerScreen
          title="Setting up..."
          description={`Connecting ${step.workspaceName} to this Computer.`}
        />
      );
      break;

    case "success":
      screen = (
        <Success
          workspaceName={step.workspaceName}
          onOpenWorkspace={handleOpenWorkspace}
          onConnectMore={step.canConnectMore ? handleConnectMore : undefined}
          onDone={handleDone}
        />
      );
      break;

    case "recovery":
      screen = (
        <Recovery
          failedStep={step.failedStep}
          message={step.message}
          errorCode={step.errorCode}
          actionId={step.actionId}
          onRetry={handleRetry}
          onClose={handleDone}
        />
      );
      break;
  }

  return (
    <>
      <button className="onb-close-btn" onClick={handleDone} title="Close">
        &#x2715;
      </button>
      {screen}
    </>
  );
}

async function continueAfterSignIn(
  setStep: React.Dispatch<React.SetStateAction<OnboardingStep>>,
  cancelled: boolean,
  actionId: string,
) {
  const target = await window.onboardingApi.getInitialTarget().catch(() => null);
  if (target) {
    await loadExistingServerTarget(target, setStep, cancelled, actionId);
  } else {
    await loadWorkspaces(setStep, cancelled, actionId);
  }
}

async function loadWorkspaces(
  setStep: React.Dispatch<React.SetStateAction<OnboardingStep>>,
  cancelled: boolean,
  actionId = createOnboardingActionId(),
) {
  setStep({ step: "workspaces-loading" });
  try {
    const result = await window.onboardingApi.listWorkspaces();
    if (cancelled) return;

    if (result.status === "success" && result.workspaces) {
      // Resolve existing-attachment rows so a Computer that is already attached
      // (re-login: the per-server attachment survives a user-session logout) is
      // reused straight to the connected state instead of dead-ending on the
      // "no server can connect" empty screen and creating a duplicate. (#132)
      const status = await window.onboardingApi.getStatus();
      if (cancelled) return;
      const next = decideWorkspaceStep(result.workspaces, status.servers);
      // A reused attachment whose service was stopped (sign-out, rule 1) comes
      // back as `bringing-online`: actually restart + verify so re-login lands
      // online, rather than freezing on a spinner with no side effect.
      if (next.step === "bringing-online") {
        await retryBringOnline(
          next.workspaceName,
          next.workspaceSlug,
          next.serverId,
          setStep,
          next.machineId,
          actionId,
        );
        return;
      }
      setStep(next);
    } else if (result.status === "not_logged_in") {
      setStep({ step: "sign-in" });
    } else {
      setStep({
        step: "recovery",
        failedStep: "connect",
        message: "Could not load workspaces",
        errorCode:
          result.status === "error" ? result.code : "WORKSPACES_FAILED",
        actionId,
      });
    }
  } catch (err) {
    if (cancelled) return;
    setStep({
      step: "recovery",
      failedStep: "connect",
      ...recoveryFailureFromError(err, actionId, "Could not load workspaces"),
    });
  }
}

async function loadExistingServerTarget(
  target: OnboardingTarget,
  setStep: React.Dispatch<React.SetStateAction<OnboardingStep>>,
  cancelled: boolean,
  actionId = createOnboardingActionId(),
) {
  setStep({ step: "workspaces-loading" });
  try {
    const status = await window.onboardingApi.getStatus();
    if (cancelled) return;
    const server = status.servers.find((s) => s.serverId === target.serverId);
    if (!server) {
      setStep({
        step: "recovery",
        failedStep: "connect",
        message: "This server is no longer attached on this Computer.",
        errorCode: "SERVER_NOT_ATTACHED",
        actionId,
        serverId: target.serverId,
      });
      return;
    }

    const workspace = await findWorkspace(target.serverId);
    if (cancelled) return;
    const workspaceName = workspace?.name ?? target.serverLabel ?? server.serverSlug ?? target.serverId.slice(0, 8);
    const workspaceSlug = workspace?.slug ?? server.serverSlug ?? target.serverId;
    const machineId = server.machineId ?? null;

    if (server.health === "ok" && server.serverConnected) {
      const canConnectMore = await canConnectAnotherWorkspace(target.serverId);
      if (cancelled) return;
      setStep({
        step: "success",
        workspaceName,
        workspaceSlug,
        machineId,
        canConnectMore,
      });
      return;
    }

    if (server.health === "ok") {
      setStep({
        step: "verifying",
        workspaceName,
        workspaceSlug,
        serverId: target.serverId,
        machineId,
      });
      return;
    }

    await retryBringOnline(
      workspaceName,
      workspaceSlug,
      target.serverId,
      setStep,
      machineId,
      actionId,
    );
  } catch (err) {
    if (cancelled) return;
    setStep({
      step: "recovery",
      failedStep: "connect",
      ...recoveryFailureFromError(err, actionId, "Could not load target server"),
      serverId: target.serverId,
    });
  }
}

async function findWorkspace(serverId: string): Promise<WorkspaceEntry | null> {
  const result = await window.onboardingApi.listWorkspaces();
  if (result.status !== "success" || !result.workspaces) return null;
  return result.workspaces.find((w) => w.id === serverId) ?? null;
}

async function canConnectAnotherWorkspace(excludeServerId: string): Promise<boolean> {
  try {
    const result = await window.onboardingApi.listWorkspaces();
    if (result.status !== "success" || !result.workspaces) return false;
    const status = await window.onboardingApi.getStatus();
    return hasAvailableWorkspace(result.workspaces, status.servers, excludeServerId);
  } catch {
    return false;
  }
}

async function retryBringOnline(
  workspaceName: string,
  workspaceSlug: string,
  serverId: string,
  setStep: React.Dispatch<React.SetStateAction<OnboardingStep>>,
  machineId: string | null = null,
  actionId = createOnboardingActionId(),
) {
  setStep({
    step: "bringing-online",
    workspaceName,
    workspaceSlug,
    serverId,
    machineId,
  });

  try {
    await window.onboardingApi.startService({
      serverId,
      serverLabel: workspaceSlug,
    });
    setStep({
      step: "verifying",
      workspaceName,
      workspaceSlug,
      serverId,
      machineId,
    });
  } catch (err) {
    setStep({
      step: "recovery",
      failedStep: "bring-online",
      ...recoveryFailureFromError(
        err,
        actionId,
        "Could not bring this Computer online",
      ),
      workspaceName,
      workspaceSlug,
      serverId,
    });
  }
}
