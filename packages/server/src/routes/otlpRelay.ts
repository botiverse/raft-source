import type { Request, Response } from "express";

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface OtlpRelayConfig {
  authorization?: string;
  targetUrl?: string;
  fallbackTargetUrl?: string;
  maxBytes?: string;
  fetch?: typeof fetch;
}

export async function otlpRelayHandler(req: Request, res: Response, config: OtlpRelayConfig = {}): Promise<void> {
  const expectedAuthorization = config.authorization ?? process.env.OTLP_RELAY_AUTHORIZATION;
  if (!expectedAuthorization) {
    res.status(500).json({ error: "OTLP relay authorization is not configured" });
    return;
  }

  if (req.get("authorization") !== expectedAuthorization) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const targetUrl = normalizeOtlpTracesEndpoint(config.targetUrl ?? process.env.OTLP_RELAY_TARGET_URL ?? "");
  if (!targetUrl) {
    res.status(500).json({ error: "OTLP relay target is not configured" });
    return;
  }

  const maxBytes = parsePositiveInt(config.maxBytes ?? process.env.OTLP_RELAY_MAX_BYTES, DEFAULT_MAX_BYTES);
  const body = Buffer.isBuffer(req.body) ? new Uint8Array(req.body) : new Uint8Array();
  if (body.byteLength > maxBytes) {
    res.status(413).json({ error: "Payload too large" });
    return;
  }

  const upstreamFetch = config.fetch ?? fetch;
  const upstreamResponse = await upstreamFetch(targetUrl, {
    method: "POST",
    headers: {
      "content-type": req.get("content-type") ?? "application/json",
    },
    body,
  });

  if (!upstreamResponse.ok) {
    res.status(502).json({
      error: "OTLP upstream failed",
      upstream_status: upstreamResponse.status,
    });
    return;
  }

  res.status(200).json({ ok: true, upstream_status: upstreamResponse.status });
}

export function normalizeOtlpTracesEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/v1/traces") ? trimmed : `${trimmed.replace(/\/+$/, "")}/v1/traces`;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
