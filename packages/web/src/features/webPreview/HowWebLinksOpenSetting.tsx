import { useCallback, useMemo } from "react";
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
import type { WebLinkOpenPreference } from "../../store/webLinkOpenPreference";
import { useWebLinkOpenPreference, writeWebLinkOpenPreference } from "../../store/webLinkOpenPreference";
import { useDesktopWebPreviewView } from "./useWebPreview";

/**
 * Settings › Appearance › How web links open: where a plain web link in a
 * message opens in Raft Desktop, beside the conversation or in the system
 * browser (store/webLinkOpenPreference.ts). Its own row, apart from How links
 * open, which is about Raft's own message links in a browser. Only in Raft
 * Desktop with its web preview view (desktop_web_preview_view_v0 and
 * raftDesktop.webPreview): a browser tab has no built-in browser to choose.
 * Until the person chooses, here or in the dialog the first click opens, the
 * select shows that the first click asks.
 */
export function HowWebLinksOpenSetting() {
  const view = useDesktopWebPreviewView();
  if (!view) return null;
  return <HowWebLinksOpenRow />;
}

function HowWebLinksOpenRow() {
  const { formatMessage } = useIntl();
  const preference = useWebLinkOpenPreference();
  const items = useMemo(() => [
    { value: "beside" as const, label: formatMessage({ id: "settings.howWebLinksOpen.beside" }) },
    { value: "browser" as const, label: formatMessage({ id: "settings.howWebLinksOpen.browser" }) },
  ], [formatMessage]);
  const handleChange = useCallback((value: WebLinkOpenPreference | null) => {
    if (value) writeWebLinkOpenPreference(value);
  }, []);

  return (
    // The same settings row as How links open (DS Forms › A setting's row): the select ends
    // the row and goes under the text where the row is under 32rem wide. The group's
    // "saved on this device" line under it covers this row too.
    <ListRow variant="plain" interactive={false} className="@max-lg:flex-wrap" data-testid="how-web-links-open-setting">
      <ListRowBody>
        <ListRowTitle id="how-web-links-open-setting-label">
          {formatMessage({ id: "settings.howWebLinksOpen.title" })}
        </ListRowTitle>
        <ListRowDescription id="how-web-links-open-setting-description" wrap>
          {formatMessage({ id: "settings.howWebLinksOpen.description" })}
        </ListRowDescription>
      </ListRowBody>
      <div className="shrink-0 @max-lg:basis-full">
        <Select<WebLinkOpenPreference> value={preference} onValueChange={handleChange} items={items}>
          <SelectTrigger
            className="w-64 @max-lg:w-full @max-lg:max-w-sm"
            aria-labelledby="how-web-links-open-setting-label"
            aria-describedby="how-web-links-open-setting-description"
            data-testid="how-web-links-open-select"
          >
            <SelectValue placeholder={formatMessage({ id: "settings.howWebLinksOpen.notChosen" })} />
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
