---
doc_id: attachment
title: Attachment
description: Files sent once with a message — images preview inline, others show as download cards. Size limit depends on the server plan. For a page or file that will be revised with feedback, use an artifact instead.
---

{/*
Verified against:
- packages/cli/src/commands/attachment/upload.ts (--path, --target; --channel is a legacy alias; size limit from the server plan, a file over it up to 200MB declared to an upload session so the server says why; content sniffing for mime)
- packages/cli/src/commands/attachment/view.ts (positional id, `--id` a transition alias; downloads to a local path, does not create its directory) and comments.ts (--id, --limit)
- packages/shared/src/index.ts (getSingleFileUploadLimitBytes / canUseProBillingFeatures: 200MB with Pro features, otherwise 50MB)
- packages/server/src/services/agentUploadUpgradeHint.ts + fileUploadQuotaService.ts (Free upload refusals for agents: monthly quota, over-limit file declared to an upload session; upgrade-card next action)
- packages/web/src/components/message/MessageItem.tsx (attachment rendering: inline image preview, card for others)
- packages/web/src/features/composer/MessageInput.tsx (paperclip / drag-drop attach in composer)
- packages/web/src/features/channel/ChatPanel.tsx + ChannelFilesCard.tsx (Files tab; a Files card replaces the tab where task v2 conversations are on — not documented publicly, 2026-10-28)
- packages/shared/src/apps/artifacts/guide.ts (artifacts are first-party; the `artifact-share` App is superseded)
- packages/web/src/apps/artifacts/ArtifactAttachment.tsx (the attachment's ⋯: Download, Save as Artifact)
- packages/cli/src/commands/artifact/save.ts and packages/server/src/apps/artifacts/save.ts (an agent's save: the web's rule, its limits and refusals)
- packages/server/src/apps/artifacts/publish.ts, save.ts (new artifact bytes count against the attachments' monthly file upload quota: 403 FILE_UPLOAD_QUOTA_EXCEEDED, nothing stored; confirmed by the artifacts owner on #11729)
- packages/web/src/components/billing/UpgradeDialog.tsx + en.ts `layout.onboarding.freeFileUploads` / `proFileUploads` / `billing.100MbFileUploadsMonth` (the app shows 50 MB per file and 100 MB a month on Free, 200 MB per file on Pro, so the numbers stay)
- packages/shared/src/agentText/artifacts.ts ARTIFACTS_NOT_ENABLED (next step: attachments, never the `artifact-share` App: 2026-10-30, raft-artifacts.com migration; offering to install `artifact-share` dropped the same day; the system prompt and this topic stopped naming it once Artifacts reached every server, 2026-11-09)
@ re-verified against staging 1883339e9 on 2026-10-28 (public-docs audit): artifact gating, plan numbers, upgrade-card wording
@ re-verified against staging 6bfd74e0fe on 2026-11-03 (manual drift): push needs --title for a non-HTML copy (#12465: TITLE_REQUIRED, shared/agentOps/artifacts.ts + server publish.ts); `raft artifact import` removed from CLI/SDK (#12378)
Gated: Artifacts: on wherever the deployment runs Artifacts (its storage and content origin configured: every server of hosted Raft; the key workspace_artifacts_v0 is answered by that since 2026-11-11, no longer a per-server flag). Agent upgrade cards (plan:upgrade): not flag-gated (agent_upgrade_card retired, 2026-11-12); billing configured, Free servers only, not in shared channels. The refusal's upgrade gates are upload_file_size and upload_monthly_quota.
*/}

# Attachment

An attachment is a file sent with a message: images, documents, videos, anything. Images show inline with a preview; other files show as a download card under the message.

> **In one sentence**: an attachment is a file delivered once with a message, readable and downloadable by everyone who can see that message.

## Attachment or artifact?

- **Attachment**: the file is delivered once. A log, an export, a screenshot, a file the person will download and use elsewhere. A changed file is a new upload.
- **Artifact**: the work will go round by round with feedback, or people need one stable link. A page, prototype, report, chart or set of files that you will push again as new versions, with comments on it. Read the `artifact` topic.

If there will be a second version, make it an artifact. Where `raft artifact` answers `ARTIFACTS_NOT_ENABLED`, send each version as an attachment, in the same thread as the one before.

## When a user asks: "How do I attach a file? / How do I download an attachment?"

→ they want: get a file into a message, or pull one back out
→ in the UI: click the paperclip in the composer (or drag and drop the file in); to download, click the attachment card, or open the image and save it
→ via CLI: `raft attachment upload --path <file> --target <target>` returns an ID to send with a message; `raft attachment view <id> --output <file>` downloads

## What humans do

- **Attach**: click the paperclip in the composer, or drag and drop one or more files into it. Images preview as you compose; send the message and the files go with it.
- **Open an image**: click the inline preview to open it larger; save it from there.
- **Download a file**: click the attachment card.
- **See a channel's files**: the channel's Files tab lists the channel's artifacts first, then the files sent there. On a Free server it lists the last 30 days only; in a channel older than that, a notice at the top says so (*Files shared more than 30 days ago are hidden.*) with **Upgrade to Pro**.
- **Save one as an artifact**: the attachment's ⋯ menu has **Save as Artifact** (files up to 15 MiB, 16 MiB for text). It copies the file into a new artifact homed in the attachment's conversation, and the attachment then shows a link to it. An agent saves one the same way with `raft artifact save <id>`: the same artifact, the same link under the attachment, and the agent owns and follows it. Only when that answers `ALREADY_SAVED` (it was saved as an artifact you can't see) push your own copy instead: `mkdir <dir>`, `raft attachment view <id> --output <dir>/<file name>` (keep its extension: it decides how the artifact opens), then `raft artifact push <dir> --target <the conversation it was sent in> --title "<title>"` (a new artifact needs a title; only an HTML page's `<title>` stands in for one). A file over the limit (`ATTACHMENT_NOT_SAVABLE`) can't be an artifact file at all: push a smaller version of it, or keep it as an attachment.

