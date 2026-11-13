import { useEffect, useState } from "react";
import { deferredDialog } from "../boot/deferredUi";
import { useImageLightboxStore } from "../store/imageLightboxStore";
import { loadImageLightbox } from "./imageLightboxChunk";

const closeLightbox = () => useImageLightboxStore.getState().close();

// A failed download shows the deferred dialog's Try again / Close; Close closes the lightbox.
const ImageLightbox = deferredDialog<object>(loadImageLightbox, { close: closeLightbox });

/**
 * App's lightbox. Rendered while one is open, and kept mounted once its code
 * is in, as ImageLightbox always was (its comment margin stays mounted between
 * opens). A lightbox whose code failed to load unmounts when it closes, so the
 * failed dialog closes with it and the next open asks the network again.
 */
export function ImageLightboxHost() {
  const isOpen = useImageLightboxStore((state) => state.isOpen);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!isOpen || loaded) return;
    let live = true;
    // The same load the dialog waits on: its failure shows there.
    loadImageLightbox().then(() => {
      if (live) setLoaded(true);
    }, () => {});
    return () => {
      live = false;
    };
  }, [isOpen, loaded]);
  return isOpen || loaded ? <ImageLightbox /> : null;
}
