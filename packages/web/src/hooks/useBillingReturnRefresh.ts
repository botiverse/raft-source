import { useCallback, useEffect, useRef } from "react";
import { useServerStore } from "../store/serverStore";

/**
 * In Raft Desktop, Stripe checkout and the billing portal open in the system
 * browser, so this page stays mounted with the billing it loaded. The
 * server pushes `server:plan-updated` once Stripe's webhook lands, and the
 * socket bridge refetches then. This is the backstop for a missed or late
 * push: after `noteStripeOpened()`, every return to this window (focus, or the
 * tab becoming visible) refetches billing and usage — every return, not only
 * the first, because people switch back mid-payment. Reading the billing also
 * makes the server re-read the subscription from Stripe.
 */
export function useBillingReturnRefresh(): () => void {
  const openedRef = useRef(false);

  useEffect(() => {
    const refresh = () => {
      if (!openedRef.current || document.visibilityState === "hidden") return;
      const store = useServerStore.getState();
      void store.loadBilling();
      void store.loadUsage();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return useCallback(() => {
    openedRef.current = true;
  }, []);
}
