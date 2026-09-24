import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { useImageLightboxStore } from "../src/store/imageLightboxStore";

describe("imageLightboxStore", () => {
  beforeEach(() => {
    useImageLightboxStore.getState().close();
  });

  it("openImage() opens a single direct-URL image (no attachment fetch needed)", () => {
    useImageLightboxStore.getState().openImage("/avatars/users/abc.webp", "Yingjun");
    const s = useImageLightboxStore.getState();
    assert.equal(s.isOpen, true);
    assert.equal(s.currentIndex, 0);
    assert.equal(s.images.length, 1);
    const img = s.images[0];
    assert.equal(img.directUrl, "/avatars/users/abc.webp");
    assert.equal(img.filename, "Yingjun");
    // A directUrl image carries no real attachment id, so the lightbox must not
    // attempt the `/attachments/{id}/url` fetch for it.
    assert.ok(img.directUrl, "directUrl must be set so the fetch is skipped");
  });

  it("close() resets open state", () => {
    useImageLightboxStore.getState().openImage("/avatars/users/abc.webp", "Yingjun");
    useImageLightboxStore.getState().close();
    const s = useImageLightboxStore.getState();
    assert.equal(s.isOpen, false);
    assert.deepEqual(s.images, []);
    assert.equal(s.currentIndex, 0);
  });

  it("openImage() is single-image: next/prev stay put", () => {
    useImageLightboxStore.getState().openImage("/avatars/users/abc.webp", "Yingjun");
    useImageLightboxStore.getState().next();
    assert.equal(useImageLightboxStore.getState().currentIndex, 0);
    useImageLightboxStore.getState().prev();
    assert.equal(useImageLightboxStore.getState().currentIndex, 0);
  });
});
