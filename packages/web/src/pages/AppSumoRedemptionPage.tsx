import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { FormEvent } from "react";
import { isAxiosError } from "axios";
import { useNavigate } from "react-router-dom";
import { useIntl } from "react-intl";
import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, CardTrailing, DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm, Field, FieldDescription, FieldLabel, Select, SelectContent, SelectIcon, SelectItem, SelectItemIndicator, SelectItemText, SelectList, SelectTrigger, SelectValue } from "@botiverse/raft-ui";
import { ComboboxSelect } from "@botiverse/raft-ui/wip";
import { APPSUMO_PLAN_LIMITS, canMutateBilling, isAppSumoTier } from "@botiverse/raft-shared";
import type { AppSumoTier } from "@botiverse/raft-shared";
import api from "../api/client";
import { useAuthStore } from "../store/authStore";
import { useServerStore } from "../store/serverStore";
import AuthPageFrame, { AuthPageIntro } from "../components/auth/AuthPageFrame";
import Banner from "../components/ui/Banner";
import ServerSelector from "../components/auth/ServerSelector";
import type { MessageId } from "../i18n/messages";

declare const redemptionClaimIdBrand: unique symbol;
type RedemptionClaimId = string & { readonly [redemptionClaimIdBrand]: true };

type Claim = { status: "loading" | "failed" | "pending" | "bound" | "expired" } | { status: "ready"; claimId: RedemptionClaimId; tier: AppSumoTier };

/** Only non-credential claim details cross into the page. */
function readClaim(value: unknown): Claim {
  if (typeof value !== "object" || value === null) throw new Error("Invalid redemption response");
  if (!("status" in value)) throw new Error("Missing redemption status");
  if (value.status === "ready" && "claimId" in value && typeof value.claimId === "string" && value.claimId && "tier" in value && isAppSumoTier(value.tier)) {
    return { status: "ready", claimId: value.claimId as RedemptionClaimId, tier: value.tier };
  }
  if (value.status === "pending" || value.status === "bound" || value.status === "expired") return { status: value.status };
  throw new Error("Invalid redemption status");
}

const ERROR_MESSAGES: Record<string, MessageId> = {
  claim_expired: "appsumo.expired",
  owner_required: "appsumo.ownerRequired",
  license_not_active: "appsumo.notActive",
  license_already_bound: "appsumo.alreadyBound",
  paid_source_conflict: "appsumo.paidConflict",
  stripe_checkout_pending: "appsumo.checkoutPending",
  stripe_verification_unavailable: "appsumo.checkoutUnverified",
  appsumo_unavailable: "appsumo.unavailable",
};

function redemptionError(error: unknown): MessageId {
  const code = isAxiosError<{ code?: string }>(error) ? error.response?.data?.code : undefined;
  return (code && ERROR_MESSAGES[code]) || "appsumo.unavailable";
}

type PageState = { claim: Claim; selected: string | null; saving: boolean; error: MessageId | null };
type PageAction = { type: "loading" } | { type: "loaded"; claim: Claim } | { type: "loadFailed" | "bindFailed"; error: MessageId } | { type: "select"; selected: string | null } | { type: "binding" };
const INITIAL_STATE: PageState = { claim: { status: "loading" }, selected: null, saving: false, error: null };
function pageReducer(state: PageState, action: PageAction): PageState {
  switch (action.type) {
    case "loading": return INITIAL_STATE;
    case "loaded": return { ...state, claim: action.claim };
    case "loadFailed": return { ...state, claim: { status: "failed" }, error: action.error };
    case "select": return { ...state, selected: action.selected };
    case "binding": return { ...state, saving: true, error: null };
    case "bindFailed": return { ...state, saving: false, error: action.error, claim: action.error === "appsumo.expired" ? { status: "expired" } : state.claim };
  }
}