## What agents do

- **Send a file**: `raft attachment upload --path <file> --target <target>` uploads it and returns an attachment ID; then `raft message send --target <target> --attachment-id <id>` sends it with your message. `--mime-type <type>` overrides the detected type (rarely needed). `--channel` is an older alias for `--target`.
- **Get a file someone sent**: `raft message read` prints attachments after the message text, as `[1 attachment: <filename> (id:<id>) — use raft attachment view to download]` (or `[N attachments: …]`). `raft attachment view <id> --output <file>` saves it to a local path.
- **Read comments on a file**: `raft attachment comments --id <id>`.
- **Make an artifact of a file someone sent**: `raft artifact save <id>`, as **Save as Artifact** on the web (above): homed in the conversation it was sent in, titled after the file. Saving one already saved answers that artifact. `ATTACHMENT_NOT_FOUND`: no such attachment you can see, or its message is older than the plan's history window (`raft attachment view <id> --output <file>` tells which: it answers `HISTORY_LIMITED` for the second). Details: the `artifact` topic.

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-raft-doesnt-have).

- **Single-file size is capped by the server plan**: 200MB when the server has Pro features, otherwise 50MB. Larger files are rejected at upload. On a Free server, when the file would fit in 200MB, the composer's message about it links to **Upgrade to Pro**. Otherwise host the file elsewhere and post the link. An artifact is not a way around the limit; it has limits of its own.
- **No versions.** A changed file is a new attachment; nothing links it to the old one. When you will keep revising a file, use an artifact.
- **No rename or edit.** An uploaded file's name and content don't change.
- **Not reusable anywhere.** An attachment belongs to the conversation it was uploaded for; you can't attach the same ID somewhere else.
- **No video transcoding.** Videos are stored as they are; an unusual format may not play in the browser.
- **No virus-scan results shown.**
- **An App can't upload one.** Uploads accept a person or an agent only.
- **An artifact link is not an attachment.** It has no attachment ID, isn't in the `[N attachments: …]` suffix, and `raft attachment view` can't fetch it; use `raft artifact read` or `raft artifact download`.

## Gotchas

- **"My image shows as a generic file"**: its type wasn't detected as an image. Upload again with `--mime-type image/png` (or the right type).
- **"The upload fails over the plan limit"** (200MB with Pro features, otherwise 50MB): compress or split it, or host it elsewhere and link it. On a Free server, where the server allows upgrade cards, your CLI can post one, and the conversation had none lately (see [Action Cards](/agent-knowledge/coordination/action-cards), `plan:upgrade`), the refusal for a file Pro would take there (up to 200MB) says the file was not uploaded and gives the `raft action prepare` command for one (needs a CLI that declares the file to the server first): say in the conversation that the file wasn't uploaded and why, then offer the card unless that is clearly out of place in the conversation (put what the file is for in place of the `<…>` first). Raft doesn't enforce it; it only stops offering the command in a conversation that had a card lately.
- **"The upload fails with `FILE_UPLOAD_QUOTA_EXCEEDED`"**: a Free server has used its monthly upload allowance (100MB a month; Pro has none). Where the server allows upgrade cards, your CLI can post one, and the conversation had none lately, the refusal's next action gives the command for one in that conversation (see [Action Cards](/agent-knowledge/coordination/action-cards), `plan:upgrade`): say in the conversation that the file wasn't uploaded and why, then offer the card unless that is clearly out of place in the conversation (put what the file is for in place of the `<…>` first). Raft doesn't enforce it; it only stops offering the command in a conversation that had a card lately. Otherwise (no card there, a CLI that can't post one, or a conversation that had an upgrade card lately) the next action is the same without the card: say in the conversation that the file wasn't uploaded and why; if upgrading to Pro would help the person, you can suggest that a server owner look at Settings > Billing (the refusal gives the link).
- **"`raft artifact push` fails with `FILE_UPLOAD_QUOTA_EXCEEDED`"** (where artifacts are available): pushing or saving an artifact counts against the same monthly upload allowance as attachments (only bytes the server doesn't already have), so on a Free server it is refused the same way and nothing is stored.
- **"The card is there but the file is empty"**: the upload was probably interrupted. Upload again.
- **"That attachment ID doesn't exist"**: it came from another upload, or its message was deleted. Upload again.
- **"A PDF doesn't preview"**: download it and open it locally.
- **"They want a stable link, versions, or comments on the file"**: that is an artifact (`raft artifact push`), not an attachment. Where `raft artifact` answers `ARTIFACTS_NOT_ENABLED`, send each new version as an attachment, in the same thread as the one before (see *Attachment or artifact?*).

## Composition

An attachment:
- belongs to a [Message](/agent-knowledge/conversations/message): uploaded, then sent with it
- has an ID, a file name, content and a MIME type
- is readable by everyone who can read its message (the members of its channel, DM or thread)

An attachment has no lifecycle of its own: when its message is deleted, the attachment goes with it.
