import { useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import {
  ListRow,
  ListRowBody,
  ListRowDescription,
  ListRowTitle,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "@botiverse/raft-ui";
import type { LinkOpenPreference } from "../../store/linkOpenPreference";
import { useLinkOpenPreference, writeLinkOpenPreference } from "../../store/linkOpenPreference";
import { canOpenInDesktopApp } from "../../utils/desktopAppLink";
import { useDeepLinksFlag } from "./deepLinksFlag";

/**
 * Deep links v1: Settings › Appearance › How links open. The proposal's
 * "Settings › General" has no tab of its own here; Appearance is where this
 * app keeps the rows saved on this device. Only in a desktop browser (the
 * choice is about Raft Desktop on this computer) and only with the flag on.
 */
export default function HowLinksOpenSetting() {
  const [desktopBrowser] = useState(() => canOpenInDesktopApp());
  const flag = useDeepLinksFlag();
  if (!desktopBrowser || !flag.enabled) return null;
  return <HowLinksOpenRow />;
}

function HowLinksOpenRow() {
  const { formatMessage } = useIntl();
  const preference = useLinkOpenPreference();
  const items = useMemo(() => [
    { value: "ask" as const, label: formatMessage({ id: "settings.howLinksOpen.ask" }) },
    { value: "app" as const, label: formatMessage({ id: "settings.howLinksOpen.app" }) },
    { value: "web" as const, label: formatMessage({ id: "settings.howLinksOpen.web" }) },
  ], [formatMessage]);
  const handleChange = useCallback((value: LinkOpenPreference | null) => {
    if (value) writeLinkOpenPreference(value);
  }, []);

  return (
    // A settings row (DS Forms › A setting's row; Jasper + cindyz, #triage:c95a5e53): the
    // select ends the row, and goes under the text where the row is under 32rem wide (the
    // Appearance group's container query). On a wide row it is as wide as its longest option
    // (`fit`, 11-20rem).
    <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap" data-testid="how-links-open-setting">
      <ListRowBody>
        <ListRowTitle id="how-links-open-setting-label">
          {formatMessage({ id: "settings.howLinksOpen.title" })}
        </ListRowTitle>
        <ListRowDescription id="how-links-open-setting-description" wrap>
          {formatMessage({ id: "settings.howLinksOpen.description" })}
        </ListRowDescription>
        <span className="text-caption text-foreground-hint">
          {formatMessage({ id: "settings.howLinksOpen.savedInBrowser" })}
        </span>
      </ListRowBody>
      <div className="shrink-0 @max-lg:basis-full">
        <Select<LinkOpenPreference> value={preference} onValueChange={handleChange} items={items}>
          <SelectTrigger
            fit
            className="@max-lg:w-full @max-lg:max-w-sm"
            aria-labelledby="how-links-open-setting-label"
            aria-describedby="how-links-open-setting-description"
            data-testid="how-links-open-select"
          >
            <SelectValue />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectList>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  <SelectItemText>{item.label}</SelectItemText>
                  <SelectItemIndicator />
                </SelectItem>
              ))}
            </SelectList>
          </SelectContent>
        </Select>
      </div>
    </ListRow>
  );
}
