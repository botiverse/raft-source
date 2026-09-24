import { useCallback, useEffect, useRef } from "react";

/**
 * Downloads blobs without guessing when the browser has consumed an object
 * URL. Each mounted owner retains at most one URL: the next user-initiated
 * download releases the previous one, and unmount releases the final one.
 */
export function useBlobDownload() {
  const currentUrlRef = useRef<string | null>(null);

  const revokeCurrentUrl = useCallback(() => {
    if (currentUrlRef.current === null) return;
    URL.revokeObjectURL(currentUrlRef.current);
    currentUrlRef.current = null;
  }, []);

  useEffect(() => revokeCurrentUrl, [revokeCurrentUrl]);

  return useCallback((blob: Blob, filename: string) => {
    revokeCurrentUrl();
    const url = URL.createObjectURL(blob);
    currentUrlRef.current = url;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    try {
      anchor.click();
    } catch (error) {
      revokeCurrentUrl();
      throw error;
    }
  }, [revokeCurrentUrl]);
}
