import { useIntl } from "react-intl";
import { Check, Info } from "lucide-react";
import { Button, Popover, PopoverContent, PopoverDescription, PopoverTrigger } from "@botiverse/raft-ui";
import { HIGHLIGHT_VALUES, PRO_HIGHLIGHTS } from "../billing/proHighlights";

/**
 * What Pro adds, on Plan & billing's Upgrade to Pro card: the upgrade dialog's own list,
 * so the two never differ (#proj-commercial:#28). An item whose name doesn't say what it
 * is gets an info icon with that sentence (cindyz, #proj-commercial:ba39bee1). It is a
 * popover, not a tooltip, as the agent context's Verified mark: hover opens it with a
 * mouse and a tap opens it on a touch screen, where a tooltip never shows (raft-design
 * Tooltip, Accessibility). The dialog shows no such icon.
 */
export function ProBenefitList() {
  const { formatMessage } = useIntl();
  return (
    <ul className="grid gap-x-6 gap-y-2 text-callout text-foreground sm:grid-cols-2">
      {PRO_HIGHLIGHTS.map((highlight) => (
        <li key={highlight.key} className="flex items-start gap-2" data-testid={`billing-upgrade-benefit-${highlight.key}`}>
          <span className="flex h-[1lh] shrink-0 items-center">
            <Check size={16} className="text-success-strong" aria-hidden="true" />
          </span>
          <span className="flex min-w-0 items-center gap-1">
            {formatMessage({ id: highlight.pro }, HIGHLIGHT_VALUES)}
            {"note" in highlight ? (
              // One text line tall (as the check mark's box), so the 34px button (the DS tap size)
              // overflows it evenly and the row is as tall as the rows without an icon.
              <span className="flex h-[1lh] shrink-0 items-center">
                <Popover>
                  <PopoverTrigger
                    openOnHover
                    delay={200}
                    render={(
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-md"
                        className="text-foreground-hint hover:text-foreground"
                        aria-label={formatMessage({ id: highlight.note })}
                        data-testid={`billing-upgrade-benefit-${highlight.key}-info`}
                      />
                    )}
                  >
                    <Info aria-hidden="true" />
                  </PopoverTrigger>
                  <PopoverContent className="w-[300px] max-w-[calc(100vw-16px)] p-4" aria-label={formatMessage({ id: highlight.pro }, HIGHLIGHT_VALUES)}>
                    <PopoverDescription>{formatMessage({ id: highlight.note })}</PopoverDescription>
                  </PopoverContent>
                </Popover>
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
