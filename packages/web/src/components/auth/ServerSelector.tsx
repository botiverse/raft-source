import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useIntl } from "react-intl";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { useServerStore } from "../../store/serverStore";
import type { Server } from "../../store/serverStore";
import { useAuthStore } from "../../store/authStore";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import CenteredCardFrame from "./CenteredCardFrame";
import { AuthPageIntro } from "./AuthPageFrame";
import FormField from "../ui/FormField";
import SlugInput from "../ui/SlugInput";
import OnboardingCreateShell from "./OnboardingCreateShell";
import ServerCreatePreview from "./ServerCreatePreview";
import SignedInAs from "./SignedInAs";
import { requestHostedOnboardingServerSwitch } from "../../embed/hostBridge";

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
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState("");
  const [switchPending, setSwitchPending] = useState(false);
  const switchTimeoutRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);

  useEffect(() => () => {
    if (switchTimeoutRef.current !== null) clearClockTimeout(switchTimeoutRef.current);
  }, []);

  const handleSelect = (server: Server) => {
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
  };

  const toSlug = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const server = await createServer(name, slug);
      onSelect(server);
    } catch (err: any) {
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
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-black/50">
                {title}
              </div>
              <h1 className="mt-2 text-2xl font-bold leading-tight text-black">
                {formatMessage({ id: "pages.serverSelector.nameTheServer" })}
              </h1>
              <p className="mt-2 text-sm leading-5 text-black/65">
                {formatMessage({ id: "pages.serverSelector.serverIsWorkspace" })}
              </p>
            </div>
            <form onSubmit={handleCreate} className="flex flex-col gap-3">
              {error && (
                <Banner intent="warning" className="font-bold">
                  {error}
                </Banner>
              )}
              <FormField
                label={formatMessage({ id: "pages.serverSelector.serverNameLabel" })}
                labelStyle="plain"
                hint={formatMessage({ id: "pages.serverSelector.serverNameHelp" })}
                htmlFor="server-create-name"
              >
                <input
                  id="server-create-name"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugTouched) setSlug(toSlug(e.target.value));
                  }}
                  className="input-brutal w-full p-2"
                  placeholder={formatMessage({ id: "pages.serverSelector.serverNamePlaceholder" })}
                  autoFocus
                  required
                />
              </FormField>
              <FormField
                label={formatMessage({ id: "pages.serverSelector.serverUrlLabel" })}
                labelStyle="plain"
                hint={formatMessage({ id: "pages.serverSelector.serverUrlHelp" })}
                htmlFor="server-create-slug"
              >
                <SlugInput
                  id="server-create-slug"
                  type="text"
                  value={slug}
                  onChange={(e) => {
                    setSlugTouched(true);
                    setSlug(toSlug(e.target.value));
                  }}
                  placeholder="alex-chen-studio"
                  required
                />
              </FormField>
              {/* Full-width primary action, same as every other onboarding page.
                  No Back here: this branch only renders when there is no server
                  to go back to. */}
              <Button
                type="submit"
                size="lg"
                tone="pink"
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

          <form onSubmit={handleCreate} className="space-y-3">
            {error && (
              <Banner intent="warning" className="font-bold">
                {error}
              </Banner>
            )}
            <FormField label={formatMessage({ id: "pages.serverSelector.serverNameLabel" })} labelStyle="plain">
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(toSlug(e.target.value));
                }}
                className="input-brutal w-full p-2"
                placeholder={formatMessage({ id: "pages.serverSelector.serverNamePlaceholderTeam" })}
                autoFocus
                required
              />
            </FormField>
            <FormField label={formatMessage({ id: "pages.serverSelector.urlSlugLabel" })} labelStyle="plain">
              <SlugInput
                type="text"
                value={slug}
                onChange={(e) => {
                  setSlugTouched(true);
                  setSlug(toSlug(e.target.value));
                }}
                placeholder="my-team"
                required
              />
            </FormField>
            <div className="flex gap-2 pt-1">
              {hasServers && (
                <button
                  type="button"
                  onClick={() => {
                    setView("choose");
                    setName("");
                    setSlug("");
                    setSlugTouched(false);
                    setError("");
                  }}
                  className="btn-brutal flex-1 bg-white px-4 py-2 text-sm font-bold"
                >
                  {formatMessage({ id: "pages.serverSelector.cancel" })}
                </button>
              )}
              <Button
                type="submit"
                size="lg"
                tone="pink"
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
          <div
            data-testid="server-selector-list"
            className="mb-6 space-y-2"
          >
            {servers.map((server) => (
              <button
                key={server.id}
                onClick={() => handleSelect(server)}
                disabled={switchPending}
                className="w-full border-2 border-black bg-white p-3 text-left font-bold shadow-brutal-sm transition-all duration-100 hover:-translate-y-[1px] hover:shadow-brutal active:translate-x-[2px] active:translate-y-[2px] active:shadow-brutal-active"
              >
                <div>{server.name}</div>
                <div className="text-sm font-normal text-black/40">/{server.slug}</div>
              </button>
            ))}
          </div>
        )}

        {error && (
          <Banner intent="warning" className="mb-3 font-bold">
            {error}
          </Banner>
        )}

        <Button
          onClick={() => setView("create")}
          size="lg"
          tone="pink"
          className="w-full"
        >
          {formatMessage({ id: "pages.serverSelector.createNewServerAction" })}
        </Button>
        <div className="mt-3 text-center">
          <button
            onClick={() => logout()}
            className="text-sm font-bold text-black/50 underline hover:text-black"
          >
            {formatMessage({ id: "pages.serverSelector.logOut" })}
          </button>
        </div>
      </div>
    </CenteredCardFrame>
  );
}
