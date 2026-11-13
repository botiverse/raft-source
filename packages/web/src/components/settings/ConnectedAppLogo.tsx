import AvatarSlot from "../ui/AvatarSlot";

function initialsForApp(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length >= 2
    ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`
    : (parts[0] ?? "A").slice(0, 2);
  return letters.toUpperCase() || "A";
}

/**
 * An App's logo, or its initials. Every App surface uses this one (lists, editors, an Agent's Apps
 * tab). `xs` is a dense row's (the Activity overview's app events), the size of a `sm` IconTile.
 */
export function ConnectedAppLogo({ name, logoUrl, seed, size = "md" }: { name: string; logoUrl?: string | null; seed: string; size?: "xs" | "sm" | "md" | "lg" }) {
  return (
    <AvatarSlot
      context={size === "lg" ? "account-tile" : size === "md" ? "mention-card" : size === "sm" ? "list-row" : "compact-row"}
      type="app"
      appAvatarUrl={logoUrl}
      appInitials={initialsForApp(name || seed)}
    />
  );
}
