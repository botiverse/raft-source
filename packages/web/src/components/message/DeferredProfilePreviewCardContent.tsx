import { Suspense } from "react";
import type { ComponentProps } from "react";
import { deferredPanel } from "../../boot/deferredUi";
import type ProfilePreviewCardContentComponent from "./ProfilePreviewCardContent";

type ProfilePreviewCardContentProps = ComponentProps<typeof ProfilePreviewCardContentComponent>;

const DeferredContent = deferredPanel<ProfilePreviewCardContentProps>(() => import("./ProfilePreviewCardContent"));

/**
 * The profile hover card's content (a mention, a message avatar, a rack
 * slot, the migration log), off the first download (boot/deferredUi): a
 * hover opens it after the trigger's delay, and its code is normally
 * fetched in the background before then. A failed download shows Try again
 * in the card. Every card takes it from here: one static import elsewhere
 * would leave it no chunk of its own.
 */
export default function ProfilePreviewCardContent(props: ProfilePreviewCardContentProps) {
  return (
    <Suspense fallback={null}>
      <DeferredContent {...props} />
    </Suspense>
  );
}
