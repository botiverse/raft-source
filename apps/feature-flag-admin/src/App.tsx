import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  Eye,
  Flag,
  FlaskConical,
  GitBranch,
  Loader2,
  LogIn,
  LogOut,
  Megaphone,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  auditReasonValid,
  createLabMutationBody,
  fallbackLabel,
  LAB_OPERATOR_ENDPOINTS,
  labKeyValid,
  labRuleCanBeRemoved,
  labTransitionLabel,
  nextLabStates,
  orderedRules,
  ruleTargetLabel,
  selectableLabs,
  type FeatureFlagRuleStage,
  type LabDefinition,
  type LabState,
} from "./labs";
import { AnnouncementsSurface } from "./AnnouncementsSurface";

type Principal = {
  sub: string;
  type: "human" | "agent";
  serverId: string;
  serverSlug: string | null;
  serverRole: string | null;
  name: string | null;
  preferredUsername: string | null;
};

type SessionResponse = { principal: Principal | null };

type FeatureFlagSummary = {
  key: string;
  description: string | null;
  enabled: boolean;
  killSwitch: boolean;
  randomizationUnit: "user" | "server";
  defaultEnabled: boolean;
  defaultVariant: string | null;
  highRisk?: boolean;
  updatedAt: string;
};

type FeatureFlagRule = {
  id: string;
  stage: FeatureFlagRuleStage;
  priority: number;
  decision: "allow" | "deny";
  values?: string[];
  serverTargets?: ServerTarget[];
  percentageBasisPoints: number | null;
  variant: string | null;
  createdAt?: string;
  updatedAt: string;
};

export type ServerTarget = {
  serverSlug: string | null;
  status: "active" | "unknown_or_deleted";
};

export type ServerOption = { serverSlug: string };

export type AudienceMember = {
  memberId: string;
  kind: "user" | "server";
  userId?: string;
  serverSlug?: string | null;
  status: "active" | "unknown_or_deleted";
};

export type AudienceDefinition = {
  audienceKey: string;
  name: string;
  description: string;
  enabled: boolean;
  members: AudienceMember[];
  affectedFlags: string[];
  createdAt: string;
  updatedAt: string;
};

type ServerAllowlist = { managed: boolean; ruleId: string | null; serverTargets: ServerTarget[] };
type ServerAllowlistRule = { ruleId: string; priority: number; serverTargets: ServerTarget[] };

type FeatureFlagDetail = {
  flag: FeatureFlagSummary;
  rules: FeatureFlagRule[];
  serverAllowlist: ServerAllowlist;
  serverAllowlistRules: ServerAllowlistRule[];
  unsupportedRuleShapes: string[];
};

const AGENT_MIGRATION_PARTNER_RULE_ID = "a4362b16-4c5f-443a-853a-103648ff3c34";

type ApiEnvelope<T> = { data: T; configVersion?: number; requestId?: string };
type ApiError = { error?: string | { code?: string; message?: string }; message?: string };
type ActionMessage = { tone: "ok" | "error" | "pending"; text: string };
type Surface = "flags" | "audiences" | "labs" | "announcements";

const SURFACE_PATH: Record<Surface, string> = {
  flags: "/",
  audiences: "/audiences",
  labs: "/labs",
  announcements: "/announcements",
};

export function surfaceForPath(pathname: string): Surface {
  if (pathname === "/audiences" || pathname.startsWith("/audiences/")) return "audiences";
  if (pathname === "/labs" || pathname.startsWith("/labs/")) return "labs";
  if (pathname === "/announcements" || pathname.startsWith("/announcements/")) return "announcements";
  return "flags";
}

export function audienceKeyValid(value: string): boolean {
  return /^[a-z0-9][a-z0-9_.-]{0,127}$/.test(value);
}

export function parseUserIdLines(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function labelFor(principal: Principal) {
  return principal.name || principal.preferredUsername || principal.sub;
}

function errorMessage(body: ApiError, fallback: string) {
  if (typeof body.error === "object" && body.error?.message) return body.error.message;
  if (typeof body.error === "object" && body.error?.code) return body.error.code;
  if (typeof body.error === "string") return body.message || body.error;
  return body.message || fallback;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({})) as ApiError;
  if (!response.ok) throw new Error(errorMessage(body, `Request failed (${response.status})`));
  return body as T;
}

function normalizeDetail(data: FeatureFlagDetail | { detail?: FeatureFlagDetail }): FeatureFlagDetail {
  const detail = "detail" in data && data.detail ? data.detail : data as FeatureFlagDetail;
  const serverAllowlistRules = detail.serverAllowlistRules ?? detail.rules
    .filter((rule) => rule.stage === "server" && rule.decision === "allow" && rule.percentageBasisPoints === null && rule.variant === null)
    .map((rule) => ({ ruleId: rule.id, priority: rule.priority, serverTargets: rule.serverTargets ?? [] }));
  return { ...detail, serverAllowlistRules };
}

export const UNKNOWN_SERVER_LABEL = "Unknown/deleted server";

export function serverDisplayLabel(target: ServerTarget): string {
  return target.status === "active" && target.serverSlug ? target.serverSlug : UNKNOWN_SERVER_LABEL;
}

export function serverAllowlistBody(
  serverSlug: string,
  targetRuleId: string,
  reason: string,
  expectedConfigVersion: number | null,
) {
  return { serverSlug: serverSlug.trim(), targetRuleId, reason: reason.trim(), expectedConfigVersion };
}

export function serverCatalogPath(query: string): string {
  const normalized = query.trim().toLowerCase();
  return `/api/operator/servers?query=${encodeURIComponent(normalized)}`;
}

export function serverTargetIsSelected(targets: ServerTarget[], serverSlug: string): boolean {
  return targets.some((target) => target.status === "active" && target.serverSlug === serverSlug);
}

export function serverPickerMutation(selectedNow: boolean, targetRuleSelected: boolean): "add" | "remove" | "create" {
  if (selectedNow) return "remove";
  return targetRuleSelected ? "add" : "create";
}

export function previewBody(serverSlug: string, userId: string) {
  const body: { serverSlug?: string; userId?: string } = {};
  const normalizedServerSlug = serverSlug.trim();
  const normalizedUserId = userId.trim();
  if (normalizedServerSlug) body.serverSlug = normalizedServerSlug;
  if (normalizedUserId) body.userId = normalizedUserId;
  return body;
}

function labsFrom<T>(data: T | { labs?: LabDefinition[] }, fallback: LabDefinition[]): LabDefinition[] {
  if (typeof data === "object" && data !== null && "labs" in data && Array.isArray(data.labs)) return data.labs;
  return fallback;
}

export function defaultTargetRuleId(key: string, detail: FeatureFlagDetail): string {
  if (key !== "agent_migration_v0") return "";
  return detail.serverAllowlistRules.some((rule) => rule.ruleId === AGENT_MIGRATION_PARTNER_RULE_ID)
    ? AGENT_MIGRATION_PARTNER_RULE_ID
    : "";
}

function LoginScreen({ error }: { error: string | null }) {
  return (
    <main className="min-h-screen bg-brutal-cream px-4 py-10">
      <section className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-5xl content-center gap-8 md:grid-cols-[1fr_360px] md:items-center">
        <div className="space-y-5">
          <div className="inline-flex items-center gap-2 border-2 border-black bg-brutal-yellow px-3 py-1 text-xs font-black uppercase shadow-brutal-sm">
            <Flag size={16} /> Botiverse private app
          </div>
          <div className="space-y-3">
            <h1 className="max-w-2xl text-5xl font-black leading-none tracking-normal text-black md:text-6xl">Feature Flag Admin</h1>
            <p className="max-w-xl text-lg font-semibold leading-relaxed text-black/70">Authenticated feature-flag and Lab operations with durable audit receipts.</p>
          </div>
        </div>
        <div className="border-2 border-black bg-white p-5 shadow-brutal">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex size-12 items-center justify-center border-2 border-black bg-brutal-lime shadow-brutal-sm"><ShieldCheck size={24} /></div>
            <div><div className="text-lg font-black">Login with Raft</div><div className="text-xs font-bold text-black/50">Human | agent operator access</div></div>
          </div>
          {error ? <div className="mb-4 border-2 border-black bg-brutal-red px-3 py-2 text-sm font-bold">{error}</div> : null}
          <a href="/login" className="btn-brutal w-full bg-brutal-yellow px-4 py-3 text-sm"><LogIn size={18} /> Continue with Raft</a>
        </div>
      </section>
    </main>
  );
}

