export const CHINESE_COMMUNITY_QR_CONFIG_URL = "https://static.raft.build/community/chinese-qr.json";
export const CHINESE_COMMUNITY_QR_FALLBACK_CONFIG_PATH = "/community/chinese-qr.json";

export interface ChineseCommunityQrCrop {
  sourceWidth: number;
  sourceHeight: number;
  x: number;
  y: number;
  size: number;
}

export interface ChineseCommunityQrConfig {
  crop?: ChineseCommunityQrCrop;
  imageUrl: string;
  updatedAt?: string;
  expiresAt?: string;
  fallbackContact?: string;
}

declare global {
  interface Window {
    __RAFT_CHINESE_COMMUNITY_QR_CONFIG_URL__?: string;
  }
}

export function getChineseCommunityQrConfigUrl() {
  if (typeof window === "undefined") return CHINESE_COMMUNITY_QR_CONFIG_URL;
  return window.__RAFT_CHINESE_COMMUNITY_QR_CONFIG_URL__ || CHINESE_COMMUNITY_QR_CONFIG_URL;
}

function normalizeCrop(value: unknown): ChineseCommunityQrCrop | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { sourceWidth, sourceHeight, x, y, size } = value as Record<string, unknown>;
  if (![sourceWidth, sourceHeight, x, y, size].every((n) => typeof n === "number" && Number.isSafeInteger(n))) return undefined;
  const crop = { sourceWidth, sourceHeight, x, y, size } as ChineseCommunityQrCrop;
  if (crop.sourceWidth <= 0 || crop.sourceHeight <= 0 || crop.size <= 0 || crop.x < 0 || crop.y < 0
    || crop.x + crop.size > crop.sourceWidth || crop.y + crop.size > crop.sourceHeight) return undefined;
  return crop;
}

export function chineseCommunityQrCropStyle(crop: ChineseCommunityQrCrop | undefined) {
  if (!crop) return undefined;
  return {
    width: `${crop.sourceWidth / crop.size * 100}%`,
    height: `${crop.sourceHeight / crop.size * 100}%`,
    left: `${-crop.x / crop.size * 100}%`,
    top: `${-crop.y / crop.size * 100}%`,
    maxWidth: "none",
    objectFit: "fill" as const,
  };
}

export function normalizeChineseCommunityQrConfig(value: unknown): ChineseCommunityQrConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.imageUrl !== "string" || !record.imageUrl.trim()) return null;
  const crop = normalizeCrop(record.crop);
  return {
    ...(crop ? { crop } : {}),
    imageUrl: record.imageUrl.trim(),
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim()
      ? record.updatedAt.trim()
      : undefined,
    expiresAt: typeof record.expiresAt === "string" && record.expiresAt.trim()
      ? record.expiresAt.trim()
      : undefined,
    fallbackContact: typeof record.fallbackContact === "string" && record.fallbackContact.trim()
      ? record.fallbackContact.trim()
      : undefined,
  };
}

export function resolveChineseCommunityQrConfig(
  value: unknown,
  configUrl: string,
): ChineseCommunityQrConfig | null {
  const config = normalizeChineseCommunityQrConfig(value);
  if (!config) return null;

  try {
    const documentUrl = typeof window === "undefined" ? "https://app.raft.build/" : window.location.href;
    const resolvedConfigUrl = new URL(configUrl, documentUrl);
    const resolvedImageUrl = new URL(config.imageUrl, resolvedConfigUrl);
    const isRemoteConfig = /^[a-z][a-z\d+.-]*:/i.test(configUrl);
    if (
      (isRemoteConfig && resolvedConfigUrl.protocol !== "https:")
      || resolvedImageUrl.origin !== resolvedConfigUrl.origin
      || !resolvedImageUrl.pathname.startsWith("/community/")
      || resolvedImageUrl.username
      || resolvedImageUrl.password
      || resolvedImageUrl.search
      || resolvedImageUrl.hash
    ) {
      return null;
    }

    return { ...config, imageUrl: resolvedImageUrl.toString() };
  } catch {
    return null;
  }
}

export function isChineseCommunityQrExpired(expiresAt: string | undefined, now = new Date()) {
  if (!expiresAt) return false;
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return false;
  return expires.getTime() < now.getTime();
}
