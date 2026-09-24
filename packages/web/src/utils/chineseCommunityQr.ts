export const CHINESE_COMMUNITY_QR_CONFIG_PATH = "/community/chinese-qr.json";

export interface ChineseCommunityQrConfig {
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
  if (typeof window === "undefined") return CHINESE_COMMUNITY_QR_CONFIG_PATH;
  return window.__RAFT_CHINESE_COMMUNITY_QR_CONFIG_URL__ || CHINESE_COMMUNITY_QR_CONFIG_PATH;
}

export function normalizeChineseCommunityQrConfig(value: unknown): ChineseCommunityQrConfig | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.imageUrl !== "string" || !record.imageUrl.trim()) return null;
  return {
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

export function isChineseCommunityQrExpired(expiresAt: string | undefined, now = new Date()) {
  if (!expiresAt) return false;
  const expires = new Date(expiresAt);
  if (Number.isNaN(expires.getTime())) return false;
  return expires.getTime() < now.getTime();
}
