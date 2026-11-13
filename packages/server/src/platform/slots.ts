// Platform entry point: at most N holders of a name at once across replicas,
// each on a lease that ends when given back or at its expiry
// (services/sharedSlots.ts). Artifacts holds one per running import.
export { createSharedSlots, type SharedSlots, type SlotLease } from "../services/sharedSlots";