function Console({ principal, onLogout }: { principal: Principal; onLogout: () => void }) {
  const [surface, setSurface] = useState<Surface>(() => surfaceForPath(window.location.pathname));
  const [flags, setFlags] = useState<FeatureFlagSummary[]>([]);
  const [labs, setLabs] = useState<LabDefinition[]>([]);
  const [audiences, setAudiences] = useState<AudienceDefinition[]>([]);
  const [selectedKey, setSelectedKey] = useState("");
  const [selectedLabKey, setSelectedLabKey] = useState("");
  const [detail, setDetail] = useState<FeatureFlagDetail | null>(null);
  const [configVersion, setConfigVersion] = useState<number | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [targetRuleId, setTargetRuleId] = useState("");
  const [serverSlug, setServerSlug] = useState("");
  const [serverSearch, setServerSearch] = useState("");
  const [serverOptions, setServerOptions] = useState<ServerOption[]>([]);
  const [serverOptionsLoading, setServerOptionsLoading] = useState(false);
  const [serverOptionsError, setServerOptionsError] = useState<string | null>(null);
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const selected = detail?.flag ?? flags.find((flag) => flag.key === selectedKey) ?? null;
  const selectedLab = labs.find((lab) => lab.labKey === selectedLabKey) ?? null;
  const targetAllowlist = detail?.serverAllowlistRules.find((rule) => rule.ruleId === targetRuleId) ?? null;

  function recordEnvelope(envelope: Pick<ApiEnvelope<unknown>, "configVersion" | "requestId">) {
    if (envelope.configVersion !== undefined) setConfigVersion(envelope.configVersion);
    if (envelope.requestId !== undefined) setRequestId(envelope.requestId);
  }

  async function loadFlags() {
    const response = await apiFetch<ApiEnvelope<{ flags: FeatureFlagSummary[] }>>("/api/operator/feature-flags");
    setFlags(response.data.flags);
    setSelectedKey((current) => current || response.data.flags[0]?.key || "");
    if (response.data.flags.length === 0) setDetail(null);
    recordEnvelope(response);
  }

  async function loadLabs() {
    const response = await apiFetch<ApiEnvelope<{ labs: LabDefinition[] }>>(LAB_OPERATOR_ENDPOINTS.catalog);
    setLabs(response.data.labs);
    setSelectedLabKey((current) => current && response.data.labs.some((lab) => lab.labKey === current)
      ? current
      : response.data.labs[0]?.labKey || "");
    recordEnvelope(response);
  }

  async function loadAudiences() {
    const response = await apiFetch<ApiEnvelope<{ audiences: AudienceDefinition[] }>>("/api/operator/audiences");
    setAudiences(response.data.audiences);
    recordEnvelope(response);
  }

  async function loadAll() {
    setLoading(true);
    setActionMessage(null);
    try {
      await Promise.all([loadFlags(), loadLabs(), loadAudiences()]);
    } catch (error) {
      setActionMessage({ tone: "pending", text: error instanceof Error ? error.message : "Operator API pending" });
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(key: string) {
    if (!key) return;
    setLoadingDetail(true);
    setTargetRuleId("");
    try {
      const response = await apiFetch<ApiEnvelope<FeatureFlagDetail>>(`/api/operator/feature-flags/${encodeURIComponent(key)}`);
      const nextDetail = normalizeDetail(response.data);
      setDetail(nextDetail);
      setTargetRuleId(defaultTargetRuleId(key, nextDetail));
      recordEnvelope(response);
    } catch (error) {
      setDetail(null);
      setActionMessage({ tone: "error", text: error instanceof Error ? error.message : "Flag detail failed" });
    } finally {
      setLoadingDetail(false);
    }
  }

  useEffect(() => { void loadAll(); }, []);
  useEffect(() => { void loadDetail(selectedKey); }, [selectedKey]);
  useEffect(() => {
    const onPopState = () => setSurface(surfaceForPath(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  function navigateSurface(next: Surface) {
    if (surface === next) return;
    window.history.pushState({}, "", SURFACE_PATH[next]);
    setSurface(next);
  }
  useEffect(() => {
    if (surface !== "flags" && surface !== "audiences") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setServerOptionsLoading(true);
      setServerOptionsError(null);
      void apiFetch<ApiEnvelope<{ servers: ServerOption[] }>>(serverCatalogPath(serverSearch))
        .then((response) => {
          if (!cancelled) setServerOptions(response.data.servers);
        })
        .catch((error) => {
          if (!cancelled) {
            setServerOptions([]);
            setServerOptionsError(error instanceof Error ? error.message : "Server search failed");
          }
        })
        .finally(() => {
          if (!cancelled) setServerOptionsLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [surface, serverSearch]);

  async function runMutation<T>(action: string, operation: () => Promise<ApiEnvelope<T>>, success: string) {
    setBusyAction(action);
    setActionMessage(null);
    try {
      const response = await operation();
      recordEnvelope(response);
      setActionMessage({ tone: "ok", text: success });
      return response;
    } catch (error) {
      setActionMessage({ tone: "error", text: error instanceof Error ? error.message : "Mutation failed" });
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  async function mutateServerAllowlist(operation: "add" | "remove" | "create", targetServerSlug: string) {
    if (!selected?.key || !targetServerSlug.trim()) return;
    const encodedKey = encodeURIComponent(selected.key);
    const trimmedServerSlug = targetServerSlug.trim();
    const path = operation === "create"
      ? `/api/operator/feature-flags/${encodedKey}/server-allowlist/rules`
      : operation === "add"
        ? `/api/operator/feature-flags/${encodedKey}/server-allowlist`
        : `/api/operator/feature-flags/${encodedKey}/server-allowlist/${encodeURIComponent(trimmedServerSlug)}`;
    const response = await runMutation(operation, () => apiFetch<ApiEnvelope<(FeatureFlagDetail & { ruleId?: string }) | { detail?: FeatureFlagDetail; ruleId?: string }>>(path, {
      method: operation === "remove" ? "DELETE" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(operation === "create" ? {
          serverSlugs: [trimmedServerSlug],
          reason: reason.trim(),
          expectedConfigVersion: configVersion,
        } : operation === "add" ? serverAllowlistBody(trimmedServerSlug, targetRuleId, reason, configVersion) : {
          targetRuleId,
          reason: reason.trim(),
          expectedConfigVersion: configVersion,
        }),
      }),
    }), operation === "create" ? "Server allowlist rule created." : operation === "add" ? "Server allowlist added." : "Server allowlist removed.");
    if (!response) return;
    const nextDetail = normalizeDetail(response.data);
    const createdRuleId = "ruleId" in response.data && typeof response.data.ruleId === "string"
      ? response.data.ruleId
      : null;
    setDetail(nextDetail);
    setTargetRuleId((current) => {
      if (createdRuleId && nextDetail.serverAllowlistRules.some((rule) => rule.ruleId === createdRuleId)) return createdRuleId;
      return nextDetail.serverAllowlistRules.some((rule) => rule.ruleId === current)
        ? current
        : defaultTargetRuleId(selected.key, nextDetail);
    });
  }

  async function previewEvaluation() {
    if (!selected?.key) return;
    const response = await runMutation("preview", () => apiFetch<ApiEnvelope<{ evaluation: { enabled: boolean; reason: string } }>>(
      `/api/operator/feature-flags/${encodeURIComponent(selected.key)}/evaluate-preview`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(previewBody(serverSlug, userId)) },
    ), "Preview complete.");
    if (response) {
      setActionMessage({ tone: "ok", text: `Preview: ${response.data.evaluation.enabled ? "enabled" : "disabled"} (${response.data.evaluation.reason})` });
    }
  }

  async function setFallback(defaultEnabled: boolean) {
    if (!selected?.key) return;
    const response = await runMutation("fallback", () => apiFetch<ApiEnvelope<FeatureFlagDetail | { detail?: FeatureFlagDetail }>>(
      `/api/operator/feature-flags/${encodeURIComponent(selected.key)}/default-enabled`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultEnabled, reason: reason.trim(), expectedConfigVersion: configVersion }),
      },
    ), `Fallback set to ${fallbackLabel(defaultEnabled)}.`);
    if (response) setDetail(normalizeDetail(response.data));
  }

  async function createLabRule(input: { labKey: string; decision: "allow" | "deny"; priority: number }) {
    if (!selected?.key) return;
    const response = await runMutation("lab-rule-create", () => apiFetch<ApiEnvelope<FeatureFlagDetail | { detail?: FeatureFlagDetail }>>(
      LAB_OPERATOR_ENDPOINTS.rules(selected.key),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labKeys: [input.labKey], decision: input.decision, priority: input.priority, reason: reason.trim(), expectedConfigVersion: configVersion }),
      },
    ), "Lab target rule created.");
    if (response) setDetail(normalizeDetail(response.data));
  }

  async function removeLabRule(ruleId: string) {
    if (!selected?.key) return;
    const response = await runMutation("lab-rule-remove", () => apiFetch<ApiEnvelope<FeatureFlagDetail | { detail?: FeatureFlagDetail }>>(
      LAB_OPERATOR_ENDPOINTS.rule(selected.key, ruleId),
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim(), expectedConfigVersion: configVersion }),
      },
    ), "Lab target rule removed.");
    if (response) setDetail(normalizeDetail(response.data));
  }

  async function createLab(input: { labKey: string; name: string; description: string }) {
    if (configVersion === null) return false;
    const response = await runMutation("lab-create", () => apiFetch<ApiEnvelope<{ labs: LabDefinition[] } | LabDefinition>>(
      LAB_OPERATOR_ENDPOINTS.catalog,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createLabMutationBody(input, reason, configVersion)),
      },
    ), "Draft Lab created.");
    if (!response) return false;
    const nextLabs = labsFrom(response.data, labs);
    if (nextLabs === labs) await loadLabs(); else setLabs(nextLabs);
    setSelectedLabKey(input.labKey);
    return true;
  }

  async function updateLab(input: { name: string; description: string }) {
    if (!selectedLab) return false;
    const response = await runMutation("lab-update", () => apiFetch<ApiEnvelope<{ labs: LabDefinition[] } | LabDefinition>>(
      LAB_OPERATOR_ENDPOINTS.definition(selectedLab.labKey),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, reason: reason.trim(), expectedConfigVersion: configVersion }),
      },
    ), "Lab details updated.");
    if (!response) return false;
    const nextLabs = labsFrom(response.data, labs);
    if (nextLabs === labs) await loadLabs(); else setLabs(nextLabs);
    return true;
  }

  async function transitionLab(state: LabState) {
    if (!selectedLab) return;
    const response = await runMutation(`lab-state-${state}`, () => apiFetch<ApiEnvelope<{ labs: LabDefinition[] } | LabDefinition>>(
      LAB_OPERATOR_ENDPOINTS.lifecycle(selectedLab.labKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, reason: reason.trim(), expectedConfigVersion: configVersion }),
      },
    ), `Lab is now ${state}.`);
    if (!response) return;
    const nextLabs = labsFrom(response.data, labs);
    if (nextLabs === labs) await loadLabs(); else setLabs(nextLabs);
  }

  async function createAudience(input: {
    audienceKey: string;
    name: string;
    description: string;
    enabled: boolean;
    userIds: string[];
    serverSlugs: string[];
  }) {
    if (configVersion === null) return false;
    const response = await runMutation("audience-create", () => apiFetch<ApiEnvelope<{ audience: AudienceDefinition }>>(
      "/api/operator/audiences",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, reason: reason.trim(), expectedConfigVersion: configVersion }),
      },
    ), "Audience created.");
    if (!response) return false;
    await loadAudiences();
    return true;
  }

  async function updateAudience(input: {
    audienceKey: string;
    name: string;
    description: string;
    enabled: boolean;
    userIds: string[];
    serverSlugs: string[];
    retainedMemberIds: string[];
  }) {
    if (configVersion === null) return false;
    const response = await runMutation("audience-update", () => apiFetch<ApiEnvelope<{ audience: AudienceDefinition }>>(
      `/api/operator/audiences/${encodeURIComponent(input.audienceKey)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, reason: reason.trim(), expectedConfigVersion: configVersion }),
      },
    ), "Audience updated.");
    if (!response) return false;
    await Promise.all([loadAudiences(), loadDetail(selectedKey)]);
    return true;
  }

  async function createAudienceRule(input: { audienceKey: string; decision: "allow" | "deny"; priority: number }) {
    if (!selected?.key) return;
    const response = await runMutation("audience-rule-create", () => apiFetch<ApiEnvelope<FeatureFlagDetail>>(
      `/api/operator/feature-flags/${encodeURIComponent(selected.key)}/rules`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          stage: "audience",
          decision: input.decision,
          priority: input.priority,
          values: [input.audienceKey],
          percentageBasisPoints: null,
          variant: null,
          reason: reason.trim(),
          expectedConfigVersion: configVersion,
        }),
      },
    ), "Audience target rule created.");
    if (!response) return;
    setDetail(normalizeDetail(response.data));
    await loadAudiences();
  }

  async function removeAudienceRule(ruleId: string) {
    if (!selected?.key) return;
    const response = await runMutation("audience-rule-remove", () => apiFetch<ApiEnvelope<never>>(
      `/api/operator/feature-flags/${encodeURIComponent(selected.key)}/rules/${encodeURIComponent(ruleId)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim(), expectedConfigVersion: configVersion }),
      },
    ), "Audience target rule removed.");
    if (!response) return;
    await Promise.all([loadDetail(selected.key), loadAudiences()]);
  }

  return (
    <main className="min-h-screen bg-brutal-cream">
      <header className="border-b-2 border-black bg-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex size-11 items-center justify-center border-2 border-black bg-brutal-yellow shadow-brutal-sm"><Flag size={22} /></div>
            <div><h1 className="text-xl font-black">Feature Flag Admin</h1><div className="text-xs font-bold text-black/55">{configVersion === null ? "Version pending" : `Config v${configVersion}`}</div></div>
          </div>
          <div className="flex w-full min-w-0 flex-wrap items-center gap-2 xl:w-auto">
            <div className="grid w-full min-w-0 grid-cols-2 border-2 border-black bg-brutal-cream p-1 shadow-brutal-sm sm:flex sm:w-auto">
              <SurfaceButton active={surface === "flags"} onClick={() => navigateSurface("flags")}><Flag size={15} /> Flags</SurfaceButton>
              <SurfaceButton active={surface === "audiences"} onClick={() => navigateSurface("audiences")}><Users size={15} /> Audiences</SurfaceButton>
              <SurfaceButton active={surface === "labs"} onClick={() => navigateSurface("labs")}><FlaskConical size={15} /> Lab catalog</SurfaceButton>
              <SurfaceButton active={surface === "announcements"} onClick={() => navigateSurface("announcements")}><Megaphone size={15} /> Announcements</SurfaceButton>
            </div>
            <button className="btn-brutal-sm bg-white px-3 py-2 text-xs" onClick={loadAll} disabled={loading}>{loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} Refresh</button>
            <div className="hidden border-2 border-black bg-brutal-lime px-3 py-2 text-xs font-bold shadow-brutal-sm md:block">{principal.type}: {labelFor(principal)}</div>
            <button className="btn-brutal-sm bg-white px-3 py-2 text-xs" onClick={onLogout}><LogOut size={16} /> Logout</button>
          </div>
        </div>
      </header>

      {surface === "announcements" ? (
        <AnnouncementsSurface />
      ) : surface === "audiences" ? (
        <AudiencesSurface
          audiences={audiences}
          serverOptions={serverOptions}
          serverSearch={serverSearch}
          onServerSearch={setServerSearch}
          serverOptionsLoading={serverOptionsLoading}
          serverOptionsError={serverOptionsError}
          reason={reason}
          onReason={setReason}
          busyAction={busyAction}
          configVersion={configVersion}
          onCreate={createAudience}
          onUpdate={updateAudience}
        />
      ) : surface === "flags" ? (
        <FlagsSurface
          flags={flags}
          selectedKey={selectedKey}
          onSelect={setSelectedKey}
          selected={selected}
          detail={detail}
          configVersion={configVersion}
          labs={labs}
          audiences={audiences}
          loading={loading}
          loadingDetail={loadingDetail}
          targetAllowlist={targetAllowlist}
          targetRuleId={targetRuleId}
          onTargetRuleId={setTargetRuleId}
          serverSlug={serverSlug}
          onServerSlug={setServerSlug}
          userId={userId}
          onUserId={setUserId}
          reason={reason}
          onReason={setReason}
          busyAction={busyAction}
          onAllowlist={mutateServerAllowlist}
          onPreview={previewEvaluation}
          onFallback={setFallback}
          onCreateLabRule={createLabRule}
          onRemoveLabRule={removeLabRule}
          onCreateAudienceRule={createAudienceRule}
          onRemoveAudienceRule={removeAudienceRule}
        />
      ) : (
        <LabsSurface
          labs={labs}
          selectedLab={selectedLab}
          selectedLabKey={selectedLabKey}
          onSelect={setSelectedLabKey}
          reason={reason}
          onReason={setReason}
          busyAction={busyAction}
          configVersion={configVersion}
          onCreate={createLab}
          onUpdate={updateLab}
          onTransition={transitionLab}
        />
      )}

      <div className="fixed bottom-4 left-1/2 z-20 w-[min(560px,calc(100%-2rem))] -translate-x-1/2">
        {actionMessage ? <div className={`border-2 border-black px-4 py-3 text-sm font-bold shadow-brutal ${actionMessage.tone === "ok" ? "bg-brutal-lime" : actionMessage.tone === "error" ? "bg-brutal-red" : "bg-brutal-yellow"}`}>{actionMessage.text}{requestId ? <div className="mt-1 break-all font-mono text-[10px] opacity-55">{requestId}</div> : null}</div> : null}
      </div>
    </main>
  );
}

