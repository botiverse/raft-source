import {
  clearClockTimeout,
  RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY,
  setClockTimeout,
} from "@botiverse/raft-shared";
import type { RuntimeAccountUsageProvider } from "@botiverse/raft-shared";
import { AlertCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { Badge, Status } from "raft-ui";

import { useMediaQuery } from "../../hooks/effectPrimitives";
import { formatRelativeTime } from "../../utils/relativeTime";
import {
  runtimeAccountUsageClient,
} from "../../utils/runtimeAccountUsageClient";
import type {
  RuntimeAccountUsageClient,
  RuntimeAccountUsageReadResult,
  RuntimeAccountUsageRefreshResult,
} from "../../utils/runtimeAccountUsageClient";
import BottomSheet from "../ui/BottomSheet";
import { useViewportClamp } from "../layout/useViewportClamp";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";

const HOVER_OPEN_DELAY_MS = 200;
const HOVER_CLOSE_DELAY_MS = 160;
const POST_REFRESH_READ_DELAY_MS = 1_200;
const POST_REFRESH_MAX_READ_ATTEMPTS = 8;

type SurfaceRefreshState = RuntimeAccountUsageRefreshResult["state"] | "idle" | "requesting" | "unconfirmed";

function usageProviderForRuntime(runtimeId: string): RuntimeAccountUsageProvider | null {
  if (runtimeId === "claude" || runtimeId === "codex" || runtimeId === "grok") return runtimeId;
  if (runtimeId === "kimi" || runtimeId === "kimi-sdk") return "kimi";
  return null;
}

function providerName(provider: RuntimeAccountUsageProvider): string {
  if (provider === "claude") return "Claude";
  if (provider === "codex") return "Codex";
  if (provider === "grok") return "Grok";
  return "Kimi";
}

function isAttention(result: RuntimeAccountUsageReadResult): boolean {
  if (result.state === "missing" || result.state === "stale") return result.state === "stale";
  return result.snapshot.accounts.some((account) =>
    account.health !== "ok" || account.windows.some((window) => window.status !== "ok"),
  );
}

/**
 * Runtime labels are RUI badges in both their inert and interactive states.
 * Keep the consumer's visual overrides, but let the primitive own the inline
 * flex layout so the label and health indicator share one cross-axis.
 */
function runtimeBadgeClassName(className: string): string {
  return `${className} inline-flex items-center`;
}

function RuntimeUsageContents({
  result,
  loading,
  loadError,
}: {
  result: RuntimeAccountUsageReadResult | null;
  loading: boolean;
  loadError: boolean;
}) {
  const { formatMessage, locale } = useIntl();
  if (loading && !result) {
    return <div className="px-4 py-5 text-sm text-black/50">{formatMessage({ id: "machine.runtimeUsage.reading" })}</div>;
  }
  if (loadError && !result) {
    return (
      <div className="flex items-start gap-2 px-4 py-5 text-sm text-brutal-orange">
        <AlertCircle size={16} className="mt-0.5 shrink-0" />
        {formatMessage({ id: "machine.runtimeUsage.readFailed" })}
      </div>
    );
  }
  if (!result || result.state === "missing") {
    return (
      <div className="px-4 py-5">
        <div className="text-sm font-bold">{formatMessage({ id: "machine.runtimeUsage.noSnapshot" })}</div>
        <p className="mt-1 text-xs leading-5 text-black/55">
          {formatMessage({ id: "machine.runtimeUsage.noSnapshotDescription" })}
        </p>
      </div>
    );
  }

  const stale = result.state === "stale";
  return (
    <div className={stale ? "bg-gray-50" : "bg-white"}>
      {stale && (
        <div className="border-b-2 border-black bg-brutal-orange/20 px-4 py-2 text-xs font-bold">
          {formatMessage({ id: "machine.runtimeUsage.stale" })}
        </div>
      )}
      <div className="divide-y-2 divide-black/15">
        {result.snapshot.accounts.map((account) => {
          const reauth = account.health === "reauth_required";
          return (
            <div key={account.accountKey} className={`px-4 py-3 ${stale ? "opacity-65" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold">
                    {account.planLabel ?? formatMessage({ id: "machine.runtimeUsage.accountFallback" })}
                  </div>
                  {account.maskedLabel && (
                    <div className="mt-0.5 truncate text-xs text-black/50" data-testid="runtime-account-masked-label">
                      {account.maskedLabel}
                    </div>
                  )}
                </div>
                <span className={`shrink-0 border border-black px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                  account.health === "ok" ? "bg-brutal-lime" : "bg-brutal-orange"
                }`}>
                  {formatMessage({ id: `machine.runtimeUsage.health.${account.health}` })}
                </span>
              </div>
              {account.health === "unsupported" || account.health === "error" ? (
                <p className="mt-3 text-xs leading-5 text-black/60">
                  {formatMessage({ id: account.health === "unsupported"
                    ? "machine.runtimeUsage.unsupportedDescription"
                    : "machine.runtimeUsage.readFailed" })}
                </p>
              ) : reauth ? (
                <p className="mt-3 text-xs leading-5 text-black/60">
                  {formatMessage({ id: "machine.runtimeUsage.reauthDescription" })}
                </p>
              ) : (
                <div className="mt-3 space-y-3">
                  {account.windows.map((window) => (
                    <div key={window.id}>
                      <div className="flex flex-col gap-0.5 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                        <span className="font-bold">{window.label}</span>
                        {window.status === "parse_unavailable" ? (
                          <span className="text-brutal-orange">{formatMessage({ id: "machine.runtimeUsage.parseUnavailable" })}</span>
                        ) : (
                          <span className="text-black/55 sm:text-right">
                            {window.resetsAt
                              ? formatMessage(
                                  { id: "machine.runtimeUsage.windowSummary" },
                                  {
                                    percent: Math.round((window.usedRatio ?? 0) * 100),
                                    reset: formatRelativeTime(window.resetsAt, locale) ?? formatMessage({ id: "machine.runtimeUsage.later" }),
                                  },
                                )
                              : formatMessage(
                                  { id: "machine.runtimeUsage.windowSummaryResetUnavailable" },
                                  { percent: Math.round((window.usedRatio ?? 0) * 100) },
                                )}
                          </span>
                        )}
                      </div>
                      {window.status !== "parse_unavailable" && (
                        <div className="mt-1.5 h-2 overflow-hidden border border-black bg-white">
                          <div
                            className={window.status === "limit_reached" ? "h-full bg-brutal-orange" : "h-full bg-brutal-cyan"}
                            style={{ width: `${Math.round((window.usedRatio ?? 0) * 100)}%` }}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="border-t-2 border-black/15 px-4 py-2 text-[11px] text-black/50">
        {formatMessage(
          { id: "machine.runtimeUsage.metadata" },
          {
            updated: formatRelativeTime(result.snapshot.collectedAt, locale) ?? formatMessage({ id: "machine.runtimeUsage.recently" }),
          },
        )}
      </div>
    </div>
  );
}

function Surface({
  provider,
  runtimeVersion,
  result,
  loading,
  loadError,
  refreshState,
  onRefresh,
  onClose,
}: {
  provider: RuntimeAccountUsageProvider;
  runtimeVersion?: string | null;
  result: RuntimeAccountUsageReadResult | null;
  loading: boolean;
  loadError: boolean;
  refreshState: SurfaceRefreshState;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <div data-testid={`runtime-usage-surface-${provider}`}>
      <div className="flex items-center justify-between gap-3 border-b-2 border-black px-4 py-3">
        <div>
          <div className="text-sm font-black">{formatMessage({ id: "machine.runtimeUsage.title" }, { provider: providerName(provider) })}</div>
          <div data-testid={`runtime-version-${provider}`} className="text-[10px] font-bold uppercase tracking-wide text-black/55">
            {runtimeVersion?.trim()
              ? formatMessage({ id: "machine.runtimeUsage.version" }, { version: runtimeVersion.trim() })
              : formatMessage({ id: "machine.runtimeUsage.versionUnavailable" })}
          </div>
          <div className="text-[10px] font-bold uppercase tracking-wide text-black/45">{formatMessage({ id: "machine.runtimeUsage.private" })}</div>
        </div>
        <button type="button" className="p-1" onClick={onClose} aria-label={formatMessage({ id: "machine.runtimeUsage.close" })}>
          <X size={16} />
        </button>
      </div>
      <RuntimeUsageContents result={result} loading={loading} loadError={loadError} />
      <div className="flex items-center justify-between gap-3 border-t-2 border-black px-4 py-2.5">
        <span className="text-[11px] text-black/50">
          {refreshState === "requested"
            ? formatMessage({ id: "machine.runtimeUsage.refreshRequested" })
            : refreshState === "unconfirmed"
              ? formatMessage({ id: "machine.runtimeUsage.refreshUnconfirmed" })
            : refreshState === "cooldown"
              ? formatMessage({ id: "machine.runtimeUsage.refreshCooldown" })
              : refreshState === "computer_offline"
                ? formatMessage({ id: "machine.runtimeUsage.computerOffline" })
                : formatMessage({ id: "machine.runtimeUsage.cacheOnly" })}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshState === "requesting"}
          className="btn-brutal-sm flex items-center gap-1 bg-white px-2 py-1 text-xs disabled:opacity-50"
        >
          <RefreshCw size={12} className={refreshState === "requesting" ? "animate-spin" : ""} />
          {formatMessage({ id: "machine.runtimeUsage.refresh" })}
        </button>
      </div>
    </div>
  );
}

export default function RuntimeAccountUsageChip({
  runtimeId,
  runtimeVersion,
  serverId,
  machineId,
  children,
  className,
  client = runtimeAccountUsageClient,
}: {
  runtimeId: string;
  runtimeVersion?: string | null;
  serverId: string;
  machineId: string;
  children: ReactNode;
  className: string;
  client?: RuntimeAccountUsageClient;
}) {
  const { formatMessage } = useIntl();
  const provider = usageProviderForRuntime(runtimeId);
  const mobile = useMediaQuery("(max-width: 767px)");
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<RuntimeAccountUsageReadResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshState, setRefreshState] = useState<SurfaceRefreshState>("idle");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const rereadTimerRef = useRef<ReturnType<typeof setClockTimeout> | null>(null);
  const mountedRef = useRef(true);
  const pinnedRef = useRef(false);
  const pollGenerationRef = useRef(0);
  const subjectGenerationRef = useRef(0);

  const { style: popoverStyle } = useViewportClamp({
    triggerRef,
    popoverRef,
    placement: "vertical-smart",
    open: open && !mobile,
    gutter: 8,
  });

  const readSnapshot = useCallback(async (subjectGeneration = subjectGenerationRef.current) => {
    if (!provider) return null;
    setLoading(true);
    setLoadError(false);
    try {
      const next = await client.read(serverId, machineId, provider);
      if (mountedRef.current && subjectGenerationRef.current === subjectGeneration) setResult(next);
      return next;
    } catch {
      if (mountedRef.current && subjectGenerationRef.current === subjectGeneration) setLoadError(true);
      return null;
    } finally {
      if (mountedRef.current && subjectGenerationRef.current === subjectGeneration) setLoading(false);
    }
  }, [client, machineId, provider, serverId]);

  const startFollowUpReads = useCallback((subjectGeneration = subjectGenerationRef.current) => {
    if (!provider) return;
    const generation = ++pollGenerationRef.current;
    let attempt = 0;

    const scheduleNext = () => {
      if (
        !mountedRef.current
        || subjectGenerationRef.current !== subjectGeneration
        || pollGenerationRef.current !== generation
      ) return;
      if (attempt >= POST_REFRESH_MAX_READ_ATTEMPTS) {
        setRefreshState("unconfirmed");
        return;
      }
      if (rereadTimerRef.current) clearClockTimeout(rereadTimerRef.current);
      rereadTimerRef.current = setClockTimeout(() => {
        rereadTimerRef.current = null;
        attempt += 1;
        client.invalidate(serverId, machineId, provider);
        void readSnapshot(subjectGeneration).then((next) => {
          if (
            !next
            || !mountedRef.current
            || subjectGenerationRef.current !== subjectGeneration
            || pollGenerationRef.current !== generation
          ) return;
          if (next.state === "fresh") {
            setRefreshState("idle");
            return;
          }
          scheduleNext();
        });
      }, POST_REFRESH_READ_DELAY_MS);
    };

    scheduleNext();
  }, [client, machineId, provider, readSnapshot, serverId]);

  const requestBackgroundRefresh = useCallback(async (subjectGeneration = subjectGenerationRef.current) => {
    if (!provider) return;
    try {
      const refresh = await client.refresh(serverId, machineId, provider, "stale_or_missing");
      if (!mountedRef.current || subjectGenerationRef.current !== subjectGeneration) return;
      setRefreshState(refresh.state);
      if (refresh.state === "requested" || refresh.state === "cooldown") startFollowUpReads(subjectGeneration);
    } catch {
      if (mountedRef.current && subjectGenerationRef.current === subjectGeneration) {
        setRefreshState("computer_offline");
      }
    }
  }, [client, machineId, provider, serverId, startFollowUpReads]);

  useEffect(() => {
    const subjectGeneration = ++subjectGenerationRef.current;
    mountedRef.current = true;
    pinnedRef.current = false;
    void readSnapshot(subjectGeneration).then((next) => {
      if (subjectGenerationRef.current !== subjectGeneration) return;
      if (next?.state === "stale" || next?.state === "missing") {
        void requestBackgroundRefresh(subjectGeneration);
      }
    });
    return () => {
      mountedRef.current = false;
      subjectGenerationRef.current += 1;
      pollGenerationRef.current += 1;
      if (openTimerRef.current) clearClockTimeout(openTimerRef.current);
      if (closeTimerRef.current) clearClockTimeout(closeTimerRef.current);
      if (rereadTimerRef.current) clearClockTimeout(rereadTimerRef.current);
    };
  }, [readSnapshot, requestBackgroundRefresh]);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) clearClockTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);
  const cancelHoverOpen = useCallback(() => {
    if (openTimerRef.current) clearClockTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);
  const closeSoon = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setClockTimeout(() => {
      if (!pinnedRef.current) setOpen(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [cancelClose]);
  const openNow = useCallback(() => {
    cancelClose();
    setOpen(true);
    void readSnapshot();
  }, [cancelClose, readSnapshot]);
  const pinOpen = useCallback(() => {
    pinnedRef.current = true;
    openNow();
  }, [openNow]);
  const closeSurface = useCallback(() => {
    pinnedRef.current = false;
    cancelClose();
    cancelHoverOpen();
    setOpen(false);
  }, [cancelClose, cancelHoverOpen]);
  const openAfterHover = useCallback(() => {
    cancelClose();
    if (openTimerRef.current) clearClockTimeout(openTimerRef.current);
    openTimerRef.current = setClockTimeout(openNow, HOVER_OPEN_DELAY_MS);
  }, [cancelClose, openNow]);
  const refresh = useCallback(async () => {
    if (!provider) return;
    const subjectGeneration = subjectGenerationRef.current;
    setRefreshState("requesting");
    try {
      const next = await client.refresh(serverId, machineId, provider, "manual");
      if (!mountedRef.current || subjectGenerationRef.current !== subjectGeneration) return;
      setRefreshState(next.state);
      if (next.accepted || next.state === "cooldown") startFollowUpReads(subjectGeneration);
    } catch {
      if (mountedRef.current && subjectGenerationRef.current === subjectGeneration) {
        setRefreshState("computer_offline");
      }
    }
  }, [client, machineId, provider, serverId, startFollowUpReads]);

  useEffect(() => {
    if (!open || mobile) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pinnedRef.current) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      closeSurface();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pinnedRef.current) closeSurface();
    };
    document.addEventListener("pointerdown", onPointerDown);
    // keydown-global-exempt: Escape closes only this pinned runtime-usage surface.
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [closeSurface, mobile, open]);

  if (!provider) {
    return <Badge appearance="solid" variant="default" uppercase={false} className={runtimeBadgeClassName(className)}>{children}</Badge>;
  }

  const surface = (
    <Surface
      provider={provider}
      runtimeVersion={runtimeVersion}
      result={result}
      loading={loading}
      loadError={loadError}
      refreshState={refreshState}
      onRefresh={() => void refresh()}
      onClose={closeSurface}
    />
  );
  const attention = result ? isAttention(result) : false;
  const hasKnownState = result?.state !== "missing" && result !== null;

  return (
    <>
      <Badge
        ref={triggerRef}
        render={<button type="button" />}
        appearance="solid"
        variant="default"
        uppercase={false}
        className={`${runtimeBadgeClassName(className)} relative cursor-help focus:outline-none focus:ring-2 focus:ring-black focus:ring-offset-1`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={typeof children === "string" ? children : providerName(provider)}
        onMouseEnter={openAfterHover}
        onMouseLeave={() => { cancelHoverOpen(); closeSoon(); }}
        onFocus={openNow}
        onBlur={closeSoon}
        onClick={pinOpen}
      >
        {children}
        {hasKnownState && (
          <Status
            data-testid={`runtime-usage-health-${provider}`}
            size="sm"
            variant={attention ? "warning" : "success"}
            className="ml-1 size-2"
            aria-label={formatMessage({ id: attention ? "machine.runtimeUsage.attention" : "machine.runtimeUsage.healthy" })}
          />
        )}
      </Badge>
      {open && mobile && (
        <BottomSheet onClose={closeSurface} sheetClassName="max-h-[82vh] overflow-y-auto">
          {surface}
        </BottomSheet>
      )}
      {open && !mobile && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={formatMessage({ id: "machine.runtimeUsage.dialogLabel" }, { provider: providerName(provider) })}
          className="z-[70] w-[min(390px,calc(100vw-16px))] overflow-y-auto border-2 border-black bg-white shadow-brutal-lg"
          style={popoverStyle}
          onMouseEnter={cancelClose}
          onMouseLeave={closeSoon}
        >
          {surface}
        </div>,
        document.body,
      )}
    </>
  );
}

export function RuntimeAccountUsageGateChip({
  enabled,
  runtimeId,
  runtimeVersion,
  serverId,
  machineId,
  children,
  className,
  client,
}: {
  enabled: boolean;
  runtimeId: string;
  runtimeVersion?: string | null;
  serverId: string | null;
  machineId: string;
  children: ReactNode;
  className: string;
  client?: RuntimeAccountUsageClient;
}) {
  const runtimeAccountUsageGate = useServerFeatureFlag(RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY);
  if (!enabled || !serverId || !runtimeAccountUsageGate.resolved || !runtimeAccountUsageGate.enabled) {
    return (
      <Badge appearance="solid" variant="default" uppercase={false} className={runtimeBadgeClassName(className)}>
        {children}
      </Badge>
    );
  }
  return (
    <RuntimeAccountUsageChip
      runtimeId={runtimeId}
      runtimeVersion={runtimeVersion}
      serverId={serverId}
      machineId={machineId}
      className={className}
      client={client}
    >
      {children}
    </RuntimeAccountUsageChip>
  );
}

export { usageProviderForRuntime };
