import { Cloud, Laptop, Monitor, Server } from "lucide-react";
import type { LucideIcon, LucideProps } from "lucide-react";
import { computerDeviceShape } from "../../utils/computerDevice";
import type { ComputerDeviceInput, ComputerDeviceShape } from "../../utils/computerDevice";

const SHAPE_ICONS: Record<ComputerDeviceShape, LucideIcon> = {
  laptop: Laptop,
  monitor: Monitor,
  server: Server,
  cloud: Cloud,
};

/**
 * A Computer's device glyph: the Lucide laptop / monitor / server / cloud for
 * what it runs on (computerDeviceShape). Shape only — the OS is text beside
 * it, and the presence light is the caller's ComputerRowStatusDot on the
 * corner. raft-ui has no computer icon, so this composes Lucide directly.
 */
export function ComputerDeviceIcon({ machine, ...props }: LucideProps & { machine: ComputerDeviceInput }) {
  const shape = computerDeviceShape(machine);
  const Icon = SHAPE_ICONS[shape];
  return <Icon aria-hidden="true" data-device-shape={shape} {...props} />;
}
