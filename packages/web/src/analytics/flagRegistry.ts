// Registry of feature flags the Dev tools panel can toggle (stdrc
// #proj-activity:171042a3 2026-06-25: "dev tools 菜单里包含所有 feature flag
// 的开关"). Each entry lists the flag key + its known variants + the default
// (what renders when no override / no PostHog value). Add a row here when you
// introduce a new flag so it shows up as a Dev-tools toggle.

import { ACTIVITY_SIDEBAR_INBOX_FLAG_KEY } from "../store/serverFeatureFlags";

export interface FeatureFlagSpec {
  key: string;
  label: string;
  variants: string[];
  /** Effective value when neither an override nor PostHog provides one. */
  default: string;
}

export const FEATURE_FLAG_REGISTRY: FeatureFlagSpec[] = [
  {
    key: "chat_grid_layout_v0",
    label: "Chat grid layout",
    variants: ["disabled", "enabled"],
    default: "disabled",
  },
  {
    key: "sync_core_messages_v0",
    label: "Sync-core messages",
    variants: ["disabled", "enabled"],
    default: "disabled",
  },
  {
    key: ACTIVITY_SIDEBAR_INBOX_FLAG_KEY,
    label: ACTIVITY_SIDEBAR_INBOX_FLAG_KEY,
    variants: ["disabled", "enabled"],
    default: "disabled",
  },
];
