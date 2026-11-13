# features/composer

The message composer: the input under a channel, thread, DM, attachment
comments and the forward dialog. One component per file, named exports.

- Entry: `MessageInput.tsx` (`MessageInput`). Used by `features/channel/ChatPanel`,
  `features/thread/AuthenticatedThreadPanel`, the attachment comment panel and
  margin, and the forward composer (desktop and mobile).
- Parts: `SortableAttachment.tsx` (an attachment chip, drag to reorder),
  `ComposerFilePickers.tsx` (the two hidden file inputs),
  `UploadFailureBanner.tsx`, `RecoverableUploadCancelButton.tsx`.
- Shared here:
  - `draftPendingFilesCache.ts`: attachments and failed-send mentions kept per
    channel draft across remounts, cleared when the signed-in user changes
    (module-scope cache, subscribed to `authStore` on import).
  - `pendingMentionActions.ts`: notify/add results for mentions that did not
    reach anyone, and the failed-send draft helpers.
  - `pendingFilePreview.ts`, `composerTypes.ts` (`PendingFile`,
    `ComposerReference`), `composerPointerHandlers.ts`.
  - `composerSendKey.ts`: how the box sends, the account's choice
    (`user.composerSendKey`, #triage:#210): `composerEnterAction` is the one
    place that decides what Enter does (Enter or ⌘/Ctrl+Enter sends, never
    while an IME composes), plus `useComposerSendKey` / `saveComposerSendKey`.
    `ComposerSendKeyHint.tsx` is the toolbar's "⌘Enter to send" in that mode.
    The setting is `features/settings/appearance/ComposerSendKeySetting.tsx`.
- Still in `components/message/`: autocomplete (`autocompleteTriggers`,
  `mentionCandidates`, `useComposerAutosize`), `PendingMentionActionStrip`,
  `selectedTextQuote`, `senderMentionInsert`, `composerFocusRequest`,
  `composerHost`. They move here later.
- `MessageInput.tsx` is still one 2.6k-line component (module-shape baseline);
  splitting it is its own task, not a move.
- Tests live in `packages/web/tests/` (`messageInput*`, `composer*`,
  `assistantContextChip`, `senderNameMentionInsert`). Run named files with
  `pnpm --filter @botiverse/raft-web test:dom <files>`.
