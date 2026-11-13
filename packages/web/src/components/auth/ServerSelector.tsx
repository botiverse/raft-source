import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { useServerStore } from "../../store/serverStore";
import type { Server } from "../../store/serverStore";
import { useAuthStore } from "../../store/authStore";
import Banner from "../ui/Banner";
import { Input, Button, ListRowGroup, TextLink } from "@botiverse/raft-ui";
import CenteredCardFrame from "./CenteredCardFrame";
import { AuthPageIntro } from "./AuthPageFrame";
import FormField from "../ui/FormField";
import SlugInput from "../ui/SlugInput";
import OnboardingCreateShell from "./OnboardingCreateShell";
import ServerCreatePreview from "./ServerCreatePreview";
import SignedInAs from "./SignedInAs";
import { requestHostedOnboardingServerSwitch } from "../../embed/hostBridge";
import { ServerOptionCard } from "./ServerOptionCard";
import { useServerNameAndSlug } from "./useServerNameAndSlug";
import { DeploymentUserLimitText } from "../ui/DeploymentUserLimitText";
import { isDeploymentUserLimitRefusal } from "../../utils/deploymentUserLimit";

interface ServerSelectorProps {
  onSelect: (server: Server) => void;
}

export default function ServerSelector({ onSelect }: ServerSelectorProps) {
  const { formatMessage } = useIntl();
  const servers = useServerStore((s) => s.servers);
  const createServer = useServerStore((s) => s.createServer);
  const serversLoading = useServerStore((s) => s.loading);
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const hasServers = servers.length > 0;

  const [view, setView] = useState<"choose" | "create">(() => hasServers ? "choose" : "create");
  // An empty list is not the same as "no servers": until the list has actually loaded it
  // means nothing. Rendering create-your-first-server on the strength of it flashed that
  // screen at people who had just been INVITED to a server and were about to land in it
  // (stdrc, 2026-07-13).
  const undecided = serversLoading && !hasServers;

  // The server list arrives asynchronously (and is emptied on logout), so the initial
  // guess can be wrong. A "Choose server" screen with nothing to choose is not a screen:
  // someone mid-onboarding must land back on create-your-first-server, where they left off.
  useEffect(() => {
    if (!hasServers) setView("create");
  }, [hasServers]);
  const { name, slug, handleNameChange, handleSlugChange, reset: resetNameAndSlug } = useServerNameAndSlug();
  const [error, setError] = useState("");
  // Creating it refused at the Raft License's user limit: its sentence has a mail link, so it is not a string.
  const [userLimitRefused, setUserLimitRefused] = useState(false);
  const shownError: ReactNode = userLimitRefused ? <DeploymentUserLimitText /> : error;
  const [switchPending, setSwitchPending] = useState(false);
  const switchTimeoutRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);

  useEffect(() => () => {
    if (switchTimeoutRef.current !== null) clearClockTimeout(switchTimeoutRef.current);
  }, []);

  const handleSelect = useCallback((server: Server) => {
    const outcome = requestHostedOnboardingServerSwitch(server.id);
    if (outcome === "not-hosted") {
      onSelect(server);
      return;
    }
    if (outcome === "failed") {
      setError(formatMessage({ id: "pages.serverSelector.switchFailed" }));
      return;
    }
    setError("");
    setSwitchPending(true);
    switchTimeoutRef.current = setClockTimeout(() => {
      switchTimeoutRef.current = null;
      setSwitchPending(false);
      setError(formatMessage({ id: "pages.serverSelector.switchFailed" }));
    }, 5000);
  }, [onSelect, formatMessage]);

  const handleCancelCreate = useCallback(() => {
    setView("choose");
    resetNameAndSlug();
    setError("");
    setUserLimitRefused(false);
  }, [resetNameAndSlug]);

  const handleShowCreate = useCallback(() => {
    setView("create");
  }, []);

  const handleLogout = useCallback(() => {
    void logout();
  }, [logout]);

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setUserLimitRefused(false);
    try {
      const server = await createServer(name, slug);
      onSelect(server);
    } catch (err: any) {
      if (isDeploymentUserLimitRefusal(err)) {
        setUserLimitRefused(true);
        return;
      }
      setError(err.response?.data?.error || formatMessage({ id: "pages.serverSelector.createFailed" }));
    }
  };

  // Show nothing while we do not yet know whether this person has servers. A blank beat is
  // honest; guessing wrong flashes a screen that contradicts where they are going.
  if (undecided) return null;

  if (view === "create") {
    // Stryker disable all: this block is the first-server Screen A presentation.
    // Its contract is guarded by source + DOM tests and Josh/Cat review.
    const isFirstServer = !hasServers;
    // `isFirstServer` is necessarily true wherever `title` is read (the block
    // below is guarded by it and returns), so the old ternary's other arm —
    // "Create a server" — could never render. Dead copy, removed with @AngLee's
    // sign-off rather than carried into the catalog as an unverifiable id.
    const title = formatMessage({ id: "pages.serverSelector.createFirstHeading" });

    if (isFirstServer) {
      return (
        <OnboardingCreateShell
          preview={<ServerCreatePreview serverName={name} serverSlug={slug} />}
        >
          <>
            <div>
              {/* The onboarding step label (DS ScreenOnboarding): Space Mono 12.
                  Its copy is a sentence, not a "Step 1 of 3" count, so it keeps
                  sentence case, not all caps. */}
              <div className="font-mono text-mono-meta text-foreground-hint">
                {title}
              </div>
              <h1 className="mt-2 text-title text-foreground sm:text-display">
                {formatMessage({ id: "pages.serverSelector.nameTheServer" })}
              </h1>
              <p className="mt-3 text-subhead text-foreground-muted">
                {formatMessage({ id: "pages.serverSelector.serverIsWorkspace" })}
              </p>
            </div>
            <form onSubmit={handleCreate} className="flex flex-col gap-3">
              {shownError && (
                <Banner intent="warning">
                  {shownError}
                </Banner>
              )}
              <FormField
                label={formatMessage({ id: "pages.serverSelector.serverNameLabel" })}
                hint={formatMessage({ id: "pages.serverSelector.serverNameHelp" })}
                htmlFor="server-create-name"
              >
                <Input
                  id="server-create-name"
                  type="text"
                  value={name}
                  onChange={handleNameChange}
                  placeholder={formatMessage({ id: "pages.serverSelector.serverNamePlaceholder" })}
                  autoFocus
                  required
                />
              </FormField>
              <FormField
                label={formatMessage({ id: "pages.serverSelector.serverUrlLabel" })}
                hint={formatMessage({ id: "pages.serverSelector.serverUrlHelp" })}
                htmlFor="server-create-slug"
              >
                <SlugInput
                  id="server-create-slug"
                  type="text"
                  value={slug}
                  onChange={handleSlugChange}
                  placeholder="alex-chen-studio"
                  required
                />
              </FormField>
              {/* Full-width primary action, same as every other onboarding page.
                  No Back here: this branch only renders when there is no server
                  to go back to. */}
              <Button
                type="submit"
                size="xl"
                variant="accent"
                className="w-full"
              >
                {formatMessage({ id: "pages.serverSelector.createServerAction" })}
              </Button>
            </form>
          </>
        </OnboardingCreateShell>
      );
    }
    // Stryker restore all

    return (
      <CenteredCardFrame>
        <div className="w-full">
          <AuthPageIntro
            // Mirror image: this path is only reached after the isFirstServer
            // block above returns, so isFirstServer is necessarily false here.
            title={formatMessage({ id: "pages.serverSelector.createHeadingB" })}
          />

          <form onSubmit={handleCreate} className="stack-y-3">
            {shownError && (
              <Banner intent="warning">
                {shownError}
              </Banner>
            )}
            <FormField label={formatMessage({ id: "pages.serverSelector.serverNameLabel" })}>
              <Input
                type="text"
                value={name}
                onChange={handleNameChange}
                placeholder={formatMessage({ id: "pages.serverSelector.serverNamePlaceholderTeam" })}
                autoFocus
                required
              />
            </FormField>
            <FormField label={formatMessage({ id: "pages.serverSelector.urlSlugLabel" })}>
              <SlugInput
                type="text"
                value={slug}
                onChange={handleSlugChange}
                placeholder="my-team"
                required
              />
            </FormField>
            <div className="flex gap-2 pt-1">
              {hasServers && (
                <Button
                  type="button"
                  variant="default"
                  size="lg"
                  className="flex-1"
                  onClick={handleCancelCreate}
                >
                  {formatMessage({ id: "pages.serverSelector.cancel" })}
                </Button>
              )}
              <Button
                type="submit"
                size="lg"
                variant="accent"
                className="flex-1"
              >
                {formatMessage({ id: "pages.serverSelector.createServerAction" })}
              </Button>
            </div>
          </form>
        </div>
      </CenteredCardFrame>
    );
  }

  return (
    <CenteredCardFrame>
      <div className="w-full">
        <AuthPageIntro
          title={formatMessage({ id: "pages.serverSelector.chooseServerTitle" })}
          description={user ? (
            <SignedInAs user={user} />
          ) : undefined}
        />

        {servers.length > 0 && (
          // DS ListRow › `rf-list--inset`: one card holding the servers.
          <ListRowGroup
            data-testid="server-selector-list"
            className="mb-6"
          >
            {servers.map((server) => (
              <ServerOptionCard key={server.id} server={server} switchPending={switchPending} onSelect={handleSelect} />
            ))}
          </ListRowGroup>
        )}

        {error && (
          <Banner intent="warning" className="mb-3">
            {error}
          </Banner>
        )}

        <Button
          onClick={handleShowCreate}
          size="xl"
          variant="accent"
          className="w-full"
        >
          {formatMessage({ id: "pages.serverSelector.createNewServerAction" })}
        </Button>
        <div className="mt-3 text-center">
          <TextLink className="text-footnote" onClick={handleLogout}>
            {formatMessage({ id: "pages.serverSelector.logOut" })}
          </TextLink>
        </div>
      </div>
    </CenteredCardFrame>
  );
}
