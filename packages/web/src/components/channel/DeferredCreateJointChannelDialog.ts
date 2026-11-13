import { deferredDialog } from "../../boot/deferredUi";

/** CreateJointChannelDialog, kept out of the first download (boot/deferredUi). */
export const CreateJointChannelDialog = deferredDialog(() => import("./CreateJointChannelDialog"));
