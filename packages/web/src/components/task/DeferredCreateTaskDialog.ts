import { deferredDialog } from "../../boot/deferredUi";

/** CreateTaskDialog (New task, Create task from a message), kept out of the first download (boot/deferredUi). */
export const CreateTaskDialog = deferredDialog(() => import("./CreateTaskDialog"));
