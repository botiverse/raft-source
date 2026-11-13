import { deferredDialog } from "../../boot/deferredUi";

/** SelectShareLightbox (a selection's image export preview), kept out of the first download (boot/deferredUi). */
export const SelectShareLightbox = deferredDialog(() => import("./SelectShareLightbox"));
