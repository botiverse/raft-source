import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ackTestNotification } from "../../notifications/notificationApi";
import { startWebPushLifecycle } from "../../notifications/webPushLifecycle";
import { createNotificationShownAcker } from "../../notifications/webPushTestAck";
import { useAuthStore } from "../../store/authStore";
import { clientDisplayModeMessage, serviceWorkerNavigationPath } from "../../notifications/webPushServiceWorkerMessages";

export default function ServiceWorkerNavigationBridge() {
  const navigate = useNavigate();
  const signedInUserId = useAuthStore((state) => state.user?.id ?? null);

  // A notification click routes this window in-app (no reload, state kept).
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

  // A test notification the worker displayed (or failed to): ack it once.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const ackOnce = createNotificationShownAcker(ackTestNotification);
    const handleMessage = (event: MessageEvent) => {
      ackOnce(event.data);
    };
    navigator.serviceWorker.addEventListener("message", handleMessage);
    return () => {
      navigator.serviceWorker.removeEventListener("message", handleMessage);
    };
  }, []);

  // The push subscription's upkeep needs a session: its requests are the user's.
  useEffect(() => {
    if (!signedInUserId) return;
    return startWebPushLifecycle();
  }, [signedInUserId]);

  // Tell the worker whether this window is the installed app, so a notification
  // click can come back to it. Re-sent when the mode changes or a new worker takes over.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const announce = () => {
      void navigator.serviceWorker.ready
        .then((registration) => registration.active?.postMessage(clientDisplayModeMessage(window)))
        .catch(() => {});
    };
    announce();
    const standaloneQuery = window.matchMedia?.("(display-mode: standalone)");
    standaloneQuery?.addEventListener?.("change", announce);
    navigator.serviceWorker.addEventListener("controllerchange", announce);
    return () => {
      standaloneQuery?.removeEventListener?.("change", announce);
      navigator.serviceWorker.removeEventListener("controllerchange", announce);
    };
  }, []);

  return null;
}