type FlagsSurfaceProps = {
  flags: FeatureFlagSummary[];
  selectedKey: string;
  onSelect: (key: string) => void;
  selected: FeatureFlagSummary | null;
  detail: FeatureFlagDetail | null;
  configVersion: number | null;
  labs: LabDefinition[];
  audiences: AudienceDefinition[];
  loading: boolean;
  loadingDetail: boolean;
  targetAllowlist: ServerAllowlistRule | null;
  targetRuleId: string;
  onTargetRuleId: (value: string) => void;
  serverSlug: string;
  onServerSlug: (value: string) => void;
  userId: string;
  onUserId: (value: string) => void;
  reason: string;
  onReason: (value: string) => void;
  busyAction: string | null;
  onAllowlist: (operation: "add" | "remove" | "create", serverSlug: string) => Promise<void>;
  onPreview: () => Promise<void>;
  onFallback: (enabled: boolean) => Promise<void>;
  onCreateLabRule: (input: { labKey: string; decision: "allow" | "deny"; priority: number }) => Promise<void>;
  onRemoveLabRule: (ruleId: string) => Promise<void>;
  onCreateAudienceRule: (input: { audienceKey: string; decision: "allow" | "deny"; priority: number }) => Promise<void>;
  onRemoveAudienceRule: (ruleId: string) => Promise<void>;
};

