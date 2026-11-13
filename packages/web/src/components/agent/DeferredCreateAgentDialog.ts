import { deferredDialog } from "../../boot/deferredUi";

/** CreateAgentDialog, kept out of the first download (boot/deferredUi). */
export const CreateAgentDialog = deferredDialog(() => import("../../features/agent/CreateAgentDialog").then((module) => ({ default: module.CreateAgentDialog })));
