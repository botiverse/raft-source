import { deferredDialog } from "../../boot/deferredUi";

/** CreateChannelDialog, kept out of the first download (boot/deferredUi). */
export const CreateChannelDialog = deferredDialog(() => import("./CreateChannelDialog"));