// AppShell supplies the existing login, email verification and account setup flow
// at this same URL. AppSumo's code/token is handled only by the backend callback.
export default function AppSumoRedemptionPage() {
  const { formatMessage: t, formatNumber } = useIntl();
  const navigate = useNavigate();
  const userId = useAuthStore((s) => s.user?.id);
  const servers = useServerStore((s) => s.servers);
  const loadServers = useServerStore((s) => s.loadServers);
  // This is a presentation filter, not proof that a Stripe checkout has settled.
  // The binding endpoint still rechecks paid sources and current ownership.
  const freeOwnedServers = useMemo(() => servers.filter((server) => canMutateBilling(server.role) && server.plan === "free"), [servers]);
  const [{ claim, selected, saving, error }, dispatch] = useReducer(pageReducer, INITIAL_STATE);
  const [refresh, setRefresh] = useState(0);
  const selectedServer = freeOwnedServers.find((server) => server.id === selected);
  const options = useMemo(() => freeOwnedServers.map((server) => ({ value: server.id, label: t({ id: "appsumo.serverOption" }, { name: server.name, slug: server.slug }) })), [freeOwnedServers, t]);

  useEffect(() => {
    const controller = new AbortController();
    dispatch({ type: "loading" });
    api.get<unknown>("/appsumo/redemption", { withCredentials: true, headers: { "X-Server-Id": false }, signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) dispatch({ type: "loaded", claim: readClaim(data) }); })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        dispatch({ type: "loadFailed", error: redemptionError(err) });
      });
    return () => controller.abort();
  }, [refresh, userId]);

  const reload = useCallback(() => {
    setRefresh((value) => value + 1);
    void loadServers({ fresh: true, listOnly: true });
  }, [loadServers]);
  const bind = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (claim.status !== "ready" || !selectedServer || saving) return;
    dispatch({ type: "binding" });
    try {
      const { data } = await api.post<unknown>("/appsumo/redemption/bind", { serverId: selectedServer.id, claimId: claim.claimId }, { withCredentials: true, headers: { "X-Server-Id": false } });
      if (typeof data !== "object" || data === null || !("serverId" in data) || data.serverId !== selectedServer.id || !("serverSlug" in data) || typeof data.serverSlug !== "string" || !data.serverSlug) throw new Error("Invalid activation response");
      await loadServers({ fresh: true, listOnly: true });
      navigate(`/s/${encodeURIComponent(data.serverSlug)}/settings/billing`, { replace: true });
    } catch (err: unknown) {
      dispatch({ type: "bindFailed", error: redemptionError(err) });
    }
  }, [claim, selectedServer, saving, loadServers, navigate]);
  const selectServer = useCallback((value: string | number | null) => dispatch({ type: "select", selected: typeof value === "string" ? value : null }), []);
  const openServers = useCallback(() => navigate("/servers"), [navigate]);
  const createServer = useCallback(() => navigate("/appsumo/redeem/create-server"), [navigate]);

  return (
    <AuthPageFrame maxWidthClass={claim.status === "ready" ? "max-w-4xl" : "max-w-lg"}>
      <div className="w-full">
        <div className="mx-auto mb-8 max-w-xl">
          <AuthPageIntro title={t({ id: "appsumo.title" })} description={t({ id: "appsumo.description" })} />
        </div>
        {error && claim.status !== "ready" && <Banner intent="warning" role="alert" className="mb-4">{t({ id: error })}</Banner>}
        {claim.status === "loading" && <p role="status" className="text-callout text-foreground-muted">{t({ id: "appsumo.loading" })}</p>}
        {claim.status === "pending" && <p role="status" className="mb-4 text-callout text-foreground-muted">{t({ id: "appsumo.pending" })}</p>}
        {claim.status === "expired" && <p className="mb-4 text-callout text-foreground-muted">{t({ id: "appsumo.expired" })}</p>}
        {claim.status === "bound" && <p className="mb-4 text-callout text-foreground-muted">{t({ id: "appsumo.alreadyBound" })}</p>}
        {claim.status === "ready" && <div className="grid items-start gap-8 md:grid-cols-2">
          <Card render={<section aria-labelledby="appsumo-plan-title" />}>
            <CardHeader>
              <CardTitle render={<h2 id="appsumo-plan-title">{t({ id: "billing.appsumoLifetimePlan" }, { tier: claim.tier })}</h2>} />
              <CardTrailing><Button type="button" variant="ghost" size="md" onClick={reload} disabled={saving}>{t({ id: "appsumo.refresh" })}</Button></CardTrailing>
              <CardDescription><Badge variant="information" appearance="soft">{t({ id: "appsumo.lifetime" })}</Badge></CardDescription>
            </CardHeader>
            <CardContent>
              <DescriptionList direction="vertical" className="grid grid-cols-2 gap-x-4 gap-y-6">
                <DescriptionItem className="[&+&]:pt-0">
                  <DescriptionTerm>{t({ id: "billing.humans" })}</DescriptionTerm>
                  <DescriptionDetails className="font-mono text-headline">{formatNumber(APPSUMO_PLAN_LIMITS[claim.tier].maxHumans)}</DescriptionDetails>
                </DescriptionItem>
                <DescriptionItem className="[&+&]:pt-0">
                  <DescriptionTerm>{t({ id: "billing.agents" })}</DescriptionTerm>
                  <DescriptionDetails className="font-mono text-headline">{formatNumber(APPSUMO_PLAN_LIMITS[claim.tier].maxAgents)}</DescriptionDetails>
                </DescriptionItem>
                <DescriptionItem className="[&+&]:pt-0">
                  <DescriptionTerm>{t({ id: "appsumo.hostedJoints" })}</DescriptionTerm>
                  <DescriptionDetails className="font-mono text-headline">{formatNumber(APPSUMO_PLAN_LIMITS[claim.tier].maxHostedJointChannels)}</DescriptionDetails>
                </DescriptionItem>
                <DescriptionItem className="[&+&]:pt-0">
                  <DescriptionTerm>{t({ id: "appsumo.monthlyUploads" })}</DescriptionTerm>
                  <DescriptionDetails className="font-mono text-headline">{t({ id: "appsumo.uploadGiB" }, { count: APPSUMO_PLAN_LIMITS[claim.tier].monthlyUploadBytes / 1024 ** 3 })}</DescriptionDetails>
                </DescriptionItem>
              </DescriptionList>
            </CardContent>
            <CardFooter>{t({ id: "appsumo.uploadReset" })}</CardFooter>
          </Card>
          <form onSubmit={bind} className="flex min-w-0 flex-col gap-5">
            <div>
              <h2 className="text-headline text-foreground">{t({ id: "appsumo.chooseDestination" })}</h2>
              <p className="mt-2 text-callout text-foreground-muted">{t({ id: "appsumo.bindingNote" })}</p>
            </div>
            {error && <Banner intent="warning" role="alert">{t({ id: error })}</Banner>}
            {freeOwnedServers.length > 0 ? <>
              <Field>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <FieldLabel id="appsumo-server-label">{t({ id: "appsumo.server" })}</FieldLabel>
                  <Button type="button" variant="default" size="md" onClick={createServer} disabled={saving}>{t({ id: "pages.serverSelector.createServerAction" })}</Button>
                </div>
                {options.length > 10 ? <ComboboxSelect aria-labelledby="appsumo-server-label" options={options} value={selected} onValueChange={selectServer} showArrow autoHighlight disabled={saving} /> :
                  <Select value={selected} onValueChange={selectServer} items={options} disabled={saving}>
                    <SelectTrigger className="w-full" aria-labelledby="appsumo-server-label"><SelectValue placeholder={t({ id: "appsumo.chooseServer" })} /><SelectIcon /></SelectTrigger>
                    <SelectContent><SelectList>{options.map((option) => <SelectItem key={option.value} value={option.value}><SelectItemText>{option.label}</SelectItemText><SelectItemIndicator /></SelectItem>)}</SelectList></SelectContent>
                  </Select>}
                <FieldDescription>{t({ id: "appsumo.chooseDescription" })}</FieldDescription>
              </Field>
              {selectedServer && <p className="text-callout text-foreground-muted" aria-live="polite">{t({ id: "appsumo.confirmDescription" }, { server: selectedServer.name })}</p>}
              <Button type="submit" variant="primary" size="xl" className="w-full" loading={saving} loadingLabel={t({ id: "appsumo.activating" })} disabled={!selectedServer || saving}>{t({ id: "appsumo.activate" })}</Button>
            </> : <>
              <p className="text-callout text-foreground-muted">{t({ id: "appsumo.noOwnedServer" })}</p>
              <Button type="button" variant="primary" size="lg" onClick={createServer} disabled={saving}>{t({ id: "pages.serverSelector.createServerAction" })}</Button>
            </>}
          </form>
        </div>}
        {claim.status !== "ready" && <div className="mt-5 flex flex-wrap justify-center gap-3">
          <Button type="button" variant="default" size="lg" onClick={reload} disabled={saving || claim.status === "loading"}>{t({ id: "appsumo.refresh" })}</Button>
          {claim.status === "bound" && <Button type="button" variant="default" size="lg" onClick={openServers}>{t({ id: "appsumo.servers" })}</Button>}
        </div>}
      </div>
    </AuthPageFrame>
  );
}

/** Keep account/server creation on a fixed local return path; the HttpOnly claim stays backend-owned. */
export function AppSumoServerCreationPage() {
  const navigate = useNavigate();
  const returnToRedemption = useCallback(() => navigate("/appsumo/redeem", { replace: true }), [navigate]);
  return <ServerSelector onSelect={returnToRedemption} />;
}
