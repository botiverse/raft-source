import { Suspense } from "react";
import type { ComponentProps } from "react";
import { deferredPanel } from "../../../boot/deferredUi";
import SettingsSidebarList from "../../../components/settings/SettingsSidebarList";
import { useServerStore } from "../../../store/serverStore";
import type { SettingsSearch as SettingsSearchComponent } from "./SettingsSearch";
import { useSettingsSearching } from "./settingsSearchStore";

type SettingsSearchProps = ComponentProps<typeof SettingsSearchComponent>;

// Search settings shows only in the Settings rail, and its index (every
// setting's copy, in every language) is large, so it is deferred
// (boot/deferredUi): fetched after the first screen, normally in before
// anyone opens Settings.
const LazySettingsSearch = deferredPanel(() => import("./SettingsSearch").then((module) => ({ default: module.SettingsSearch })));

/** While Search settings loads: its row's place held, so the rail's scrollbar starts below it. */
function SettingsSearchFieldLoading({ mobileInline = false }: { mobileInline?: boolean }) {
  return <div aria-hidden="true" className={`sticky top-0 z-chrome h-[calc(var(--control-height)+12px)] ${mobileInline ? "bg-layer-canvas" : "bg-layer-sidebar"}`} data-testid="settings-search-loading" />;
}

/**
 * SettingsSearch, its code deferred: the Settings rail's search field over the
 * list of pages. The list is drawn here, outside the Suspense, and stays
 * mounted when the chunk arrives: drawn once in the fallback and again by
 * SettingsSearch, every row became a new element then, so a row clicked
 * before it lost its focus (#triage:1e8883b7). With a query the chunk's
 * results take the list's place, as before. If the chunk fails, its Try again
 * shows in the field's place and the list still works.
 */
export function SettingsSearch(props: SettingsSearchProps) {
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const searching = useSettingsSearching(serverSlug);
  return (
    <>
      <Suspense fallback={<SettingsSearchFieldLoading mobileInline={props.mobileInline} />}>
        <LazySettingsSearch {...props} />
      </Suspense>
      {searching ? null : <SettingsSidebarList groups={props.groups} activeId={props.activeId} />}
    </>
  );
}