function FlagsSurface(props: FlagsSurfaceProps) {
  const { flags, selectedKey, onSelect, selected, detail, configVersion, labs, audiences, loading, loadingDetail, targetAllowlist, targetRuleId, onTargetRuleId, serverSlug, onServerSlug, userId, onUserId, reason, onReason, busyAction, onAllowlist, onPreview, onFallback, onCreateLabRule, onRemoveLabRule, onCreateAudienceRule, onRemoveAudienceRule } = props;
  const canMutateServer = !!selected?.key && !!targetAllowlist && !!serverSlug.trim()
    && auditReasonValid(reason) && configVersion !== null && busyAction === null;
  return (
    <div className="mx-auto grid max-w-[1440px] gap-5 px-4 py-5 lg:grid-cols-[300px_minmax(0,1fr)_360px]">
      <section className="border-2 border-black bg-white shadow-brutal">
        <div className="border-b-2 border-black bg-brutal-yellow px-4 py-3"><h2 className="text-sm font-black uppercase">Flags</h2></div>
        <div className="divide-y-2 divide-black">
          {loading ? <LoadingRow /> : flags.length === 0 ? <EmptyRow>No flags loaded.</EmptyRow> : flags.map((flag) => (
            <button key={flag.key} type="button" onClick={() => onSelect(flag.key)} className={`grid w-full gap-2 px-4 py-4 text-left ${selectedKey === flag.key ? "bg-brutal-lavender" : "bg-white"}`}>
              <div className="break-all text-sm font-black">{flag.key}</div>
              <div className="text-xs font-semibold text-black/60">{flag.description || "No description"}</div>
              <div className="flex flex-wrap gap-1"><StatusBadge tone={flag.enabled && !flag.killSwitch ? "ok" : "error"}>{flag.killSwitch ? "kill" : flag.enabled ? "enabled" : "disabled"}</StatusBadge>{flag.highRisk ? <StatusBadge tone="error">high risk</StatusBadge> : null}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="min-w-0 space-y-5">
        <div className="border-2 border-black bg-white p-5 shadow-brutal">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div><div className="text-xs font-black uppercase text-black/50">Selected flag</div><h2 className="break-all text-2xl font-black">{selected?.key ?? "-"}</h2></div>
            {loadingDetail ? <Loader2 size={20} className="animate-spin" /> : selected?.highRisk ? <span className="inline-flex items-center gap-1 border-2 border-black bg-brutal-red px-2 py-1 text-xs font-black shadow-brutal-sm"><AlertTriangle size={14} /> High risk</span> : null}
          </div>
          <div className="grid gap-3 md:grid-cols-4"><Metric label="Enabled" value={selected?.enabled ? "true" : "false"} /><Metric label="Kill switch" value={selected?.killSwitch ? "on" : "off"} /><Metric label="Fallback" value={selected ? fallbackLabel(selected.defaultEnabled) : "-"} /><Metric label="Randomization" value={selected?.randomizationUnit ?? "-"} /></div>
        </div>

        <EvaluationPath detail={detail} labs={labs} audiences={audiences} reason={reason} busyAction={busyAction} onFallback={onFallback} onRemoveLabRule={onRemoveLabRule} onRemoveAudienceRule={onRemoveAudienceRule} />

        <div className="border-2 border-black bg-white p-5 shadow-brutal">
          <div className="mb-4 flex items-center gap-2"><Server size={20} /><h2 className="text-lg font-black">Selected server allowlist</h2>{targetAllowlist ? <StatusBadge tone="neutral">{`priority ${targetAllowlist.priority}`}</StatusBadge> : null}</div>
          <div className="grid gap-2">
            {targetAllowlist?.serverTargets.length ? targetAllowlist.serverTargets.map((target, index) => {
              const removable = target.status === "active" && !!target.serverSlug;
              return (
                <div key={`${target.serverSlug ?? "unknown"}-${index}`} className="flex items-center justify-between gap-3 border-2 border-black bg-brutal-cream px-3 py-2 shadow-brutal-sm">
                  <span className="min-w-0 break-all font-mono text-xs font-bold">{serverDisplayLabel(target)}</span>
                  {removable ? <button className="btn-brutal-sm shrink-0 bg-brutal-red px-2 py-1 text-[11px]" disabled={!auditReasonValid(reason) || busyAction !== null} onClick={() => void onAllowlist("remove", target.serverSlug!)}><Trash2 size={14} /> Remove</button> : <StatusBadge tone="error">not removable by slug</StatusBadge>}
                </div>
              );
            }) : targetAllowlist ? <EmptyRow>Empty</EmptyRow> : <EmptyRow>Select an exact target rule before editing.</EmptyRow>}
          </div>
        </div>
      </section>

      <aside className="space-y-5">
        <AudienceRuleEditor audiences={audiences} reason={reason} busyAction={busyAction} selectedKey={selected?.key ?? ""} onCreate={onCreateAudienceRule} />
        <LabRuleEditor labs={labs} reason={reason} busyAction={busyAction} selectedKey={selected?.key ?? ""} onCreate={onCreateLabRule} />
        <div className="border-2 border-black bg-white p-4 shadow-brutal">
          <div className="mb-3 flex items-center gap-2"><Server size={18} /><h2 className="text-sm font-black uppercase">Allowlist edit</h2></div>
          <Field label="Target rule"><select value={targetRuleId} onChange={(event) => onTargetRuleId(event.target.value)} className="control"><option value="">Select exact rule</option>{detail?.serverAllowlistRules.map((rule) => <option key={rule.ruleId} value={rule.ruleId}>{`priority ${rule.priority} · ${rule.ruleId}`}</option>)}</select></Field>
          <Field label="Server slug"><input value={serverSlug} onChange={(event) => onServerSlug(event.target.value)} className="control" /></Field>
          <button className="btn-brutal-sm mt-4 w-full bg-brutal-lime px-3 py-2 text-xs" disabled={!canMutateServer} onClick={() => void onAllowlist("add", serverSlug)}>{busyAction === "add" ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Add server</button>
        </div>
        <div className="border-2 border-black bg-white p-4 shadow-brutal">
          <div className="mb-3 flex items-center gap-2"><Eye size={18} /><h2 className="text-sm font-black uppercase">Evaluation preview</h2></div>
          <Field label="Server slug"><input value={serverSlug} onChange={(event) => onServerSlug(event.target.value)} className="control" /></Field>
          <Field label="User / agent id"><input value={userId} onChange={(event) => onUserId(event.target.value)} className="control" /></Field>
          <button className="btn-brutal-sm mt-4 w-full bg-brutal-cyan px-3 py-2 text-xs" onClick={() => void onPreview()} disabled={!selected?.key || busyAction !== null}>{busyAction === "preview" ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} Preview</button>
        </div>
        <div className="border-2 border-black bg-white p-4 shadow-brutal"><Field label="Audit reason for every change"><textarea value={reason} onChange={(event) => onReason(event.target.value)} rows={4} className="control h-auto resize-none py-2" placeholder="Why is this rollout changing?" /></Field><div className="mt-2 text-[11px] font-semibold text-black/50">Mutations require the current config version and return authoritative readback.</div></div>
      </aside>
    </div>
  );
}

export function ServerTargetPicker({
  options,
  selectedTargets,
  search,
  onSearch,
  loading,
  error,
  disabled,
  onToggle,
  createsFirstRule,
  mode = "rule",
}: {
  options: ServerOption[];
  selectedTargets: ServerTarget[];
  search: string;
  onSearch: (value: string) => void;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  onToggle: (serverSlug: string, selectedNow: boolean) => void;
  createsFirstRule: boolean;
  mode?: "rule" | "selection";
}) {
  return (
    <div className="mt-3 grid gap-2">
      <Field label="Find active server by slug">
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
          className="control"
          placeholder="Search server slug"
          maxLength={64}
        />
      </Field>
      <div className="text-[11px] font-semibold text-black/50">Choose exact active servers. Deleted or ambiguous slugs are not listed.</div>
      <div className="max-h-64 overflow-y-auto border-2 border-black bg-brutal-cream">
        {loading ? <LoadingRow /> : error ? <div className="px-3 py-3 text-xs font-bold text-brutal-red">{error}</div> : options.length === 0 ? <div className="px-3 py-3 text-xs font-bold text-black/55">No active servers match.</div> : options.map((option) => {
          const selectedNow = serverTargetIsSelected(selectedTargets, option.serverSlug);
          return (
            <label key={option.serverSlug} className="flex cursor-pointer items-center gap-2 border-b-2 border-black px-3 py-2 last:border-b-0">
              <input
                type="checkbox"
                checked={selectedNow}
                disabled={disabled}
                onChange={() => onToggle(option.serverSlug, selectedNow)}
                className="size-4 accent-black"
              />
              <span className="min-w-0 break-all font-mono text-xs font-bold">{option.serverSlug}</span>
            </label>
          );
        })}
      </div>
      <div className="text-[11px] font-semibold text-black/50">{mode === "selection" ? "Selections remain local until you save the audience." : createsFirstRule ? "The first selection creates a priority-0 server allow rule." : "Checking or unchecking applies one audited change with the current config version."}</div>
    </div>
  );
}

export function EvaluationPath({ detail, labs, audiences, reason, busyAction, onFallback, onRemoveLabRule, onRemoveAudienceRule }: { detail: FeatureFlagDetail | null; labs: LabDefinition[]; audiences: AudienceDefinition[]; reason: string; busyAction: string | null; onFallback: (enabled: boolean) => Promise<void>; onRemoveLabRule: (ruleId: string) => Promise<void>; onRemoveAudienceRule: (ruleId: string) => Promise<void> }) {
  const rules = detail ? orderedRules(detail.rules) : [];
  return (
    <div className="border-2 border-black bg-white p-5 shadow-brutal">
      <div className="mb-1 flex items-center gap-2"><GitBranch size={20} /><h2 className="text-lg font-black">Evaluation path</h2></div>
      <p className="mb-4 text-xs font-semibold text-black/55">Fixed stage order. Within a stage, lower priority runs first. The first matching allow or deny stops evaluation.</p>
      <div className="grid gap-2">
        {rules.map((rule, index) => {
          const values = rule.values ?? [];
          const labNames = rule.stage === "lab" ? values.map((key) => labs.find((lab) => lab.labKey === key)?.name ?? key) : [];
          const audienceNames = rule.stage === "audience" ? values.map((key) => audiences.find((audience) => audience.audienceKey === key)?.name ?? key) : [];
          return <div key={rule.id} className="relative border-2 border-black bg-brutal-cream p-3 shadow-brutal-sm">
            <div className="flex flex-wrap items-center gap-2"><span className="flex size-6 items-center justify-center border-2 border-black bg-white text-xs font-black">{index + 1}</span><StatusBadge tone="neutral">{rule.stage}</StatusBadge><StatusBadge tone={rule.decision === "allow" ? "ok" : "error"}>{rule.decision}</StatusBadge><span className="text-xs font-black">priority {rule.priority}</span>{labRuleCanBeRemoved(rule) ? <button className="ml-auto inline-flex items-center gap-1 text-[11px] font-black underline disabled:opacity-40" disabled={!auditReasonValid(reason) || busyAction !== null} onClick={() => void onRemoveLabRule(rule.id)}><X size={13} /> Remove</button> : rule.stage === "audience" ? <button className="ml-auto inline-flex items-center gap-1 text-[11px] font-black underline disabled:opacity-40" disabled={!auditReasonValid(reason) || busyAction !== null} onClick={() => void onRemoveAudienceRule(rule.id)}><X size={13} /> Remove</button> : null}</div>
            <div className="mt-2 font-mono text-xs font-bold text-black/65">
              {rule.stage === "server"
                ? (rule.serverTargets ?? []).map(serverDisplayLabel).join(", ") || "-"
                : audienceNames.length
                  ? audienceNames.join(", ")
                  : labNames.length
                  ? labNames.join(", ")
                  : ruleTargetLabel({ ...rule, values })}
            </div>
            <ArrowDown size={16} className="absolute -bottom-5 left-5 z-10" />
          </div>;
        })}
        <div className="border-2 border-black bg-brutal-yellow p-3 shadow-brutal-sm">
          <div className="flex flex-wrap items-center gap-2"><span className="flex size-6 items-center justify-center border-2 border-black bg-white text-xs font-black">{rules.length + 1}</span><span className="text-xs font-black uppercase">Fallback</span><StatusBadge tone={detail?.flag.defaultEnabled ? "ok" : "error"}>{detail ? fallbackLabel(detail.flag.defaultEnabled) : "-"}</StatusBadge></div>
          <div className="mt-2 text-xs font-semibold text-black/65">Used only when no rule above matches. This is the current <span className="font-black">defaultEnabled</span> value, presented as operator language.</div>
          <div className="mt-3 flex gap-2"><button className="btn-brutal-sm bg-brutal-lime px-3 py-1.5 text-xs" disabled={!detail || !auditReasonValid(reason) || busyAction !== null || detail.flag.defaultEnabled} onClick={() => void onFallback(true)}>Set On</button><button className="btn-brutal-sm bg-brutal-red px-3 py-1.5 text-xs" disabled={!detail || !auditReasonValid(reason) || busyAction !== null || !detail.flag.defaultEnabled} onClick={() => void onFallback(false)}>Set Off</button></div>
        </div>
      </div>
    </div>
  );
}

function LabRuleEditor({ labs, reason, busyAction, selectedKey, onCreate }: { labs: LabDefinition[]; reason: string; busyAction: string | null; selectedKey: string; onCreate: (input: { labKey: string; decision: "allow" | "deny"; priority: number }) => Promise<void> }) {
  const options = selectableLabs(labs);
  const [labKey, setLabKey] = useState("");
  const [decision, setDecision] = useState<"allow" | "deny">("allow");
  const [priority, setPriority] = useState(0);
  useEffect(() => { if (!options.some((lab) => lab.labKey === labKey)) setLabKey(options[0]?.labKey ?? ""); }, [labs, labKey]);
  return (
    <div className="border-2 border-black bg-white p-4 shadow-brutal">
      <div className="mb-1 flex items-center gap-2"><FlaskConical size={18} /><h2 className="text-sm font-black uppercase">Add Lab target</h2></div>
      <p className="mb-3 text-[11px] font-semibold text-black/50">Only open Labs can be newly targeted. Paused or retired entries remain visible in existing rule history.</p>
      <Field label="Lab"><select className="control" value={labKey} onChange={(event) => setLabKey(event.target.value)}><option value="">No open Labs</option>{options.map((lab) => <option key={lab.labKey} value={lab.labKey}>{lab.name} · {lab.labKey}</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-2"><Field label="Decision"><select className="control" value={decision} onChange={(event) => setDecision(event.target.value as "allow" | "deny")}><option value="allow">Allow</option><option value="deny">Deny</option></select></Field><Field label="Priority"><input className="control" type="number" value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></Field></div>
      <button className="btn-brutal-sm mt-4 w-full bg-brutal-pink px-3 py-2 text-xs" disabled={!selectedKey || !labKey || !Number.isSafeInteger(priority) || !auditReasonValid(reason) || busyAction !== null} onClick={() => void onCreate({ labKey, decision, priority })}>{busyAction === "lab-rule-create" ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Add target rule</button>
    </div>
  );
}

function AudienceRuleEditor({ audiences, reason, busyAction, selectedKey, onCreate }: { audiences: AudienceDefinition[]; reason: string; busyAction: string | null; selectedKey: string; onCreate: (input: { audienceKey: string; decision: "allow" | "deny"; priority: number }) => Promise<void> }) {
  const options = audiences.filter((audience) => audience.enabled && audience.members.length > 0);
  const [audienceKey, setAudienceKey] = useState("");
  const [decision, setDecision] = useState<"allow" | "deny">("allow");
  const [priority, setPriority] = useState(0);
  useEffect(() => {
    if (!options.some((audience) => audience.audienceKey === audienceKey)) setAudienceKey(options[0]?.audienceKey ?? "");
  }, [audiences, audienceKey]);
  return (
    <div className="border-2 border-black bg-white p-4 shadow-brutal">
      <div className="mb-1 flex items-center gap-2"><Users size={18} /><h2 className="text-sm font-black uppercase">Add audience target</h2></div>
      <p className="mb-3 text-[11px] font-semibold text-black/50">Only enabled, non-empty audiences can be referenced. Membership is user OR server.</p>
      <Field label="Audience"><select className="control" value={audienceKey} onChange={(event) => setAudienceKey(event.target.value)}><option value="">No enabled audiences</option>{options.map((audience) => <option key={audience.audienceKey} value={audience.audienceKey}>{audience.name} · {audience.audienceKey}</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-2"><Field label="Decision"><select className="control" value={decision} onChange={(event) => setDecision(event.target.value as "allow" | "deny")}><option value="allow">Allow</option><option value="deny">Deny</option></select></Field><Field label="Priority"><input className="control" type="number" value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></Field></div>
      <button className="btn-brutal-sm mt-4 w-full bg-brutal-cyan px-3 py-2 text-xs" disabled={!selectedKey || !audienceKey || !Number.isSafeInteger(priority) || !auditReasonValid(reason) || busyAction !== null} onClick={() => void onCreate({ audienceKey, decision, priority })}>{busyAction === "audience-rule-create" ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Add audience rule</button>
    </div>
  );
}

export function AudiencesSurface({ audiences, serverOptions, serverSearch, onServerSearch, serverOptionsLoading, serverOptionsError, reason, onReason, busyAction, configVersion, onCreate, onUpdate }: {
  audiences: AudienceDefinition[];
  serverOptions: ServerOption[];
  serverSearch: string;
  onServerSearch: (value: string) => void;
  serverOptionsLoading: boolean;
  serverOptionsError: string | null;
  reason: string;
  onReason: (value: string) => void;
  busyAction: string | null;
  configVersion: number | null;
  onCreate: (input: { audienceKey: string; name: string; description: string; enabled: boolean; userIds: string[]; serverSlugs: string[] }) => Promise<boolean>;
  onUpdate: (input: { audienceKey: string; name: string; description: string; enabled: boolean; userIds: string[]; serverSlugs: string[]; retainedMemberIds: string[] }) => Promise<boolean>;
}) {
  const [selectedKey, setSelectedKey] = useState("");
  const selected = audiences.find((audience) => audience.audienceKey === selectedKey) ?? audiences[0] ?? null;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [userIdsText, setUserIdsText] = useState("");
  const [serverSlugs, setServerSlugs] = useState<string[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");

  useEffect(() => {
    if (selected && selected.audienceKey !== selectedKey) setSelectedKey(selected.audienceKey);
  }, [selected?.audienceKey, selectedKey]);
  useEffect(() => {
    setName(selected?.name ?? "");
    setDescription(selected?.description ?? "");
    setEnabled(selected?.enabled ?? false);
    setUserIdsText((selected?.members ?? []).filter((member) => member.kind === "user" && member.status === "active").map((member) => member.userId).filter(Boolean).join("\n"));
    setServerSlugs((selected?.members ?? []).filter((member) => member.kind === "server" && member.status === "active").map((member) => member.serverSlug).filter((slug): slug is string => Boolean(slug)));
  }, [selected?.audienceKey, selected?.updatedAt]);

  const parsedUserIds = parseUserIdLines(userIdsText);
  const invalidUserId = parsedUserIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
  const retainedMemberIds = (selected?.members ?? []).filter((member) => member.status === "unknown_or_deleted").map((member) => member.memberId);
  const selectedTargets: ServerTarget[] = serverSlugs.map((serverSlug) => ({ serverSlug, status: "active" }));
  const memberCount = parsedUserIds.length + serverSlugs.length + retainedMemberIds.length;

  return (
    <div className="mx-auto grid max-w-[1440px] gap-5 px-4 py-5 lg:grid-cols-[300px_minmax(0,1fr)_360px]">
      <section className="border-2 border-black bg-white shadow-brutal">
        <div className="border-b-2 border-black bg-brutal-cyan px-4 py-3"><h2 className="text-sm font-black uppercase">Named audiences</h2></div>
        <div className="divide-y-2 divide-black">{audiences.length ? audiences.map((audience) => <button key={audience.audienceKey} type="button" onClick={() => setSelectedKey(audience.audienceKey)} className={`grid w-full gap-2 px-4 py-4 text-left ${selected?.audienceKey === audience.audienceKey ? "bg-brutal-lavender" : "bg-white"}`}><div className="text-sm font-black">{audience.name}</div><div className="break-all font-mono text-[11px] font-bold text-black/50">{audience.audienceKey}</div><div className="flex gap-1"><StatusBadge tone={audience.enabled ? "ok" : "neutral"}>{audience.enabled ? "enabled" : "draft"}</StatusBadge><StatusBadge tone="neutral">{`${audience.members.length} members`}</StatusBadge></div></button>) : <EmptyRow>No audiences yet.</EmptyRow>}</div>
      </section>

      <section className="space-y-5">
        <div className="border-2 border-black bg-white p-5 shadow-brutal">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-black uppercase text-black/50">Reusable audience</div><h2 className="text-3xl font-black">{selected?.name ?? "Select an audience"}</h2><div className="mt-1 font-mono text-xs font-bold text-black/50">{selected?.audienceKey ?? "-"}</div></div>{selected ? <StatusBadge tone={selected.enabled ? "ok" : "neutral"}>{selected.enabled ? "enabled" : "draft"}</StatusBadge> : null}</div>
          {selected ? <>
            <Field label="Name"><input className="control" value={name} onChange={(event) => setName(event.target.value)} /></Field>
            <Field label="Description"><textarea className="control h-auto resize-none py-2" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field>
            <Field label="User IDs (one per line)"><textarea className="control h-auto resize-none py-2 font-mono" rows={5} value={userIdsText} onChange={(event) => setUserIdsText(event.target.value)} placeholder="00000000-0000-4000-8000-000000000000" /></Field>
            {invalidUserId ? <div className="mt-2 text-xs font-black text-brutal-red">Every user ID must be a UUID.</div> : null}
            <ServerTargetPicker options={serverOptions} selectedTargets={selectedTargets} search={serverSearch} onSearch={onServerSearch} loading={serverOptionsLoading} error={serverOptionsError} disabled={busyAction !== null} onToggle={(serverSlug, selectedNow) => setServerSlugs((current) => selectedNow ? current.filter((slug) => slug !== serverSlug) : [...new Set([...current, serverSlug])].sort())} createsFirstRule={false} mode="selection" />
            {retainedMemberIds.length ? <div className="mt-3 border-2 border-black bg-brutal-yellow px-3 py-2 text-xs font-bold">{retainedMemberIds.length} unresolved historical member(s) will be retained without exposing the target ID.</div> : null}
            <label className="mt-4 flex items-center gap-2 text-sm font-black"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 accent-black" /> Enabled and available to flags</label>
            <div className="mt-2 text-xs font-semibold text-black/55">Membership is OR: matching any listed user ID or any selected server is enough.</div>
            <button className="btn-brutal-sm mt-4 bg-brutal-lime px-3 py-2 text-xs" disabled={!name.trim() || invalidUserId || (enabled && memberCount === 0) || !auditReasonValid(reason) || configVersion === null || busyAction !== null} onClick={() => void onUpdate({ audienceKey: selected.audienceKey, name: name.trim(), description: description.trim(), enabled, userIds: parsedUserIds, serverSlugs, retainedMemberIds })}>{busyAction === "audience-update" ? <Loader2 size={16} className="animate-spin" /> : <Save size={15} />} Save audience</button>
          </> : <EmptyRow>Create a draft audience to start.</EmptyRow>}
        </div>
        {selected ? <div className="border-2 border-black bg-white p-5 shadow-brutal"><h3 className="text-lg font-black">Affected flags</h3><p className="mt-1 text-xs font-semibold text-black/55">Changing membership immediately changes evaluation for these referencing flags.</p><div className="mt-3 flex flex-wrap gap-2">{selected.affectedFlags.length ? selected.affectedFlags.map((key) => <span key={key} className="border-2 border-black bg-brutal-cream px-2 py-1 font-mono text-xs font-bold">{key}</span>) : <span className="text-sm font-semibold text-black/50">No flag references this audience.</span>}</div></div> : null}
      </section>

      <aside className="space-y-5">
        <div className="border-2 border-black bg-white p-4 shadow-brutal"><div className="mb-1 flex items-center gap-2"><Plus size={18} /><h2 className="text-sm font-black uppercase">Create audience draft</h2></div><p className="mb-3 text-[11px] font-semibold text-black/50">Drafts may be empty. Add typed members before enabling or attaching to a flag.</p><Field label="Audience key"><input className="control font-mono" value={newKey} onChange={(event) => setNewKey(event.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ""))} placeholder="insiders" /></Field><Field label="Name"><input className="control" value={newName} onChange={(event) => setNewName(event.target.value)} /></Field><Field label="Description"><textarea className="control h-auto resize-none py-2" rows={3} value={newDescription} onChange={(event) => setNewDescription(event.target.value)} /></Field><button className="btn-brutal-sm mt-4 w-full bg-brutal-cyan px-3 py-2 text-xs" disabled={!audienceKeyValid(newKey) || !newName.trim() || !auditReasonValid(reason) || configVersion === null || busyAction !== null} onClick={async () => { if (await onCreate({ audienceKey: newKey, name: newName.trim(), description: newDescription.trim(), enabled: false, userIds: [], serverSlugs: [] })) { setSelectedKey(newKey); setNewKey(""); setNewName(""); setNewDescription(""); } }}>{busyAction === "audience-create" ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Create draft</button></div>
        <div className="border-2 border-black bg-white p-4 shadow-brutal"><Field label="Audit reason for every change"><textarea className="control h-auto resize-none py-2" rows={5} value={reason} onChange={(event) => onReason(event.target.value)} placeholder="Why is this audience changing?" /></Field><div className="mt-2 text-[11px] font-semibold text-black/50">Audience edits use the global feature-flag config version, audit receipt, and authoritative readback.</div></div>
      </aside>
    </div>
  );
}

function LabsSurface({ labs, selectedLab, selectedLabKey, onSelect, reason, onReason, busyAction, configVersion, onCreate, onUpdate, onTransition }: { labs: LabDefinition[]; selectedLab: LabDefinition | null; selectedLabKey: string; onSelect: (value: string) => void; reason: string; onReason: (value: string) => void; busyAction: string | null; configVersion: number | null; onCreate: (input: { labKey: string; name: string; description: string }) => Promise<boolean>; onUpdate: (input: { name: string; description: string }) => Promise<boolean>; onTransition: (state: LabState) => Promise<void> }) {
  return (
    <div className="mx-auto grid max-w-[1200px] gap-5 px-4 py-5 lg:grid-cols-[300px_minmax(0,1fr)_340px]">
      <section className="border-2 border-black bg-white shadow-brutal">
        <div className="border-b-2 border-black bg-brutal-pink px-4 py-3"><h2 className="text-sm font-black uppercase">Lab catalog</h2></div>
        <div className="divide-y-2 divide-black">{labs.length ? labs.map((lab) => <button key={lab.labKey} type="button" onClick={() => onSelect(lab.labKey)} className={`grid w-full gap-2 px-4 py-4 text-left ${selectedLabKey === lab.labKey ? "bg-brutal-lavender" : "bg-white"}`}><div className="text-sm font-black">{lab.name}</div><div className="break-all font-mono text-[11px] font-bold text-black/50">{lab.labKey}</div><StatusBadge tone={lab.state === "open" ? "ok" : lab.state === "retired" ? "neutral" : "error"}>{lab.state}</StatusBadge></button>) : <EmptyRow>No Labs yet.</EmptyRow>}</div>
      </section>
      <LabDetail lab={selectedLab} reason={reason} busyAction={busyAction} onUpdate={onUpdate} onTransition={onTransition} />
      <aside className="space-y-5"><CreateLabForm reason={reason} busyAction={busyAction} configVersion={configVersion} onCreate={onCreate} /><div className="border-2 border-black bg-white p-4 shadow-brutal"><Field label="Audit reason for every change"><textarea className="control h-auto resize-none py-2" rows={5} value={reason} onChange={(event) => onReason(event.target.value)} placeholder="Why is this Lab changing?" /></Field><div className="mt-2 text-[11px] font-semibold text-black/50">Every human action has the same Login with Raft agent action, operator allowlist, config CAS, audit, and readback.</div></div></aside>
    </div>
  );
}

function LabDetail({ lab, reason, busyAction, onUpdate, onTransition }: { lab: LabDefinition | null; reason: string; busyAction: string | null; onUpdate: (input: { name: string; description: string }) => Promise<boolean>; onTransition: (state: LabState) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => { setName(lab?.name ?? ""); setDescription(lab?.description ?? ""); setEditing(false); }, [lab?.labKey, lab?.name, lab?.description]);
  if (!lab) return <section className="border-2 border-black bg-white p-5 shadow-brutal"><EmptyRow>Select a Lab.</EmptyRow></section>;
  const readonly = lab.state === "retired";
  return (
    <section className="space-y-5">
      <div className="border-2 border-black bg-white p-5 shadow-brutal">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><div className="text-xs font-black uppercase text-black/50">Lab definition</div><h2 className="text-3xl font-black">{lab.name}</h2><div className="mt-1 font-mono text-xs font-bold text-black/50">{lab.labKey}</div></div><StatusBadge tone={lab.state === "open" ? "ok" : lab.state === "retired" ? "neutral" : "error"}>{lab.state}</StatusBadge></div>
        {editing ? <div className="grid gap-3"><Field label="User-visible name"><input className="control" value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="User-visible description"><textarea className="control h-auto resize-none py-2" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} /></Field><div className="flex gap-2"><button className="btn-brutal-sm bg-brutal-lime px-3 py-2 text-xs" disabled={!name.trim() || !description.trim() || !auditReasonValid(reason) || busyAction !== null} onClick={async () => { if (await onUpdate({ name: name.trim(), description: description.trim() })) setEditing(false); }}><Save size={15} /> Save</button><button className="btn-brutal-sm bg-white px-3 py-2 text-xs" onClick={() => setEditing(false)}><X size={15} /> Cancel</button></div></div> : <><p className="text-base font-semibold leading-relaxed text-black/70">{lab.description}</p><button className="btn-brutal-sm mt-4 bg-white px-3 py-2 text-xs" disabled={readonly} onClick={() => setEditing(true)}><Pencil size={15} /> Edit name & description</button></>}
      </div>
      <div className="border-2 border-black bg-white p-5 shadow-brutal">
        <h3 className="text-lg font-black">Lifecycle</h3><p className="mt-1 text-xs font-semibold text-black/55">Paused Labs keep enrollment and resume automatically. Retired is terminal and preserves read-only history.</p>
        <div className="mt-4 flex flex-wrap gap-2">{nextLabStates(lab.state).map((state) => <button key={state} className={`btn-brutal-sm px-3 py-2 text-xs ${state === "retired" ? "bg-brutal-red" : state === "paused" ? "bg-brutal-orange" : "bg-brutal-lime"}`} disabled={!auditReasonValid(reason) || busyAction !== null} onClick={() => void onTransition(state)}>{state === "retired" ? <Archive size={15} /> : state === "paused" ? <Pause size={15} /> : <Play size={15} />}{labTransitionLabel(lab.state, state)}</button>)}</div>
        {readonly ? <div className="mt-4 border-2 border-black bg-brutal-cream px-3 py-2 text-xs font-bold">Retired Labs cannot be edited, resumed, or selected for new rules.</div> : null}
      </div>
    </section>
  );
}

function CreateLabForm({ reason, busyAction, configVersion, onCreate }: { reason: string; busyAction: string | null; configVersion: number | null; onCreate: (input: { labKey: string; name: string; description: string }) => Promise<boolean> }) {
  const [labKey, setLabKey] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  return <div className="border-2 border-black bg-white p-4 shadow-brutal"><div className="mb-1 flex items-center gap-2"><Plus size={18} /><h2 className="text-sm font-black uppercase">Create draft</h2></div><p className="mb-3 text-[11px] font-semibold text-black/50">Technical key is stable. Drafts cannot be selected by a flag until published.</p><Field label="Lab key"><input className="control font-mono" value={labKey} onChange={(event) => setLabKey(event.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, ""))} placeholder="example_lab_v0" /></Field><Field label="Name"><input className="control" value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Description"><textarea className="control h-auto resize-none py-2" rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></Field><button className="btn-brutal-sm mt-4 w-full bg-brutal-pink px-3 py-2 text-xs" disabled={!labKeyValid(labKey) || !name.trim() || !description.trim() || !auditReasonValid(reason) || configVersion === null || busyAction !== null} onClick={async () => { if (await onCreate({ labKey, name: name.trim(), description: description.trim() })) { setLabKey(""); setName(""); setDescription(""); } }}>{busyAction === "lab-create" ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />} Create draft</button></div>;
}

function SurfaceButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" onClick={onClick} className={`inline-flex min-w-0 items-center justify-center gap-1.5 px-2 py-1.5 text-center text-xs font-black sm:px-3 ${active ? "bg-brutal-yellow" : "bg-transparent"}`}>{children}</button>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="mt-3 grid gap-1 text-xs font-bold text-black/60">{label}{children}</label>; }
function LoadingRow() { return <div className="flex items-center gap-2 px-4 py-5 text-sm font-black"><Loader2 size={16} className="animate-spin" /> Loading</div>; }
function EmptyRow({ children }: { children: React.ReactNode }) { return <div className="border-2 border-black bg-brutal-cream px-3 py-3 text-sm font-bold text-black/60">{children}</div>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="border-2 border-black bg-brutal-cream px-3 py-2 shadow-brutal-sm"><div className="text-[10px] font-black uppercase text-black/45">{label}</div><div className="text-sm font-black">{value}</div></div>; }
function StatusBadge({ children, tone }: { children: string; tone: "ok" | "error" | "neutral" }) { const bg = tone === "ok" ? "bg-brutal-lime" : tone === "error" ? "bg-brutal-red" : "bg-white"; return <span className={`w-fit border-2 border-black px-1.5 py-0.5 text-[10px] font-black uppercase ${bg}`}>{children}</span>; }

export default function App() {
  const [principal, setPrincipal] = useState<Principal | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loginError = useMemo(() => new URLSearchParams(window.location.search).get("login_error"), []);
  useEffect(() => {
    let cancelled = false;
    apiFetch<SessionResponse>("/api/session")
      .then((session) => { if (!cancelled) setPrincipal(session.principal); })
      .catch((loadError) => { if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Session load failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  async function logout() { await fetch("/auth/logout", { method: "POST" }); window.location.href = "/login"; }
  if (loading) return <main className="grid min-h-screen place-items-center bg-brutal-cream text-sm font-black uppercase">Loading feature flags</main>;
  if (!principal) return <LoginScreen error={loginError || error} />;
  return <Console principal={principal} onLogout={logout} />;
}
