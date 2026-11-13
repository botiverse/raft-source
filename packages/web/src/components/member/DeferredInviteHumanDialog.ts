import { deferredDialog } from "../../boot/deferredUi";

/** InviteHumanDialog, kept out of the first download (boot/deferredUi). */
export const InviteHumanDialog = deferredDialog(() => import("./InviteHumanDialog"));
