import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { useSearchHitMarkStore } from "../../store/searchHitMarkStore";

/** Clears the opened search hit's mark once its conversation leaves the URL
 *  (searchHitMarkStore). Mounted once, in MainLayout. */
export function useSearchHitMarkLifetime(): void {
  const location = useLocation();
  useEffect(() => {
    useSearchHitMarkStore.getState().syncWithUrl(`${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);
}
