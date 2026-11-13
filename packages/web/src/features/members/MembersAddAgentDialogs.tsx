import { useCallback } from "react";
import { CreateAgentDialog } from "../../components/agent/DeferredCreateAgentDialog";
import { deferredDialog } from "../../boot/deferredUi";
import type { AddAgentStep } from "./useAddAgentActions";

const HandoffDialog = deferredDialog(() => import("../../components/handoff/HandoffDialog"));
// The external agent's own two-step dialog (#wg-external-agent-ux:#2), kept out of the first download.
const CreateExternalAgentDialog = deferredDialog(() => import("../agent/CreateExternalAgentDialog").then((module) => ({ default: module.CreateExternalAgentDialog })));

/** The Members page's add-agent dialogs (useAddAgentActions): the same ones the sidebar's + menu opened. */
export function MembersAddAgentDialogs({ step, onStep }: { step: AddAgentStep; onStep: (step: AddAgentStep) => void }) {
  const close = useCallback(() => onStep(null), [onStep]);
  if (step === "create") return <CreateAgentDialog onClose={close} />;
  if (step === "external") return <CreateExternalAgentDialog onClose={close} />;
  if (step === "handoff") return <HandoffDialog onClose={close} />;
  return null;
}
