import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const PUSH_NOTIFICATION_NAVIGATE_MESSAGE = "RAFT_PUSH_NOTIFICATION_NAVIGATE";

export function serviceWorkerNavigationPath(input: unknown, origin = window.location.origin): string | null {
  if (!input || typeof input !== "object") return null;
  const data = input as { type?: unknown; url?: unknown };
  if (data.type !== PUSH_NOTIFICATION_NAVIGATE_MESSAGE || typeof data.url !== "string") return null;

  try {
    const url = new URL(data.url, origin);
    if (url.origin !== origin) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export default function ServiceWorkerNavigationBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const handleMessage = (event: MessageEvent) => {
      const path = serviceWorkerNavigationPath(event.data);
      if (!path) return;
      navigate(path);
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleMessage);
    };
  }, [navigate]);

  return null;
}
