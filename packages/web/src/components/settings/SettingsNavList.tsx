import { useIntl } from "react-intl";
import { SETTINGS_GROUPS, SETTINGS_TAB_NAV_LABEL_ID } from "./settingsNavigation";
import type { SettingsTabId } from "./settingsNavigation";

// Pure presentational settings-nav sidebar. Extracted from WorkspaceSettingsModal
// so the desktop nav's label localization can be exercised in a DOM test WITHOUT
// mounting SettingsPanel (whose account-tab content reads the Vite-only
// `import.meta.env.DEV` graph the node harness can't shim). It consumes the SAME
// production `SETTINGS_TAB_NAV_LABEL_ID` map + `formatMessage` the modal uses —
// there is no test-only path here.
export default function SettingsNavList({
  activeTab,
  hiddenTabIds,
  onSelect,
}: {
  activeTab: SettingsTabId;
  hiddenTabIds?: ReadonlySet<SettingsTabId>;
  onSelect: (id: SettingsTabId) => void;
}) {
  const { formatMessage } = useIntl();
  return (
    <aside
      className="flex w-[220px] shrink-0 flex-col border-r border-black/25 bg-brutal-cream"
      aria-label={formatMessage({ id: "settings.tabs.navAriaLabel" })}
      data-testid="workspace-settings-navigation"
    >
      <div className="flex h-panel-header shrink-0 items-center border-b border-black/25 px-4 text-base font-bold">
        {formatMessage({ id: "settings.tabs.navTitle" })}
      </div>
      <nav className="min-h-0 flex-1 px-2 py-3">
        {SETTINGS_GROUPS.map((group) => (
          <section key={group.key} className="mb-4 last:mb-0">
            <div className="mb-1 px-2 text-[10px] font-bold uppercase tracking-widest text-black/45">
              {formatMessage({ id: group.labelId })}
            </div>
            <div className="space-y-0.5">
              {group.items.filter((item) => !hiddenTabIds?.has(item.id)).map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                const navLabel = formatMessage({ id: SETTINGS_TAB_NAV_LABEL_ID[item.id] });
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`flex h-9 w-full items-center gap-2 px-2 text-left text-sm font-medium outline-none transition-colors ${active ? "bg-soft-signal font-bold" : "hover:bg-black/[0.06]"} focus-visible:outline focus-visible:outline-1 focus-visible:outline-black`}
                    aria-current={active ? "page" : undefined}
                    data-testid={`workspace-settings-nav-${item.id}`}
                    onClick={() => onSelect(item.id)}
                  >
                    <Icon size={15} className="shrink-0" />
                    <span className="truncate">{navLabel}</span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </nav>
    </aside>
  );
}
