import { Textarea, Card, Button } from "@botiverse/raft-ui";
import { useCallback } from "react";
import { Trash2 } from "lucide-react";
import { useIntl } from "react-intl";
import FormField from "../ui/FormField";
import SectionEyebrow from "../ui/SectionEyebrow";
import SlugInput from "../ui/SlugInput";
import type { JointInviteDraft, JointInviteDraftUpdate } from "./CreateJointChannelDialog";
import { SameAdminJointNotice } from "./SameAdminJointNotice";

export function JointInviteDraftCard({
  draft,
  index,
  canRemove,
  submitting,
  sameAdminTarget,
  sourceServerName,
  onUpdate,
  onRemove,
}: {
  draft: JointInviteDraft;
  index: number;
  canRemove: boolean;
  submitting: boolean;
  sameAdminTarget: { name: string } | null;
  sourceServerName: string;
  onUpdate: (id: string, updates: JointInviteDraftUpdate) => void;
  onRemove: (id: string) => void;
}) {
  const { formatMessage } = useIntl();
  const draftId = draft.id;
  const handleRemove = useCallback(() => onRemove(draftId), [onRemove, draftId]);
  // A confirmation covers the target and people it was given for; editing
  // either asks again.
  const handleSlugChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => onUpdate(draftId, { targetServerSlug: event.target.value, sameAdminConfirmed: false }),
    [onUpdate, draftId],
  );
  const handleInvitedPeopleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => onUpdate(draftId, { invitedPeopleText: event.target.value, sameAdminConfirmed: false }),
    [onUpdate, draftId],
  );
  const handleSameAdminConfirmedChange = useCallback(
    (confirmed: boolean) => onUpdate(draftId, { sameAdminConfirmed: confirmed }),
    [onUpdate, draftId],
  );

  return (
    // One server invite = one inset card (DS card: surface, hairline). Removing
    // a draft is local and reversible, so it is a quiet icon button, not red.
    <Card className="stack-y-3 p-3">
      <div className="flex items-center justify-between gap-3">
        <SectionEyebrow as="div" tone="muted">
          {formatMessage({ id: "channel.createJoint.serverInviteIndex" }, { n: index + 1 })}
        </SectionEyebrow>
        {canRemove && (
          <Button size="icon-md"
            variant="ghost"
            type="button"
            onClick={handleRemove}
            disabled={submitting}
            aria-label={formatMessage({ id: "channel.createJoint.removeServerInvite" }, { n: index + 1 })}
          >
            <Trash2 size={18} aria-hidden="true" />
          </Button>
        )}
      </div>
      <FormField label={formatMessage({ id: "channel.edit.serverSlugLabel" })} required>
        <SlugInput
          type="text"
          value={draft.targetServerSlug}
          onChange={handleSlugChange}
          placeholder="partner-workspace"
          required
        />
      </FormField>
      <FormField
        label={formatMessage({ id: "channel.edit.invitedPeopleLabel" })}
        required
        // Kept (access): only the target server's owners or admins can accept; without it people enter the wrong handles.
        hint={formatMessage({ id: "channel.edit.invitedPeopleHint" })}
      >
        <Textarea
          value={draft.invitedPeopleText}
          onChange={handleInvitedPeopleChange}
          className="w-full"
          placeholder={formatMessage({ id: "channel.edit.invitedPeoplePlaceholder" })}
          rows={2}
          required
        />
      </FormField>
      {sameAdminTarget && (
        <SameAdminJointNotice
          sourceServerName={sourceServerName}
          targetServerName={sameAdminTarget.name}
          confirmed={draft.sameAdminConfirmed === true}
          onConfirmedChange={handleSameAdminConfirmedChange}
          disabled={submitting}
        />
      )}
    </Card>
  );
}
