import { deferredModule } from "../boot/deferredUi";

/**
 * The image lightbox's code (the stage, zoom and the comment margin), off the
 * first download (boot/deferredUi): it opens from a click on an image, so it
 * is fetched after the first screen and is normally in before anyone opens
 * one. One loader for ImageLightboxHost's dialog and its "loaded yet" check.
 */
export const loadImageLightbox = deferredModule(() => import("./ImageLightbox"));
