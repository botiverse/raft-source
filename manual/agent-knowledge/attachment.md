---
doc_id: attachment
title: Attachment
description: Files attached to messages — images preview inline, others show as download cards. Max 50MB per file.
---

{/*
Verified against:
- packages/cli/src/commands/attachment/upload.ts (--path, --channel required by v0 server, max 50MB, uses content sniffing for mime)
- packages/cli/src/commands/attachment/view.ts (--id, downloads to local path)
- packages/web/src/components/message/MessageItem.tsx (attachment rendering: inline image preview, card for others)
- packages/web/src/components/message/MessageInput.tsx (paperclip / drag-drop attach in composer)
@ verified against current staging head (re-verified during cohort review pass)
*/}

# Attachment

Attachments are files attached to messages — images, documents, videos, etc. Images render inline with previews; other file types show as download cards under the message.

> **In one sentence**: An attachment is a file you stuck on a message — uploaded once, viewable + downloadable by anyone with access to the message.

Max size is 50MB per attachment. Multiple attachments per message are supported. Content type is detected via content sniffing; explicit MIME type override is supported in the CLI but rarely needed.

## When a user asks: "How do I attach a file? / How do I download an attachment?"

→ they want: get a file into a message, or pull one back out
→ in the UI: click the paperclip in the composer (or drag-drop a file in); to download, click the attachment card or right-click the image preview
→ via CLI: `raft attachment upload --path <filepath> --channel <target>` returns an ID to include in a message; `raft attachment view --id <id>` downloads

## What humans do

**Attach a file to a message**
- Click the paperclip icon in the composer, OR drag-drop the file into the composer area
- File uploads — image previews inline as you compose, non-images show as cards
- Send the message; attachment goes with it

**View / open an attached image**
- Click the inline preview → opens in a lightbox / preview panel
- Right-click → save to disk

**Download an attached file** (non-image)
- Click the download icon on the attachment card → file saves to your downloads folder

**Multiple attachments**
- Attach more than one file at a time (drag-drop multiple, or paperclip multiple)
- They all post together as a single message

## What agents do

**Upload a file as an attachment**
- `raft attachment upload --path /path/to/file --channel <target>` — uploads from disk, returns an attachment ID. `--channel` is required by v0 server (until channel-less uploads land)
- Optional `--mime-type <type>` if content sniffing gets it wrong (rarely needed)
- Use the returned ID with `raft message send --attachment-id <id>` to attach it to a message

**View / download an attachment**
- `raft attachment view --id <attachment-id>` — downloads the file to a local path
- Useful for agents that need to process an attached image / doc the user sent

## What it CAN'T do

⚠️ **These were verified absent when written, and this list rots one way:** a feature that ships makes an entry wrong and nothing here turns red. ⇒ Before telling anyone a capability is missing, re-check it — `--help` on the relevant command family is usually enough. See [What Raft Doesn't Have](/agent-knowledge/cross-cutting/what-slock-doesnt-have).

- **Max 50MB per file.** Files larger than this are rejected at upload time. If a user needs to share something larger, the workaround is to host externally + link in the message.
- **No video transcoding.** Raft stores videos as-is; no in-browser playback transcoding for unusual formats.
- **No edit/rename of an uploaded attachment.** Once uploaded, the file's name and content are immutable.
- **No bulk-attachment management surface.** You can see attachments inline with their messages, but there's no global "Files" view of all attachments across a channel/server.
- **No virus scanning surfaced to the user.** Raft may scan internally but doesn't expose results in UI.
- **Attachment IDs are not reusable in arbitrary contexts.** An attachment uploaded for one message is tied to that channel scope; you can't reattach the same ID across arbitrary surfaces.

## Gotchas

- **"My image didn't preview inline — it shows as a generic file"**: the content type wasn't detected as an image. Try `--mime-type image/png` (or appropriate type) on upload.
- **"Upload fails over 50MB"**: that's the hard limit. Compress / split, or host externally and link.
- **"I can see the attachment card but the file is empty"**: the upload may have been interrupted. Re-upload.
- **"Agent referenced an attachment ID that doesn't exist"**: the ID might have been from a different upload session or the attachment was associated with a deleted message. Re-upload + re-reference.
- **"PDF preview is broken"**: Raft may not preview all PDFs inline; download to view in your local PDF reader if so.

## Composition

An Attachment:
- Belongs to a [Message](/agent-knowledge/conversations/message) (uploaded then referenced in send)
- Has an ID (returned at upload, used in `raft message send` references)
- Has a file (name + content + MIME type)
- Is viewable by anyone with read access to the parent message (= members of the parent channel/DM/thread)

Attachments don't have their own lifecycle separate from their parent message — if the message is deleted, the attachment goes with it. There's no standalone attachment-deletion path.
