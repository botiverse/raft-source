import {
  resolveAddMachineConnectedMachine,
} from "./addMachineConnection";
import type {
  AddMachineConnectionBaseline,
  AddMachineConnectionMachine,
} from "./addMachineConnection";

/**
 * The connect-a-computer flow, as a state machine over machine rows.
 *
 * Both surfaces that ask a user to run the setup command — the Add Computer
 * dialog and the onboarding setup gate — need the same three answers: has a
 * computer shown up for *this* attempt, is it online yet, and are we sure it is
 * the user's. They must not answer them differently.
 *
 * Everything hinges on a baseline: the machine rows that already existed when
 * the user was shown the command. Without it a surface cannot tell "the computer
 * I just connected" from "a computer that was already sitting there", which is
 * how the onboarding gate ended up claiming it was waiting on a stale row the
 * user never touched.
 *
 * Note the browser is blind between "user runs the command" and "a row appears":
 * the device authorization is deliberately not bound to a user or server until
 * it is approved, so there is no observable "command running" state. `idle`
 * therefore means "nothing yet", not "user has done nothing".
 */
export type ComputerConnectionProgress<T extends AddMachineConnectionMachine> =
  | { state: "idle"; machine: null; requiresConfirmation: false }
  | { state: "waiting"; machine: T; requiresConfirmation: false }
  | { state: "connected"; machine: T; requiresConfirmation: boolean };

export function resolveComputerConnectionProgress<T extends AddMachineConnectionMachine>(
  machines: T[],
  pendingMachineId: string,
  baseline: AddMachineConnectionBaseline[],
): ComputerConnectionProgress<T> {
  // "Connected" is the stricter question (online + attributable + owned), so it
  // is asked first and reuses the resolver the Add Computer dialog already ships.
  const connected = resolveAddMachineConnectedMachine(machines, pendingMachineId, baseline);
  if (connected) {
    return {
      state: "connected",
      machine: connected.machine,
      requiresConfirmation: connected.requiresConfirmation,
    };
  }

  // Otherwise: an offline row we can attribute to this user. The test is
  // ownership, not novelty — an offline computer that *this user* attached can
  // only have come from their own setup, so "waiting for it to come online" is
  // true whether the row appeared while they watched or a page reload lost that
  // history. Keying this on "new since baseline" instead would silently drop
  // back to the setup instructions the moment the user refreshes mid-connect.
  //
  // What ownership rules out is the original defect: adopting *any* row — a
  // plain daemon, or another member's computer — as the one being connected.
  const pending = machines.find(
    (machine) =>
      machine.status !== "online" &&
      (machine.id === pendingMachineId ||
        (Boolean(machine.isComputer) && Boolean(machine.computerAttachedByCurrentUser))),
  );
  if (pending) return { state: "waiting", machine: pending, requiresConfirmation: false };

  // Nothing in flight — but the server may already have had an online computer
  // when we started (the setup gate still shows this surface when a computer is
  // online without a usable runtime). It is already connected; saying otherwise
  // would ask the user to set up a computer they have.
  const alreadyOnline = machines.find(
    (machine) =>
      Boolean(machine.isComputer) &&
      machine.status === "online" &&
      Boolean(machine.computerAttachedByCurrentUser),
  );
  if (alreadyOnline) {
    return { state: "connected", machine: alreadyOnline, requiresConfirmation: false };
  }

  return { state: "idle", machine: null, requiresConfirmation: false };
}
