export function isSlackBridgeSurfaceEnabled(gate: { resolved: boolean; enabled: boolean }): boolean {
  return gate.resolved && gate.enabled;
}
