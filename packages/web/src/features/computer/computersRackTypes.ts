import type { useComputerRestart, useComputerUpgradeCard } from "../../components/machine/useComputerUpgradeCard";

export type RackVariant = "desktop" | "phone";

export type UpgradeCard = ReturnType<typeof useComputerUpgradeCard>;
export type RestartState = ReturnType<typeof useComputerRestart>;
