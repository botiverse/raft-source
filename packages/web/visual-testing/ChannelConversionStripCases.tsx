import { ChannelConversionStatus } from "../src/components/channel/ChannelConversionStrip";
import type { ChannelConversionController } from "../src/components/channel/useChannelConversionController";

// A channel being made an external channel (components/channel/ChannelConversionStrip.tsx):
// the strip at the top of the conversation, from a fixture controller (no
// server), in a conversation column of the case's width with a stand-in header
// above it and a few message lines under it. View's popover and Cancel's
// confirmation open from the strip (the capture clicks them).
// `.running`: 45%, a desktop-wide conversation. `.dark`: the same in the dark theme.
// `.phone` / `.phone-360`: 390px and 360px windows, where the bar gives way.
// `.long-name-zh`: zh-CN with a long Chinese channel name in the header.
// `.complete`: 100%, three digits. `.failed`: the PanelNotice with Retry.

export const CHANNEL_CONVERSION_STRIP_CASE_IDS = [
  "components.channel.conversion-strip.running",
  "components.channel.conversion-strip.running.dark",
  "components.channel.conversion-strip.phone",
  "components.channel.conversion-strip.phone-360",
  "components.channel.conversion-strip.long-name-zh",
  "components.channel.conversion-strip.complete",
  "components.channel.conversion-strip.failed",
] as const;

const LONG_ZH_NAME = "产品设计与工程协作讨论频道-二零二六年第四季度跨团队发布计划";
const noop = () => {};

type Conversion = Parameters<typeof ChannelConversionStatus>[0]["conversion"];

function conversionFor(caseId: string): Conversion {
  const failed = caseId.endsWith(".failed");
  const phase = caseId.endsWith(".complete") ? "done" : "move_parent_messages";
  return {
    job: {
      id: "visual-job",
      status: failed ? "failed" : "running",
      phase,
      progress: {},
      error: failed ? "Verifying history found 3 messages that didn't copy." : null,
      canCancel: true,
    } as NonNullable<ChannelConversionController["job"]>,
    admissionPending: false,
    connectionWarning: false,
    observationSettled: false,
    error: failed ? "Verifying history found 3 messages that didn't copy." : undefined,
    retryBusy: false,
    cancelBusy: false,
    retry: noop,
    cancel: async () => {},
    checkStatus: undefined,
  };
}

export function ChannelConversionStripCase({ caseId }: { caseId: string }) {
  const phone = caseId.includes(".phone") || caseId.includes(".long-name-zh");
  const width = caseId.endsWith(".phone-360") ? 360 : phone ? 390 : 800;
  const channelName = caseId.includes(".long-name-zh") ? LONG_ZH_NAME : "launch-week";
  return (
    <main className="min-h-screen bg-layer-canvas font-display text-foreground">
      <div data-visual-case={caseId} className="flex h-[360px] flex-col border-e border-line-seam bg-layer-canvas" style={{ width }}>
        <div className="flex h-12 shrink-0 items-center border-b border-line-seam ps-4 pe-2 md:ps-5">
          <span className="min-w-0 truncate text-headline font-bold">#{channelName}</span>
        </div>
        <ChannelConversionStatus channelName={channelName} conversion={conversionFor(caseId)} />
        <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 px-4 pb-4 text-callout text-foreground-muted md:px-5">
          <p className="m-0">Mira: Shipping the beta on Thursday.</p>
          <p className="m-0">Wug: The release notes are drafted.</p>
        </div>
      </div>
    </main>
  );
}
