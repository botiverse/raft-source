# Workspace Artifacts (server module)

Raft Artifacts as a native Raft object: metadata and permissions in Postgres
(schema `app_artifacts`), bytes under Artifacts' own prefix of the
platform's app-content bucket (an attachment saved as an Artifact is copied
in, never referenced), untrusted pages on another origin. On wherever the deployment has its storage
and its content origin (`deployment.ts` `artifactsConfigured`, which answers
the key `workspace_artifacts_v0` for every server; the per-server rollout flag
is retired). Branch plan:
[docs/development/workspace-artifacts.md](../../../../../docs/development/workspace-artifacts.md).

## Boundary

`scripts/ci/check-app-module-boundaries.ts` (also in `pnpm check:misc`)
checks imports:

- Production files here import only external packages, `@botiverse/raft-shared`,
  this module, and the platform entry points under
  `packages/server/src/platform/` (first-party app mechanism §二). Each is
  registered in the script's `platformEntryPoints` with why it is a platform
  capability rather than this module's own need, and every file there must
  be registered:
  - `platform/db`: the executor (`getDb`, `DatabaseExecutor`);
  - `platform/visibility`: who can see what by its home: `canViewHomes`
    (visibilityService `canViewHomedObjects`), `viewersOfHome`
    (`canActorsViewHomedObject`), `visibleHomesSql` (the list condition over
    an object table's home columns: `visibleRootChannelIds`, `canView` of the
    server home, `uuidArray`; `visibleHomes` reads the same once for
    conditions on many tables, as core's search does, and its type
    `HomeColumns`), `serverViewersLost` (how many of an object's server's
    people and agents, up to a budget, see it now and wouldn't in another
    home: a narrowing's preview and audit), `standsInOwnServer`, `homeOf` (an object
    table's standard home columns as a home; a conversation home with a NULL
    channel is an orphan) and `canManageObject` (who may move an object to a
    larger home or delete it: its author, a live agent author's manager, the
    server's owners and admins, each standing in the object's own server;
    widening only by a non-guest member or a live agent, so a guest deletes
    their own and never widens it; visibilityService `canManageHomedObject`,
    beside the orphan rule it shares its people with), with `agentManagerOf`
    and `agentsManagedBy` (the agents a person manages: their personal
    assistant, and the agents they made that are no one's assistant; the
    dashboard's `my-agents`). Orphans are the platform's: see "Who sees what";
  - `platform/actors`: handles (`actorNames`, executor-aware), profiles
    (`actorProfiles`: the avatar people and agents set, nothing else, and a
    personal assistant's owner, `assistantOf`, in the agents' query: the web
    actors' `onBehalfOf`),
    `actorsByHandle` (members and live agents, as @mentions match) and
    `mentionCandidates` (the `@` directory: members and live agents
    matching `q`, home members first) and `actorsShownToPerson` (of those,
    whom a person may be shown, people decided in one batched query: a
    guest only itself and whom it meets in a conversation it can read, core's
    rule for the member profile and agent routes; a plain member of a server
    that hides its people from members (`hideHumansFromMembers`), of the
    people only itself, whom it shares a conversation with other than #all
    and the always-shown ones, as that profile route and
    `POST /api/actors/resolve` have it, and every agent; anyone else
    (owners, admins, members where people are not hidden), all);
  - `platform/conversations`: `resolveConversationTarget` (a thread target
    names its parent; channelService `parseChannelRef` and
    `resolveChannelByName`; a task ref, `#channel:#7` or `dm:@peer:#7`,
    names no conversation, so a push or a list with one answers 404
    `TARGET_NOT_FOUND` in `TARGET_IS_TASK_ERROR`'s words, its step the
    conversation the ref names: `apiCommon.ts` `targetNotFound`, by the
    ref's shape alone, shared `taskRefConversationTarget`; guard:
    `publish.api.test.ts` "a task ref as the target"), `topLevelConversationOf` (a conversation id of
    the server, a thread's or task's as its parent, and its type; who sees it
    is the caller's check), `readableConversation` (a conversation id of
    the reader's server, a thread's as its parent, that the person can see
    now by core's channel access, visibilityService `canView`, and the home
    it names: a joint projection's canonical channel; null for every other
    case), `postableConversation` (a top-level conversation of the person's
    server they may post in now, as core's send has it, and the home it
    names: what a person's publish through their assistant places into, and
    what `services/firstPartyAppMessages` posts as the reader into),
    `agentConversationRefs` (`#name`, `dm:@peer` as
    the agent names it), `conversationNames` (a DM by its peer, as the
    reader sees it), `conversationGuestAccess` (a guest of the server in
    it, or a channel guests may read without joining), `isConversationMember`
    (on its roster, not merely able to read it: an agent author a narrowing
    keeps) and
    `conversationMembers` (a conversation's people and agents, guests marked,
    for a reader who can see it: channelService `getChannelMembers`);
  - `platform/flags`: `appEnabled`, `appEnabledOn` (the flag key comes from
    shared; an executor reads inside the caller's transaction or savepoint);
    core's object Activity reads (the inbox, mark all read, the badge) use
    `appEnabledOnCached`, a 30 s per-process cache the change notifier
    clears when the flag changes, and count a flag that can't be read as off,
    never for a write. Artifacts' own key is answered by the deployment
    (`deployment.ts`), with no read to cache: `apiCommon.artifactsEnabled`
    and `itemServerEnabled` (that, and the item's server still exists);
  - `platform/objects`: `recordObjectEvent` (the kind and event kind as
    registered, the home, the recipients), in the module's own transaction,
    and `forgetObjectEvents` (one Artifact's events gone for good, with an
    operator's purge: `purge.ts`)
    (reads go through core's `POST /api/objects/summaries`, which filters by
    the homes the registration reports);
  - `platform/activity`: people's Activity rows (core's
    `object_inbox_states`): `markObjectRead` (a person's read position moved,
    reported in the transaction that moves it: `apiCommon.ts`
    `advanceReadPosition` / `reportRead`; core counts an event read up to
    the first one past the reported position, as an edit carries its
    comment's older position), `forgetObjectActivity` (an Artifact deleted:
    `manage.ts` deleteArtifact calls it in its transaction, through
    `activity.ts` forgetArtifactActivity, and the route announces
    `announceActivityChanged` to those whose rows went; an Artifact moved to
    a smaller home: narrowArtifactHome, through
    forgetArtifactActivityOfThoseWhoLost, forgets the rows, listed by
    `objectActivityPeople`, of those who can't see it there) and
    `announceObjectEvents` (after the commit of a comment, an edit or a
    version: `activity:changed` to the people it is for);
  - `platform/session`: `signedIn` (users and session families, as
    `verifyActiveAccessToken`);
  - `platform/searchTokenizer`: the platform's search tokenizer, for the
    module's own index (a re-export of `services/searchTokenizer`);
  - `platform/links`: `appUrl` (Artifact URLs, the link a share posts
    included: this deployment's origin, https://app.raft.build in
    production), `appHosts` (the hosts a
    link's `/artifacts/<id>` names an Artifact on) and `serverIdBySlug` (the
    server a slug names now; an import's old link carries a slug);
  - `platform/storage`: the `AppObjectStorage` type. Core hands the app its
    handle (`register.ts` `receiveObjectStorage`, built from the app's id):
    keys under `apps/artifacts/` of the platform's one app-content bucket
    (`APP_STORAGE_R2_*`), the prefix added by core and keys that could leave
    it refused; the app never holds the bucket or its credentials. Core's
    storage code: core's pool settings, timeouts, put metrics and traces;
  - `platform/attachments`: `readAttachmentForSave(viewer, attachmentId)`
    (the bytes, name, mime, size, message, its channel and top-level
    conversation, for saving a copy: `webShare.ts`) and `attachmentSource(viewer,
    attachmentId)` (the same without bytes, for `savedFrom`;
    `attachmentSources` for many, the saves list), all only when
    the viewer can see the message's conversation, through
    attachmentAuthorityService (a live attachment bound to an attachment
    object; a legacy unbound one is not readable), and the message is inside
    the plan's history window of the viewer's server (a Free server's 30
    days, `services/historyWindow.ts`, as the attachment routes check it), so
    no app can copy a file older than the window into something kept.
  - `platform/messages`: `messageSource(viewer, messageId)` (where a
    message is: its top-level conversation as the viewer's server has it, a
    thread reply's thread root), only when the viewer can read it now, by
    core's one-message rule (`services/messageResourceAccess`: the
    message's conversation, a joint's through the viewer's projection, then
    the plan's history window) and it isn't retracted; null for every other
    case. For an Artifact's original message (`origin.ts`).
  - `platform/fileUploadQuota`: the server's monthly file upload quota,
    the attachments' one (`reserveFileUpload`, which reserves and runs the
    caller's work in one transaction so it records the reservation on a row
    of its own; `withFileUploadQuotaLock`, `commitFileUploadInTransaction` and
    `releaseFileUploadInTransaction`, which settle it in the transaction that
    changes that row; `checkFileUploadQuota`, and
    `fileUploadQuotaExceededResponse`, the attachments' 403 body), so
    Artifact bytes count against the same per-server, per-month total; see
    "Monthly file upload quota".
  - `platform/tracing`: `withAppSpan` (a timed child span of the request's
    span, Tracing V2) and the `byteSizeBucket` / `countBucket` it records:
    `trace.ts` lists the module's spans (push, the frame ticket, import
    and its steps, the content Worker's authorize, the publish check's
    record, lease and result) and their attributes, never content, names,
    links or ids of content;
  - `platform/channelAnnouncements`: channel announcements
    (#proj-chat:#29, `channel_announcement_v0`; core's
    `services/channelAnnouncements.ts` owns `channels.announcement_artifact_id`
    and who may set it): `channelAnnouncementAudience` (the agent members of
    the live channels that have an Artifact as their announcement, flag on
    there; notices.ts `noticeChannelAnnouncement` queues them a
    `subscribed` notice with `channelAnnouncement` on a new version, never
    pushed), `channelAnnouncementPushRefusal` (while it is a channel's
    announcement, publish.ts refuses a push, a new version or title, by an
    agent without editChannelMetadata on that channel: 403
    `CHANNEL_ANNOUNCEMENT_PUSH_FORBIDDEN`, asked before anything is stored
    and again under the item lock; `announcement.ts`
    channelAnnouncementPushRefused) and `clearChannelAnnouncementsOf` (manage.ts: delete, widen and a
    narrowing out of the channel clear it in their transaction). Core reads
    the Artifact through the registration's `channelAnnouncement.headlines`
    (`announcement.ts`: title, current version, its publisher and note, and
    whether a reader has seen it by the read positions here);
  - `platform/apps`: the first-party app contract (types only), which
    `register.ts`, `mount.ts` and `webSearch.ts` (`AppSearchInput`,
    `AppSearchPage`) are written against; a web call's `messages`
    (`AppMessagePoster`: an ordinary message as the reader, core's checks and
    pipeline, `services/firstPartyAppMessages.ts`) is how a share posts.

  Only `schema.ts` imports `db/schema`, and only for foreign keys.
- Core imports the app only through its registration, `register.ts`
  (first-party app mechanism §一), which core's registry
  (`packages/server/src/apps/firstPartyApps.ts`) is the one core file to
  import. Core derives everything it does for Artifacts from it:
  - the object kind `artifact` and its events (`kinds.ts`), which
    `recordObjectEvent` checks;
  - the summaries (first-party app mechanism §四, core's
    `POST /api/objects/summaries { kind: "artifact", refs: [{ id, version? }] }`):
    `homes` (`visibility.ts` `artifactHomes`: where each live item lives, its
    server, home columns and author; deleted and revoked ones left out),
    from which core decides who sees which (its own rule, never the app's:
    only while both the reader's server and the item's have the flag on,
    then `canViewHomedObjects`: another server's only when its home is anyone with the link
    (`public`) or in a joint channel the reader is in, orphans included); `parseRef`
    (`webCards.ts` `parseArtifactObjectRef`: an id and an optional whole
    version from 1, nothing else; core reads only the id); and `summarize`
    (`webCards.ts` `summarizeArtifacts`: for the references whose id core
    kept, the card of the pinned version or the current one; none when it has no
    version yet or the version isn't readable: missing, revoked, or another
    version of an anyone-with-the-link Artifact for a reader outside its server). The
    summary is the shared `ObjectSummaryKinds.artifact`, `ArtifactCard`:
    exactly the viewer's `card` for the same id and pinned version (the
    web's message cards read it, as `ok` ArtifactReferences); a pinned
    card's `author` and `updatedAt` are who pushed its version and
    when; one field only the summaries carry, `unseen` (`webCards.ts`
    `artifactCardUnseen`, one query for all the references: others' newer
    version and live comments past the reader's read position, null with
    none); and `deleted` (a deleted Artifact named in a message,
    xxchan's rule): `deleted.homes` (`visibility.ts` `deletedArtifactHomes`:
    where each deleted item lived, its home columns as they were when it was
    deleted; never a revoked one, deleted or not), asked by core only for the
    ids `homes` left out, which core decides on exactly as on a live item
    (both servers' flags, then `canViewHomedObjects` on that home), then
    `deleted.summarize` (`webCards.ts` `summarizeDeletedArtifacts`) for the ids
    left: core answers each `{ ok: false, reason: "deleted", deleted }`, the
    shared `ArtifactDeletedReference` (`{ status: "deleted", title,
    deletedBy, deletedAt }`, `deletedBy` the audit's `deleted` row shown as a
    card's author: no id outside an anyone-with-the-link Artifact's server); nothing of its
    content, versions, files, comments or home;
  - `system.artifacts`: its notices' schema (shared `artifactAgentNoticeSchema`,
    which `AgentMessage.app_event` is checked by) and its delivery guard
    (`artifactNoticeDeliveryVerdicts`; required, since the app sends
    notices);
  - the routes (`mount.ts`): the agent API's (core's
    `routes/internalAgentApi.ts` validates, runs and writes them, and
    charges every write to core's agent write budgets, per agent and per
    server across replicas; see "Write limits" below), the web
    API's (core's `routes/firstPartyAppRoutes.ts`, mounted by app.ts at
    `/api/artifacts` behind `requireAuth`, `requireVerified`,
    `requireServer`, with the per-user limits the mount declares) and the
    content Worker's (`/internal/artifacts-content`) and the publish check
    Worker's (`/internal/artifacts-check`), both ahead of core's
    machine-auth `/internal`, each mount checking its own Worker's token and
    rate limiting it, and the body parsed with a larger limit (push);
  - the jobs: the hourly `prune_artifact_blobs`, `purge_artifact_drafts` (review drafts 30 days after their last change, S8), the 30 s notice flush and the minutely `check_expiry` (publish checks past their run window: checkTask.ts `expireStaleChecks`; their screenshots are core's object files, swept by core)
    (core's `services/firstPartyAppJobs.ts`, started by server.ts);
  - `artifacts` in agents' `enabledApps` while the flag is on for their
    server (core's `services/firstPartyAppFlags.ts`): `AgentConfig.enabledApps`
    at agent start and `features.enabledApps` of the agent context. The CLI
    guide renders an app's command-list entry from it
    (`FIRST_PARTY_APP_GUIDE_ENTRIES` in shared `raftCliGuide.ts`, each
    app's from its own `apps/<id>/guide.ts`). For
    Artifacts that entry is entry 6 itself, "Attachments and Raft Artifacts":
    the attachment commands, when to use an Artifact instead, and the
    `raft artifact` commands, in place of the plain entry 6 (only
    `raft artifact --help`; it pointed to the `artifact-share` App until #proj-workspace:#117),
    with no Artifacts entry of its own after the fixed
    ones (`replacesAttachmentsEntry`; xxchan, #proj-workspace:e9c4c577);
    `artifact-share` leaves the prompt's installed-app list (`raft
    integration list` still shows it). A running managed agent sees it after
    it restarts, as with the Reminder and Vault flags. A self-hosted agent
    gets the entry from the server but runs its own `raft` from npm, so the
    server renders the entry only for a CLI that declares it
    (`guide-app:artifacts@<commandsVersion>` in `X-Raft-Client-Capabilities`;
    shared `guideAppsForClient`); an older CLI gets the guide without it,
    that is with the plain entry 6;
  - the search (`webSearch.ts`): the `artifacts` group of core's
    `GET /api/search` (core's `routes/search.ts`), asked only while the flag
    is on for the reader's server;
  - people's Activity rows (`activity.ts`, S6; core's
    `services/objectActivity.ts`): `unreadFor` (following, and how much is
    unread for the rows of one page: while following, versions and live
    comments by others after the read position, else only the comments
    after it that mention the person, as the dashboard counts; also by
    part, `parts { versions, comments }`, the row's `unreadParts`, #81:
    zeros once read, `versions` 0 when not following),
    `activityDetails` (the row's one-line preview, the newest unread comment
    or else, read or not, the newest event's comment while live and by
    someone else, #80, null for a version or a deleted comment; and its target: the newest event's
    comment on its version, or its version) and `markRead` (Done, mark read,
    mark all read: the read position moves, never back, and is reported to
    core, all on core's transaction, so Done and the read commit together).
    Whether a row is unread and the badge are core's, from the read
    positions reported back: nothing here runs on the badge's path. A
    person who starts following (`PUT …/subscription`, not already
    following) has read the Artifact up to then, in the same transaction:
    unread while following counts from when they started (decision of
    2026-10-26; an auto-follow by commenting moves nothing).

  What core's mount contexts still inject is what needs the app instance's
  socket server and agent orchestrator: the notice outbox (`AppNoticeOutbox`:
  `system.artifacts` notifications in core's agent event queue,
  `services/firstPartyAppHost.ts`) and, on a web call, the message poster
  (`AppMessagePoster`, `services/firstPartyAppMessages.ts`).

  Tests here may seed through core; core tests do not import the app.
- A new core dependency is a platform entry point: a file under
  `packages/server/src/platform/`, registered in the script's
  `platformEntryPoints` with its reason (not a core internal).

Not checked, and left to review: queries. `getDb()` is typed with the core
schema, so `getDb().query.<coreTable>` or raw SQL naming a core table would
pass the script. The rule is that this module queries only `app_artifacts`
and reaches core data through the platform entry points.

## Files

- `schema.ts`: the `app_artifacts` tables. `drizzle.config.ts` lists it next
  to `src/db/schema.ts`; migrations stay in `packages/server/drizzle/`.
  Deploy note: `drizzle.config.ts` is config-coupled
  (`.release/core-config-contract.v1.json`, `always_config_coupled`), so a
  change to it ships under the config-coupling rules.
- `visibility.ts`: `canViewArtifacts` (one actor, many items, constant
  queries), `actorsWhoCanViewArtifact` (many actors, one item, constant
  queries but one check per guest on a conversation home) and
  `visibleArtifactsSql` (the list condition, optionally narrowed to some
  kinds of home for the dashboard's filter), all through
  `platform/visibility`; `visibility.db.test.ts` holds the first two
  to the same matrix. `artifactHomes`: the live items' homes, for core's own
  filter (the summaries route).
- `register.ts`: the module's registration (`artifactsApp`, a
  `FirstPartyApp`), its one entry for core (see Boundary). `kinds.ts`: the
  object kind, its events and object tables (a leaf: core's registry reads it
  while loading). `events.ts`: `recordArtifactEvent`, the home and the
  recipients of an event. `mount.ts`: the mount functions the registration
  hands core: the agent API's and web API's routes onto the operations below,
  the per-user web limits (`frame` 120, `write` 60, `commentImages` 30, `mentionCandidates` 300,
  `dashboard` 120 (a conversation's Artifacts share it), `attachmentSaves` 300, `shareAudience` 300 a minute; test overrides by
  `artifacts.<name>`; see "Write limits" below), the push's large body, and the content Worker's router.
- `routes.ts`: the agent API, `/internal/agent-api/artifacts/*` (contract:
  `packages/shared/src/agentApiArtifactsContract.ts`); the read side (S1a) is
  here (its answer's `origin`: `origin.ts`, see "Original message").
  `apiCommon.ts` holds what the
  operations share (the notice outbox, errors, the flag gate, resolving a visible
  Artifact, read positions, summaries). Flag first, then visibility; anything
  not visible is one 404 `NOT_VISIBLE`.
  - What an agent has seen (task #71): only a route that returns content
    to the agent moves its read position (the read, the comments list, a
    hold, a push), by one rule, `apiCommon.shownThrough`. A notice never
    moves it (Tenny): it is only a notification, and neither queueing it,
    the `/events` hand-over nor the daemon's push proves the model read it.
    A comment by someone else counts as seen only once its whole text
    reached the agent: a full body (the comments list), or an excerpt not
    `truncated` (the read, a hold). The position moves over what was shown and
    stops before the first comment by others that wasn't (cut short, older
    than the few shown, on another file, before a cursor), so everything
    after that one stays unseen too. Versions: reading the current version, a
    hold, the comments list and a push pass others' versions (their files
    are what the current version came to; the answers count them). The read of the current version moves
    over others' versions and the comments it shows whole, and answers
    `unseen.unread` (how many of `commentCount` stay unseen); the comments
    list (unseen view) moves over every comment it lists, so listing the new
    comments is how an agent clears a hold. A push's own version moves
    the pusher only up to the first comment by others it wasn't shown
    (`unseen.otherComments`, on other files). Callers that move a position
    without showing anything by others (an agent's own comment or review
    when nothing unseen lies before it, a new Artifact's import or save)
    and a person's (the web viewer, which shows comments whole, Done,
    following) are outside the rule.
- `publishAs.ts`: publishing through a personal assistant
  (#proj-assistant:#31), `publishArtifactAs`, a function the assistant's own
  routes call (no Artifacts route; an assistant's credential reaches none of
  them). The publish is `publish.ts`'s (`publishWith`, the agent API's push
  being the other door), for the author it is given, with the same checks,
  refusals, quota and notices: the assistant itself, into a conversation it
  can post in, or its owner, a person (step 3), into a top-level
  conversation the OWNER may post in now (`platform/conversations`
  `postableConversation`, the rule an app's message as the reader is held
  to: not a thread, not archived or read-only; a joint's canonical channel;
  else 404 `TARGET_NOT_FOUND`). For a person the Artifact is found by id as
  the person sees it while they stand in the server, a new version needs the
  person's rename right (`rename.ts` `mayRename`; else 403 `FORBIDDEN`), the
  rows, the object event and the follow are the person's, and the
  unseen-comments hold is the assistant's (its read position, comments by
  anyone but it, the owner's too; Tenny, option 2): the owner's read
  position and Activity never move. The assistant isn't told of its own push
  (the notices' `except`), no upgrade card is offered on a quota refusal,
  and the answer names the home by id (`apiCommon.ts` `summarizeForPerson`,
  never an agent's names for conversations). A new Artifact is marked with the assistant
  (`items.published_by_assistant_agent_id`, set once), and a new version goes
  only to an Artifact carrying that assistant's mark: another assistant's, or
  one with no mark (a person's, an agent's, the same agent's through the agent
  API), is 403 `NOT_PUBLISHED_BY_ASSISTANT`, after the author's own visibility
  (the one 404 first), and a repeated create replays only an Artifact with
  that same mark. No upload step: a file listed by `sha256` that the
  server lacks is 400 `FILES_NOT_INLINE`. A new Artifact without a home is 400
  `HOME_REQUIRED`. These three codes are this module's, not the agent API's.
- `publish.ts`: pushing (S1b), `POST …/push` and
  `PUT …/uploads/:sha256`. Its header lists the checks in order: the
  request (a blank title: 400 `TITLE_REQUIRED`; a `name` from an older
  client is ignored), who may push (an agent of the Artifact's server that
  sees it; else 403 `FORBIDDEN`; a new Artifact needs a title, else 400
  `TITLE_REQUIRED`, and is made with no name), a repeat of the same request
  (a version this agent made from it on the same base, current or not,
  answers `replayed`), the base (others' changes since it: merged when they
  don't overlap, 409 `BASE_MOVED` when they do), nothing to push (the result
  equals the current version: 200 `unchanged`, nothing written; equal but
  for the title: the item takes the title under the item lock, its search
  entry too, with a `renamed` object event for no one's Activity and a
  notice to its other following agents (`rename.ts` retitleItem, the web's
  rename too), and no version: 200 `unchanged` with `titleChanged { from }`), the comment hold (409
  `UNSEEN_CHANGES`), missing bytes (200 `{ missing }`), then one transaction
  with the item row locked that checks the base and comments again and writes
  the version, and its publish check (`checks.ts` recordVersionCheck: `pending`,
  `skipped` from the start, or none for a kind no check opens, anything but
  HTML, shared `ARTIFACT_CHECKED_KINDS`, or on a
  deployment without a check Worker), answered as `check`. The check runs in a
  savepoint of that transaction and never fails the push: a failed query
  rolls back the check alone (logged with the version id, error class and
  SQLSTATE; the `server.artifacts.check.record` span ends as an error) and
  the push answers without `check`. A replay answers its version's check as
  it is now (`versionCheckOf`: any status, none with the flag off); an
  `unchanged` or retitled answer has none (no version was made).
  `publish.realPg.test.ts` proves the lock on a real Postgres.
  - After the commit, when the entry is a page, the answer's optional
    `warnings` name the pages that hold themselves to one screen
    (`scroll-lock`, task #71) and the pages with frames or plugins of their
    own, which never load in Raft's frame (`nested-frame`, 2026-11-01)
    (`scrollLock.ts`): Porthole's `lintFiles` scroll-lock and nested-frame
    rules (P106/P110; `@botiverse/porthole` at the content Worker's version)
    over the pages it reads (the entry and 7 more) and the stylesheets they
    link or import, from the request's inline bytes, else storage; at most
    2 MB and 1.5 s of reads, else no warning, and any failure is no warning,
    never a failed push. Porthole's rule reads markup; a page's own
    `<script>` that calls `createElement`/`createElementNS` for a frame-like
    element (P130's list) is found by `scrollLock.ts` too, as `nested-frame`
    (that call throws in Raft's frame). Scripts in files of their own aren't
    read. HTML comments (and a script's own comments, for that call) are
    blanked first, so what they hold doesn't warn. Beside them, the scripts
    and stylesheets this push adds or replaces that are copies of common
    libraries (`bundled-library`, 2026-11-08, `bundledLibraries.ts`): a page
    may load those from Porthole's library CDNs, and a copy counts against
    the monthly upload quota each time it changes. Found by a library's own
    build name (jQuery, React/ReactDOM, Chart.js, three.js, D3, Plotly, Vue,
    Lodash, Bootstrap, Mermaid, KaTeX, highlight.js, Tailwind's Play CDN
    script) or by the banner in the file's first comment, only for files of
    at least 4 KB; banners from the inline bytes, and from storage the first
    chunk of at most 8 more files, within the same 1.5 s (a name match stands
    without it). The message names the pinned jsDelivr address when the
    banner or name gives the version, else the package's page there. The CLI
    and `artifacts_push` print each before `Open:`, in the rule's words (its
    message is the fix for that page).
    Guard: `scrollLock.api.test.ts`, `bundledLibraries.test.ts`, shared
    `agentText/artifacts.test.ts`.
  - An overlap is a file or setting (entry, title, description) that others
    and this request both change, to different outcomes: others already
    making a file the bytes this request sends, or deleting what it deletes,
    is no collision. Deleting the current entry file counts as touching the
    entry, so it collides with others moving the entry (BASE_MOVED rather
    than ENTRY_NOT_FOUND). `versions.title` / `description` record what each
    version set, so a later push can tell who changed them.
  - The hold moves the read position over the held comments it shows in
    full, passing others' versions in between (`details.skipped.versions`),
    and stops before the first comment by others it doesn't show in full (cut
    short, older than the newest few, or on another file: shownThrough).
    `details.unseen.unread` counts the held comments that leave unseen: with
    none, the same request again goes through; otherwise it is held again
    until the agent lists the comments (task #71; before, the hold moved to
    the newest held comment, so a retry went through without the agent
    having read a comment cut short). `skipped.otherComments` is now
    always 0.
  - The push route's JSON body (up to ~33 MiB) has its own parser
    (declared by `mount.ts`, mounted by core): after agent auth and the
    flag check, before the operation; a server with the flag off answers 403
    `ARTIFACTS_NOT_ENABLED` without reading the body.
- `import.ts`: importing one Artifact of the standalone app
  (raft-artifacts.com) on demand, `POST …/artifacts/import { from, target? }`
  (agent API) and `POST /api/artifacts/import { from, conversationId? }`
  (web, the writes' 60 a minute; at most two at once per server, see "Write
  limits" below). Tenny's conditions; the header lists the
  checks in order. The given link is only parsed (shared
  `parseLegacyArtifactLink`: the standalone app's hosts, plus
  `ARTIFACTS_LEGACY_LINK_HOSTS`), never requested; the caller is a non-guest
  member or live agent of S (the server home's audience); the link's slug is
  S's, or no server's now (Raft keeps no slug history, so a renamed slug is
  taken as S's; the standalone app, asked by S's id, 404s when it isn't S's;
  a slug another server has now is 403 `LEGACY_OTHER_SERVER`, S's old one
  included). The home is the whole server S by default (`server`, the old
  Artifact's audience); a target, when given, a conversation of S the
  caller sees, not a joint channel, with no guest in it nor open to guests
  (403 `TARGET_HAS_GUESTS`, agents too). Only then the standalone app is
  asked (`legacyWorker.ts`), under one deadline for the whole import (5
  minutes, `AGENT_API_ARTIFACT_IMPORT_DEADLINE_MS`; past it 503
  `IMPORT_UNAVAILABLE` `timeout`). An earlier import
  (the manifest's `importedTo`, parsed, or an `import` audit row for the old
  Artifact's id, live in S) is answered when the caller sees it, else 409
  `ALREADY_IMPORTED`; a deleted one is imported again. The manifest is held
  to a push's limits (files per version, each file's size, the
  unreferenced-bytes cap, 413 `IMPORT_TOO_LARGE`) and the name to the home
  (409 `NAME_TAKEN` with the Artifact that has it) before any file is
  fetched; each missing file is read up to its manifest size and its
  sha256 computed here (502 `IMPORT_MISMATCH`, nothing created); bytes the
  server has are reused. An import that fails deletes at once the blob rows
  it made that no version uses (`blobs.ts` `deleteClaimedBlobs`: not one
  another upload refreshed since, nor one a push holds), so they don't
  hold S's upload cap until the sweep. The files it copies count against
  the monthly file upload quota (below) through `storeBlob`; with the cap,
  all of them are checked first (`checkFileUploadQuota`, 403
  `FILE_UPLOAD_QUOTA_EXCEEDED` on both APIs, nothing fetched or created).
  A copied blob that was made ready committed its bytes, and deleting it
  after a failure gives nothing back (as deleting an attachment doesn't);
  a row still pending (its store failed, or never finished) gives the
  reservation recorded on it back in the transaction that deletes it, under
  that month's quota lock, as the sweep does. One transaction (under an advisory lock per server
  and old Artifact, the earlier-import check again) writes the item, version
  1 (note `Imported from <old link>`, `provenance.importedFrom`), its files,
  the search index, the event, the importer's read position and following,
  and the audit row (`import`, by the importer, `after: { legacyArtifactId,
  from, server, name, version, legacyCreator }`). The author (`created_by`,
  version 1's `publisher`) is the old Artifact's creator (the manifest's
  `creator`, `{ type, raftId, name } | null`) when Raft confirms it
  (`legacyAuthor`: the type and id are hints, taken only for a live agent of
  S or a member of S of any role, of exactly that type; a guest author may
  delete its own, never widen, D13), on both paths, so an agent keeps its
  author's rights and its "push another version of my-report" flow;
  otherwise the importer is (on demand the person or agent importing, in the
  move the ops actor). A confirmed creator who sees the home follows it too,
  read up to version 1; `legacyCreator` records it with `author: true|false`. Then the standalone app is told the new URL
  (`appUrl()/artifacts/<id>`), best effort. Guard: `import.api.test.ts`.
  `importLegacyArtifactAsOps` is the same import from the manifest on, for
  the per-server move (`legacyBulkImport.ts`, below): no flag, member, link
  or target checks (the operator names the server, the home is the whole
  server); the importer is the ops actor `ARTIFACT_OPS_IMPORT_ACTOR` (a fixed
  id, `user` type, that no person has: an Artifact it is the author of, its
  creator not confirmed, shows "System" as its author (ArtifactActor `gone:
  "system"`, apiCommon `isArtifactSystemActor`; a deleted agent or a person
  whose account is gone is `gone: "deleted"`, "Deleted agent" / "Deleted
  user", webCommon `profiler`) and is the owners' and admins' to
  manage, and the actor reads and follows nothing: the server's live human
  owners follow such an Artifact instead, a `followed` row read up to version
  1, so someone of the server has it on their Artifacts page and hears of its
  comments; none, no one; Tenny 2026-10-30), which sees every earlier import; the
  audit row's `after` adds `ops: { operator }`; the standalone app is told
  `importedBy: "Raft migration"`; the bytes are `storeBlob`'s `quota:
  "exempt"`. A refusal comes back as `failed` with its code, not thrown.
  Neither import copies the old page's comments: the per-server move does
  that itself, after the import (`legacyComments.ts`); an on-demand import
  never does (the old server usually isn't frozen then, and the standalone
  app serves comments only for a frozen server).
- `legacyWorker.ts`: the standalone app's import API at
  `ARTIFACTS_LEGACY_IMPORT_URL` with `ARTIFACTS_LEGACY_IMPORT_TOKEN` (both or
  nothing; https, http only on loopback; token ≥ 32 bytes and none of the
  other Artifacts secrets): `GET …/internal/raft-import/manifest?server=&name=`,
  `GET …/blob?server=&name=&sha256=`, `POST …/imported { server, name,
  newUrl, importedBy }`, Bearer token, no redirects, 10 s (a blob 60 s),
  and the whole import's deadline ends a request too.
  A 404 is not found; 429 is `IMPORT_UNAVAILABLE` `rate_limited`; anything
  else unusable `bad_answer` or `unreachable`. The token is never logged.
  For the per-server move only: `GET …/list?server=&cursor=&limit=` (the
  server's live named Artifacts in id order, at most 200 a page, the cursor
  the last id) and `POST …/freeze { server }` (idempotent; afterwards the
  standalone app refuses every write to the server's Artifacts, 409
  `SERVER_MOVED_TO_RAFT`), and `GET …/comments?server=&name=` (a page's
  comments, oldest first: `{ id, author: { type, raftId | null, name },
  body, path | null, replyTo | null, createdAt }` in epoch ms; 404 as the
  others, 409 `SERVER_NOT_FROZEN` while the server isn't frozen, 413
  `TOO_MANY_COMMENTS` past 5000 on one page; `fetchLegacyComments`).
- `legacyComments.ts`: a moved page's old comments copied onto its Artifact
  (Tenny's design: no table, no migration). Each is one `comments` row, id
  `lc_<old id>`, inserted ON CONFLICT (id) DO NOTHING (a rerun never
  duplicates; only an inserted row takes a position), at the item's next
  position as a comment takes it (the item row locked, `last_position`
  moved), one transaction per Artifact, oldest first; on version 1 (the
  imported one), the old `created_at`, no path, anchor, reply or mention.
  Its author is the old one when `legacyAuthor` confirms it (as for a page's
  creator), else the ops actor `ARTIFACT_OPS_IMPORT_ACTOR`, the body then
  starting with `<name> (from raft-artifacts.com)`; then `On <path>:` for a
  comment on a file, `Reply to <name>:` for a reply (the structure
  flattened; a parent not in the answer: no such line), the old body, all cut
  to `AGENT_API_ARTIFACT_MAX_COMMENT_CHARS`. Nobody is woken: no object
  event, notice, Activity announcement, follow or read position. Search is
  of titles only and comment counts are counted from the rows (`webCards`
  `artifactCardFacts`), so nothing else changes; `updated_at` moves only up
  to the newest copied comment's time (a new comment moves it to now).
  Positions follow the copy, not the old times (Tenny, accepted): the agent
  API's comment lists and the web API's pages go by position, so they show
  comments posted in Raft before the copy ran ahead of the older copied
  ones; the web viewer sorts what it loaded by time, so there the copies
  stand at their old times. A move copies right after each page, so little
  can come before; a later `comments` run copies after whatever was posted
  since the import. The copies also lie past every read position recorded
  before them: to such a reader they are unseen (`artifactRead`, and the
  hold on that reader's next comment or push), as Tenny chose. One
  `import_comments` audit row per Artifact that got any (ops actor; old id,
  count, operator, and in the `comments` mode the approval). Guard:
  `legacyBulkImport.db.test.ts`.
- `legacyBulkImport.ts`: the per-server move, run by the operator's script
  `scripts/artifacts-legacy-import.ts` (`pnpm db:artifacts-legacy-import`),
  never by a request. `planLegacyMove` (read only: `list` and this server's
  rows) and `runLegacyMove` (freeze, then each Artifact in `list` order, one
  at a time, through `importLegacyArtifactAsOps`, then its old comments,
  `legacyComments.ts`; the state saved after each), and the `comments`
  mode for pages imported before (`planLegacyComments`,
  `runLegacyComments`). Runbook below. Guard: `legacyBulkImport.db.test.ts`, the script's
  arguments `scripts/artifacts-legacy-import.test.ts`.
- `search.ts`: search (S9, title only), the `app_artifacts.search` index of
  each Artifact's title, and the one search of it (`prepareArtifactSearch`:
  the ranked query with the caller's visibility condition in the same
  statement as its order and LIMIT, the `matches`, the list cursor). The
  index is written in the transaction that sets the title (`publish.ts`;
  renames and metadata edits call `indexArtifactSearch` in theirs). Two
  callers run the same search: the agent API's `GET …/artifacts?query=`
  (`routes.ts`, with `visibleArtifactsSql`) and core's `GET /api/search`
  (`webSearch.ts`). [The branch doc](../../../../../docs/development/workspace-artifacts.md#search-s9)
  has the design. Guard: `search.api.test.ts`, `search.test.ts`.
- `webSearch.ts`: the registration's `search` (first-party app mechanism
  §五), the `artifacts` group of core's `GET /api/search`
  (`packages/server/src/routes/search.ts`; contract shared
  `webSearchContract.ts`, the result `ArtifactSearchHit` in
  `webArtifactsContract.ts`). Core has checked the query and the flag, read
  the person's visible homes once and runs the search in a transaction of its
  own under a statement timeout; the app puts core's visible-homes condition
  on the items' home columns (`ARTIFACT_HOME_COLUMNS`, the reader's server
  and its joints' canonical channels named in it) and its own live-items condition (`liveArtifactsIn`) into the
  ranked query. Each result is the Artifact's card (`artifactCards` at its
  current version, as the dashboard draws it) and its title matches; a cursor
  is the agent list's for the same query, and one of another query is
  refused (core: 400 `INVALID_CURSOR`). Guard: `webSearch.api.test.ts`
  (grouping, visibility for members, non-members, guests and orphans, server
  narrowing, paging equal to the agent list's, flag off, refusals).
- `comments.ts`: commenting (S1c), `POST …/:artifact/comments`, and following,
  `PUT|DELETE …/:artifact/subscription`. Its header lists the checks in order:
  who may comment (an agent of the Artifact's server, else 403 `FORBIDDEN`),
  the request (`body` ≤ 8000 characters, `anchor` ≤ 4 KiB and only with a
  `path`, `replyTo` a live comment whose file and place a reply without
  `path` takes, `version` default the current one and having the file),
  `@name`s, then one transaction with the item row locked: the hold
  (freshness v2 §2.2: a comment on `path` X is held by others' new comments
  on X or on the whole Artifact and by others' new versions that changed X; a
  comment on the whole Artifact by anything new from others; 409
  `UNSEEN_CHANGES`, the read position moved over what it shows as a held
  push's does, so the same request again goes through unless
  `unseen.unread` says some stay unseen), the comment at the item's next
  position, the object event, following, the notices. The author's read
  position moves over its own comment only when nothing unseen lies before
  it.
  - `@name`s are Raft's mention handles (`extractRaftMentionHandles`, not in
    code), at most 20 distinct (more: 400 `TOO_MANY_MENTIONS`, nothing
    written), matched exactly against the people (members, any
    role) and live agents of the Artifact's server (a joint home's other
    servers' members too are `unknown_name` here, though a person's web
    comment may name them: `webComments.ts` below); an agent wins a shared
    handle; oneself is ignored. The comment keeps its text and the resolved
    actors (`comments.mentions`). Reaching no one, reported in
    `notNotified`: `unknown_name`, `not_agent` (a person who can see it:
    told through their Activity, and the agent's text lists them as
    notified), `cannot_see` (a mentioned agent or person that can't see the
    Artifact, by the rule that keeps a stored mention, `resolveMentions`:
    the commenter named it and can infer that from the home's members, and
    it tells them to reach it in the conversation; Tenny; people too since
    #proj-workspace:#141, so a person who can't see it is never printed as
    notified).
  - Following (`subscriptions`): pushing or commenting adds a row unless
    one exists; DELETE sets `unsubscribed_at` and keeps the row (sticky: no
    automatic follow again until PUT), and drops a legacy pending batch. Being
    mentioned doesn't follow. Outside the server: PUT is 403, DELETE answers
    `following: false` and writes nothing. People follow the same way (the
    web API); a person hears through their Activity (S6), an agent through
    the notices below.
- `resolutions.ts`: resolving comment threads (#proj-workspace:#249), the one
  rule behind the agent API's `POST …/:artifact/comments/:comment/resolve |
  reopen` (`artifactCommentResolve`, `artifactCommentReopen`; comments.ts)
  and the web's `POST /:id/comments/:commentId/resolve | reopen`
  (webComments.ts). A thread is its root comment (no `reply_to`) and the
  replies under it; only the root carries the resolution, so a reply is
  refused 409 `COMMENT_IS_REPLY { comment, thread }` (its root, found up the
  `reply_to` chain); a placeholder root still is a thread. Who may: the
  Artifact seen and taken part in, as for commenting (404 `NOT_VISIBLE`,
  403 `FORBIDDEN`), then the thread's author, the Artifact's author
  (`items.created_by_*`, the `author` notices name) or the person who
  manages an agent author (the author check `delete` makes:
  `canManageObjectActions` `delete`), or an owner or admin of its server
  (`moderate`: people only); anyone else 403
  `FORBIDDEN` (agent API `details { reason: "not_resolver", title,
  threadAuthor, author }`). In one transaction, the item row locked: the
  root again (404 `COMMENT_NOT_FOUND`), what already stands so writes nothing
  (`changed: false`, no note: a retry never posts the note twice), an
  agent's hold (as a reply in that thread: 409 `UNSEEN_CHANGES`), the
  optional note (a reply by the resolver at the thread's place, on the
  current version unless it lost the thread's file, written by
  `insertComment`: checked, mentioned and told as a reply, except that the
  thread's author isn't told of it as a follower), the root, the object event
  (`comment_resolved` for the thread's author when a person and someone
  else, reason `following`; `comment_reopened` for no one) and, resolving,
  the notice to the thread's author when an agent and someone else
  (`notices.ts` `noticeResolved`: `your_comment_resolved` with `resolved {
  by, comment, noteExcerpt }`, whether it follows or not). After the commit,
  `sendQueued` and `announceObjectEvents` (`activity:changed`, the ping
  every comment write sends; the list-changed pings are not involved).
  `reopenThreadsOf` clears the resolution of the threads a reply is in, in
  the reply's transaction (`insertComment` and a review's writer). Every
  comment answer carries `resolvedAt` / `resolvedBy` (`agentComment`,
  `webComment`: null on a reply), which is also what the frame's markers
  read (the web's comment list). Answers: agent 200 `{ artifact, comment,
  note, changed, notified (`resolved` for the thread's author, then the
  note's `mentioned` / `subscribed`), notNotified }`; web 200 `{ comment,
  note, changed }` (`ArtifactWebThreadResolution`; body
  `ArtifactWebResolveInput { note? }`). Guard: `resolutions.api.test.ts`,
  `agentWriteLimit.api.test.ts`, `db/artifactCommentResolutionMigration.test.ts`.
- `reviews.ts` and `webReviews.ts`: batch comments (S8), a review: several
  comments posted at once, all or none, with an optional summary (a comment
  on the whole Artifact, posted last). `submitReview` is the one function a
  person's review (from their drafts) and an agent's (in one call) go
  through, so the rules can't drift: in one transaction with the item row
  locked, the Artifact still live and seen by the author (else the one 404),
  the attempt's key again (a person's `clientKey`: the same key answers the
  review it posted; another request under it 409 `CLIENT_KEY_REUSED`), an
  agent's hold, a person's drafts unchanged since they were checked (409
  `DRAFTS_CHANGED`), each reply's parent and version again; then the comments
  at consecutive positions, each with `comments.review_id`, the `reviews` row
  (author, version, key, request digest, summary), ONE object event `review`
  (`data { review, position (the last), comment (the first), version,
  comments }`; for everyone any of it mentions and the followers), the
  author following, ONE notice per agent at once (`notices.ts`
  `noticeReview`: `mentioned` when the summary or any comment mentions it,
  else `subscribed`, as a single comment's; `review { id,
  author, version, commentCount, fileCount, mentionsYou, summaryExcerpt }`
  and, for clients from before S8, `comments` as a comment notice has
  them), and a person's drafts deleted. Before it, every comment is checked
  as a single comment is (`checkWebComment`, `checkCommentFields`,
  `checkFileIn`, `resolveMentions`): the first refused refuses the review
  with that comment's own code, nothing written.
  - Agent API `POST …/:artifact/reviews { version?, body?, comments, seen? }`
    (contract Sage's, `artifactReview`): an agent of the Artifact's server
    (403), at most 50 comments (400 `TOO_MANY_COMMENTS { count, limit }`),
    the review's version and summary (refusals without `index`), each
    comment (its code, `details.index` and `.path` added), held (as a
    comment is) once over every file it comments on (any comment on the whole Artifact: anything
    new from others; 409 `UNSEEN_CHANGES`). 201 `{ artifact, review,
    comments, notified, notNotified (each name once), newlySubscribed }`.
    Comments carry `reviewId`; `GET …/comments?review=<id>` lists one
    review's comments (view `all`, the summary left out: it is
    `review.body`) and answers `review` (null and nothing listed for an id
    that isn't a review of this Artifact). With `idempotencyKey` (optional,
    as message send's) the same request again answers the review it posted
    (200, nothing posted or told again: `notified` and `notNotified` empty),
    another request under the key 409 `IDEMPOTENCY_KEY_REUSED`; the key is
    the `reviews.client_key` a person's `clientKey` uses. The route is a
    `keyedWrite`: the SDK's `artifacts.review` always sends a key (the
    caller's, else a generated one, returned), and `raft artifact review`
    sends the review once more under it when the answer is lost.
  - Web (`webReviews.ts`, Kirby's contract): `GET|POST|DELETE
    /:id/review/drafts`, `PATCH|DELETE /:id/review/drafts/:draftId`, `POST
    /:id/review/submit { version, summary, clientKey? }`. Drafts
    (`comment_drafts`) are their author's alone: someone else's id answers
    as a missing one (404 `DRAFT_NOT_FOUND`); a draft is checked as a comment
    when saved and kept as sent (parts with mentions as actors, target,
    version number, `replyTo`); a draft may reply (`replyTo`, column
    `comment_drafts.reply_to`, no foreign key): to a live comment of the
    same Artifact (404 `COMMENT_NOT_FOUND`), with no place of its own
    (target `{ scope: "artifact" }`, else 400 `INVALID_REQUEST`), posted as
    a reply at its thread's place and told as one; at most 50 per person and Artifact (409
    `DRAFT_LIMIT`, under an advisory lock); 30 days after its last change it
    is left out of every route, then purged hourly (`expiresAt`; the web
    warns from day 25). A submit answers 201 `{ status: "ok", comments }`
    (the summary last, each with `reviewId`) or 422 `{ status: "rejected",
    draftId, code, error, details? }` (shared `ArtifactReviewRejected`,
    typed per code): `draftId` the first draft refused, null when it is the
    summary; `code` and `details` the comment's own refusal, one of
    `INVALID_REQUEST` (none), `INVALID_PATH { path }`, `FIELD_TOO_LONG {
    field: "body" | "anchor", limit }`, `VERSION_NOT_FOUND { version,
    currentVersion }` (also when the version is found revoked under the
    lock), `FILE_NOT_FOUND { path, version }`, `TOO_MANY_MENTIONS { limit
    }`, `MENTION_NOT_VISIBLE { actors }`, `COMMENT_NOT_FOUND` (none: a reply
    draft's comment deleted since, also under the lock; never posted
    elsewhere); never `FORBIDDEN` (checked first, the route's own 403).
    Review-level refusals are ordinary errors (404 `VERSION_NOT_FOUND`, 409
    `NO_DRAFTS`). A person's review is never held (as a person's comment
    isn't). `GET /:id/comments?review=` answers as the agent route: one
    review's comments without its summary, and `review { id, author, body,
    createdAt }` on every page (`body` the summary's parts, mentions as
    actors; null without one or once it was deleted; `author` as the
    comments' authors); for an id that isn't a review of this Artifact,
    nothing listed and `review: null`. Without `review` the page has no
    `review` and the summary is listed as any comment, with `reviewId`.
  - Review ids are `ArtifactReviewId` (shared, branded), minted only where
    a row is answered: `webComment`, the web page's `review`, `agentComment`,
    `agentReview`, `noticeReview`; the agent query's `review` stays the text
    the agent gave, looked up as is.
  Guard: `reviews.api.test.ts`; the contract's types, shared
  `webArtifactsContract.test.ts`.
- `manage.ts` (`createManageOperations`): moving to the whole server,
  `POST …/:artifact/home { to }`, and deleting, `DELETE …/:artifact`, over
  the same service as the web routes (below). Never to a smaller home: that
  is a person's step on the web (narrowArtifactHome refuses an agent), so
  the agent API's move stays widening only. The flag, then the Artifact
  the agent sees (`resolveVisibleItem`, an id, a title or an old name; else the one 404,
  so unlike the web an agent deletes only what it sees), then
  `widenArtifactHome` / `deleteArtifact`. Among agents only the author
  passes `mayManageArtifact` (an agent is never a manager, an owner or an
  admin): else 403 `FORBIDDEN` with `details { title, author }`. `to:
  "public"` is accepted by the contract and refused by the service (403
  `FORBIDDEN`; the CLI and SDK refuse it before any request). The home
  only grows (checked before what follows, so a server-wide one answers
  `HOME_NOT_WIDER` whoever manages the agent). An agent moves only what the
  person who manages it (`platform/visibility` `agentManagerOf`: a personal
  assistant's owner, else its human creator) could move on the web now:
  that person sees it (the same visibility rule, as them in the Artifact's
  server) and may widen it (`mayManageArtifact`: not a guest, not one who
  left), checked in `widenArtifactHome` under the item lock (decided
  2026-10-27). Else 403 `FORBIDDEN` with `reason: "manager_cannot_see"` or
  `"manager_cannot_move"`, `manager` (by handle) and `target` (the home it
  is in), or `reason: "no_manager"` for an agent no person manages (one made
  by an agent). So an agent can't show a DM's or private channel's pages and
  comments to the whole server unless a person who sees them there and may
  show them stands behind it. A delete has no such check (decided: deleting
  narrows, never widens; an author may delete their own on the web too). An
  orphan counts as seen by the manager (the platform's orphan rule), so its
  move goes through; an agent of a joint's other side gets 403 for both. The home
  only grows (409 `HOME_NOT_WIDER { title, home, to }`); an old name, if it
  has one, free in the server home (409 `NAME_TAKEN { name }`). A move answers the summary and
  the home it left (`from`), and records what the web's does (audit
  `home_changed`, the `moved` event for the followers; nothing announced
  after the commit, as on the web). A delete answers the Artifact's ref
  (`deleted: true`) and tells the people whose Activity rows went
  (`announceForgottenActivity`, shared with the web route). Both routes are
  `destructive` (no idempotency: a repeat is 409 `HOME_NOT_WIDER` or 404). The
  agent-facing text is shared `agentText/artifacts.ts`
  (`formatArtifactMoved`, `formatArtifactDeleted`, `formatArtifactError`).
  Guard: `manageAgent.api.test.ts`.
- `takedown.ts`: taking an Artifact down and restoring it (moderation, not
  a delete; runbook `docs/operations/artifact-takedown.md`). `POST
  /api/artifacts/:id/takedown { reason }` and `/restore { reason }` (web,
  the writes' 60 a minute; no agent route): the owners and admins of the
  Artifact's own server only (`mayManageArtifact "moderate"`, never its
  author or an agent's manager as such), without having to see it; anyone
  else 403 if they see it, else the one 404. A Raft operator runs the same
  functions through `scripts/artifacts-takedown.ts` (`pnpm
  db:artifacts-takedown`, the server's `DATABASE_URL`) as the ops actor
  (`ARTIFACT_OPS_MODERATION_ACTOR`, its own fixed id beside the import's,
  `after.ops.operator`). A takedown sets
  `items.revoked_at` and `revoked_at`/`revoked_by_*` on every version not
  revoked yet (one `now()`), writes the audit row `taken_down` (`reason`,
  `versions_revoked`), drops its pending notices and Activity rows; every
  read then refuses it as a deleted one (the one 404, `unavailable` cards,
  the Worker's authorize `deleted`), search included (its row stays,
  `liveArtifactsIn`). A restore clears exactly those (the versions whose
  `revoked_at` is the item's), audit `restored`; 409 `NAME_TAKEN` when its
  old name (only Artifacts from before titles have one) was taken meanwhile. Both idempotent (`changed: false`, nothing
  written). Guard: `takedown.api.test.ts`, `scripts/artifacts-takedown.test.ts`.
  Removing one for good is the operator's alone: the script's `purge`
  (`purge.ts` purgeArtifact, below), never a route. It plans unless
  `--apply` with `--approval-reference`, `--run-id` and
  `--accountable-user-id` (a human), on the primary only, as the other gated
  ops scripts; no takedown is needed first.
- `purge.ts`: clearing a closed server's Artifacts (core's closed-server
  purge, `purgeServer`), and an operator's purge of one Artifact
  (`purgeArtifact`; its header lists the steps; runbook
  `docs/operations/artifact-takedown.md`): in one transaction under the
  item's lock its core object files (screenshots, comment images), Activity
  rows and object events go, the item row goes and everything of it by
  cascade (versions, files, texts, checks, comments, drafts, reviews, audit,
  saves, read positions, subscriptions, notices, search), then the rows of
  its blobs no other Artifact's version uses (`blobs.ts`
  deleteUnusedBlobsOf: blobs are per server and sha256, so a shared one
  stays), and the `purges` record is written (only the counts and the
  reason, Tenny on #13578); their objects after the commit, the record
  keeping a key only while its delete failed. Run again, it writes nothing
  and retries those, clearing each that goes. Guard: `purgeArtifact.db.test.ts`,
  `scripts/artifacts-takedown.test.ts`.
- `save.ts`: saving an attachment as an Artifact, one rule for a person and
  an agent (`saveAttachment(saver, attachmentId)`, a `ServerViewActor`; its
  header lists the checks): the web's `POST /api/artifacts/save-attachment`
  (`webShare.ts`, below) and the agent API's `POST
  …/save-attachment { attachmentId }` (`createSaveOperations`; `raft
  artifact save <attachment id>`, the SDK's `artifacts.saveAttachment`)
  each check the flag and their body, then answer its outcome in their own
  codes, the same ones: 404 `ATTACHMENT_NOT_FOUND`, 409 `ALREADY_SAVED`,
  422 `ATTACHMENT_NOT_SAVABLE`, 403 `FILE_UPLOAD_QUOTA_EXCEEDED` (the
  agent's with the attachments' body, as push answers it), 503
  `CONTENT_UNAVAILABLE`. The agent owns and follows the new Artifact, homed
  in the attachment's top-level conversation, and the attachment is saved
  as it (the web's "Saved as Artifact" line). An earlier save is answered
  (200, `created: false`) while the agent sees that Artifact
  (`canViewArtifacts` and its server's flag), as `summarize` names it. Like
  the agent API's other writes it has no per-route limit (the web's is
  `write`, per person). The agent-facing text is shared `agentText/artifacts.ts`
  (`formatArtifactSaved`, `formatArtifactError`). Guard:
  `saveAgent.api.test.ts` (the agent route), `share.api.test.ts` (the rule).
- `notices.ts`: what agents are told, as `system.artifacts` notifications
  (kind `notification`, summary `formatArtifactNotice(…, "cli")` cut to 500
  characters, payload `{ app_event: { app: "artifacts", kind: "artifact",
  ...notice } }`, 6 hours to live); the message an agent gets carries that
  `app_event` next to `third_party_event` when it passes the registered
  schema (`buildThirdPartyAgentMessage`). A comment tells its mentioned
  agents (`mentioned`) and the Artifact's other followers (not the author,
  not mentioned; `subscribed`) at once, one notice per agent per comment, as
  chat messages reach agents (#55, xxchan: comments follow messages, which
  aren't batched). Legacy, to remove with the table once no row can remain:
  until #55 followers were batched in `pending_notices` for two minutes from
  the first comment; nothing writes it now, and `flushDueArtifactNotices`
  (the registration's 30 s job, run by core) only drains rows queued before
  then (due rows FOR UPDATE SKIP LOCKED, deleted in the same transaction,
  each row in its own savepoint so one that fails is logged and dropped
  without holding up the rest; one flush at a time, and shutdown waits for
  it) as one notice with the count and the newest five. A new version tells, at once, the followers that were the
  last to push a file it changed or removed (`your_file_changed`, the last
  pusher found from `version_files`: the version that gave the file the
  bytes it had). A rename tells the other following agents
  (`noticeRename`: `subscribed` with `renamed`), but only changes what the
  Artifact is shown as, so its notice wakes no agent (Sage, task #160): it
  is queued and never pushed (no `sendQueued`), and the agent gets it the
  next time it wakes for something else, when its `/events` pull (or
  wake-hints read) rebuilds its queued events from the table
  (`routes/internalAgentApi.ts` `rebuildPendingThirdPartyAgentEvents`),
  through the delivery guard; one still unread after its 6 hours expires,
  which loses nothing (the title is on the Artifact). Every other notice
  above is pushed at once. Who can see the Artifact (and the flag) is
  checked when a notice is queued, in the transaction that writes it, and again after the
  commit right before the push (`sendQueued`); one that can't see it then is
  dropped and its queued event deleted. Followers and last pushers who
  can't see it are left out silently (in neither `notified` nor
  `notNotified`); only an explicitly mentioned agent is reported, as
  `cannot_see`. Between the commit and that check the event sits in the
  agent's queue, which the agent's next pull could take: milliseconds.
  - Every later hand-over is checked too: `artifactNoticeDeliveryVerdicts`
    is `system.artifacts`' delivery guard (core's
    `services/systemAppDeliveryGuards`, registered as `agentNotice.deliverable`
    in `register.ts`, which also makes `system.artifacts` require it). Core
    asks it on the first push, the push sweep, the reconnect and `/events`
    rebuild, every re-send from the agent's buffer and a re-read by
    `agent-event:<id>`; an agent that can no longer see the Artifact (or a
    server whose flag is off) gets nothing, the event expires, and a re-read
    answers as for an unknown id. The 6-hour TTL (`ARTIFACT_NOTICE_TTL_MS`)
    only bounds how stale an undelivered notice gets.
  A notice never moves its recipient's read position, whatever its kind
  (mention, follower comment, review, changed file, legacy batch; Tenny,
  replacing freshness v2 §1's "a notice counts as seen" and #55's
  `fullyDelivered`): it is only a notification, and no hand-over proves the
  model read it. So a following agent told of others' comments, even short
  ones shown whole, is held (UNSEEN_CHANGES) by them until it reads the
  Artifact (`raft artifact pull` / `read`: the short ones then count as
  seen) or lists the comments (`raft artifact comments`, which the hold
  names when some stay `unread`). One rule for every agent; the cost is at
  most one held push.
- Content origin (S2,
  [workspace-artifacts-content-origin.md](../../../../../docs/development/workspace-artifacts-content-origin.md)):
  html, markdown and pdf versions (`ARTIFACT_FRAMED_KINDS`, from the entry by
  `artifactFileType`) open in a frame on their own origin, served by a
  Cloudflare Worker from R2.
  - `webRoutes.ts`: `POST /api/artifacts/:id/frame { version?, path? }`. Its header
    lists the checks in order: the Artifact as a read resolves it
    (`webCommon.readableItemFor`: Artifacts off on the deployment is 403),
    visibility (one 404 `NOT_VISIBLE`),
    the body (400 `INVALID_REQUEST`), the version (404
    `VERSION_NOT_FOUND`; a reader outside an anyone-with-the-link Artifact's server gets
    the current one only), the kind (409 `NOT_FRAMED`), `path` when it names
    another file than the entry (`webViewer.ts` `framePageOf`: an HTML page, a
    Markdown file or a PDF of that version, else 400 `INVALID_PATH`, 404
    `FILE_NOT_FOUND` or 409 `NOT_FRAMED`; the frame then opens at that file's
    page, shared `artifactFramedPagePath`, both tickets naming it as `page`),
    then the frame
    (`webViewer.ts` `readerFrameOf`; 503 `CONTENT_UNAVAILABLE` when the
    content origin isn't configured). The answer is url, origin, reports and
    door: `url` is `<origin>/_raft/open?ticket=<ticket>` on that Artifact's own
    `w-<uuid>` label, the ticket signed here, never logged; `door.url`
    `<origin>/__porthole/door/_raft?ticket=<door ticket>`, the frame's door
    (Porthole P125, P126: the same claims, `door: true`, its own nonce),
    which the web's Porthole frames first; no call to the content Worker. The viewer (`GET /:id`) carries the same frame for its
    shown version (`frame`), and so does the standalone page's `open`
    (`webOpen.ts`; an outsider's is the signed-out page's anonymous one);
    no other answer does (save-attachment's
    `artifact` is the viewer's answer without it, `viewerWithoutFrame`;
    home and `unpublish` (link sharing off) answer `viewerDataOf`). "Inside the server" is a live
    membership: core's `requireServer` checks it on every request. 120 a
    minute per user, the frame route, the viewer and `open` together, since each
    signs a ticket (`mount.ts`, 429 `RATE_LIMITED`). The content Worker also
    limits opens per viewer and keeps an opened nonce past its expiry
    (the content origin doc's "Tickets").
  - `contentWorker.ts`: the contract with the Worker: subject
    `v1:<server>:<user>:<session family or ->` and viewer `user:<id>`, the
    frame (`signContentFrame`: the ticket of shared
    `artifactContentTicket.ts`, HMAC-SHA-256 with a key and kid derived from
    `ARTIFACTS_CONTENT_WORKER_TOKEN`, which the Worker's `RAFT_TOKENS`
    lists; the origin `w-<uuid>.<ARTIFACTS_CONTENT_DOMAIN>`, https, http only
    on a `localhost` content domain; token and domain both or nothing;
    `ARTIFACTS_CONTENT_WORKER_URL` is no longer read), and the tokens the
    Worker calls back with (`ARTIFACTS_CONTENT_RAFT_TOKENS`, a comma list for
    rotation). Every token at least 32 bytes (shorter ones are ignored, with a
    warning naming the setting, never the value), compared in constant time
    as sha256 digests. At startup (`checkContentWorkerConfig`, from
    `mount.ts`) a content domain that is one of Raft's app hosts
    (`platform/links` `appHosts`: the canonical host, `APP_URL`'s, Raft's
    earlier hosts, `APP_PERMALINK_HOSTS`), or a parent or subdomain of one,
    throws: the server refuses to start, naming both. Hostnames are
    compared, lowercase, without port or trailing dot. Tickets, kid rotation
    and the Worker's checks: the content origin doc's "Tickets".
  - `contentRoutes.ts`: `POST /internal/artifacts-content/authorize` (every
    content request; `bad-subject`, `signed-out`, `deleted`, `not-visible`, in
    that order; `not-visible` also when the flag is off for the Artifact's
    own server, or for the subject's server on an Artifact without link sharing (an
    anyone-with-the-link one is read by its own server's flag alone, task #74), or its
    user no longer stands in that server,
    `visibilityService.standsInOwnServer`, which binds the subject to its
    server for anyone-with-the-link homes too) and `GET …/versions/:version?artifact=`
    (the manifest: a pushed version of a live Artifact with a framed
    kind, else 404; only `store = 'r2'` ready blobs of the Artifact's own
    server, `key` = `r2_key`, relative: the Worker reads
    `apps/artifacts/<key>`), and `GET …/embeds/:artifact` (whether an
    Artifact embeds on any site, #proj-workspace:#260: `{ artifact, version,
    kind, title }` only where `publicItemOf` passes and the kind is framed,
    else the one 404; counted as `content_embed` in
    `slock_app_operations_total`). An embed session's subject
    (`v1:embed:<artifact>:<version>`, minted by the Worker alone; no frame
    route signs one) is decided exactly as a signed-out visitor's
    (`decideAnonymous`). Two switches, turned off together: the server's
    `ARTIFACTS_EMBED_ORIGIN` (the client config's `artifactsEmbedOrigin`;
    unset, the web offers no Copy embed code and `embeds/:artifact` is the
    one 404 for every Artifact) and the Worker's `EMBEDS` (the hard kill
    switch: no embed grant at all). With no token configured these answer 404; a
    wrong or missing token 401, logged with route and source only. Rate
    limit per caller and replica: 6000 a minute for the Worker (by token),
    30 for anyone refused (by address). A publish check's subject
    (`v1:check:…`) is decided by `decideCheck`: that version only, any home,
    an entry a check opens (`ARTIFACT_CHECKED_KINDS`) while its check runs
    (`not-checking` otherwise), a check Worker configured and Artifacts on for the Artifact's own server.
  - `checks.ts` and `checkFrame.ts`: the publish check (task #130,
    wherever the deployment has a check Worker, `checkWorkerToken.ts`; docs/development/workspace-artifacts.md,
    "Publish check"): `version_checks` rows (recorded by an agent's push in
    a savepoint of its transaction, `publish.ts` commit calling
    `recordVersionCheck`, for HTML entries only, shared
    `ARTIFACT_CHECKED_KINDS`, not Markdown, nor PDF for now; skipped `unchanged` or over
    the daily caps, `mayCheck`; not by a save or an import), and its
    screenshots:
    core object files of the Artifact (`platform/objectFiles`;
    docs/development/first-party-apps.md, "Object files") hung on the
    version (`checkShotPart`: `version:<version id>`), the row keeping their
    ids (`desktop_file_id`, `phone_file_id`, `checkShotFileOf`). People read
    them through core's `GET /api/objects/artifact/:id/files/:fileId`, which
    checks the Artifact's visibility; Artifacts has no web screenshot route
    (agents: `checkRead.ts`, below). The cards name them as their preview
    (`cardCheckShots`, `webCards.ts` below).
    Keeping the newest three versions' screenshots (`keepNewestCheckShots`:
    the older rows' ids cleared and their versions' files let go in one
    transaction, the bytes after), and deleting the Artifact
    (`deleteArtifact`: its checks, and every file of the Artifact through
    `deleteObjectFiles`, in its transaction; core deletes the bytes after the
    commit, a soft-deleted server's files in its own sweep). `checkFrame.ts` `signCheckFrame` signs the check ticket
    (viewer `system:check`, no ancestor: the check's headless browser opens
    it top-level; none for a kind no check opens: `not_framed`,
    `not_checked`), through `contentWorker.ts` `signCheckContentFrame`; only
    the check's durable task may import it (`checkFrame.structure.test.ts`),
    and the frame routes' `signContentFrame` refuses a check viewer or
    subject.
  - `checkTask.ts` and `checkRoutes.ts`: the check's durable task (the row
    itself, RFC 073's claim, lease and fence on it, driven by the check
    Worker pulling) and the check Worker's API,
    `POST /internal/artifacts-check/lease` (the oldest check that may run
    moves to `running` with a two-minute lease; its answer the ticket's url,
    never logged; 204 with none; one that never can is failed on the way,
    a PDF's `not_checked`) and `POST …/:checkId/result` (multipart:
    the report and a PNG per viewport; only while that lease is current, else
    409 with nothing written; screenshots stored as the publisher's files,
    hung on the version and the row finished in one transaction, then
    `keepNewestCheckShots`), behind `ARTIFACTS_CHECK_WORKER_TOKEN` (unset or
    unusable: 503). Contract: shared `artifactCheckContract.ts`;
    docs/development/workspace-artifacts.md, "The check Worker's API".
    How long a check takes, end to end (`trace.ts`): the
    `server.artifacts.check.result` span of a check it finished (`done` or
    `failed`) carries, beside `load` and `outcome`, the version's `kind`,
    `check_ms` (whole milliseconds from the row's `created_at`, the push, to
    its `finished_at`: waiting and running) and `run_ms` (whole milliseconds
    from the lease that result holds being taken, its expiry less
    `ARTIFACT_CHECK_LEASE_MS`, to `finished_at`: the last attempt's when a
    lost lease was leased again, so `check_ms - run_ms` is the wait before
    that lease). The span's `duration_ms` stays the result request's own
    time. No span carries an id, so a check's record, lease and result
    spans (three requests' traces) are not joined; a check that never
    reports (`expired`, `lease_expired`, `check_expiry`) has no result span.
  - `checkRead.ts`: the agent's read of a version's publish check (contract:
    shared `agentApiArtifactChecksContract.ts`; the push's answer names its
    version's check, `check`; `versionCheckOf` reads the row for both), `artifactCheck` (`GET …/:artifact/check`,
    `?version=`: the row as stored or `check: null`, the screenshots by
    name) and `artifactCheckShot` (`GET …/:artifact/check/:shot`: the PNG
    through core's `readObjectFile` for the agent, the row's file id on that
    version's part only; else one 404 `SCREENSHOT_NOT_FOUND`). The Artifact
    as a write resolves it, from inside (another server's agent on a public
    one: 404 `NOT_VISIBLE`); without a check Worker nothing is
    served (null, 404). Not counted per agent, as every read;
    docs/development/workspace-artifacts.md, "The push and the agent's read".
- Web API phase 1 (`webRoutes.ts` the entry, `webCommon.ts` what the
  operations share; contract `webArtifactsContract.ts`), for a signed-in
  person (ViewActor `{ type: "user", id, serverId }`). Every route: the flag
  (403 `ARTIFACTS_NOT_ENABLED`), then visibility (one 404 `NOT_VISIBLE`),
  answers `private, no-store`. The read routes the viewer and its own page
  use (the viewer, a file's bytes and content, the frame, the comment list,
  presence: `webCommon.readableItemFor`) and the write routes
  (`visibleItemFor`) resolve the Artifact the same way: the deployment has
  one answer, so with Artifacts off every id is the same 403, an
  anyone-with-the-link one included. A reader outside the Artifact's server (only
  ever an anyone-with-the-link one) reads its current version only and no comments
  (`apiCommon.accessOf`, a fixed rule), as the frame route and the agent
  API; and never comments, follows, sees presence, mention candidates or
  who a comment would notify (403 `FORBIDDEN`, or an empty answer for
  presence and the comment list). It is shown the card's author and the
  versions' pushers by name and avatar, without their ids
  (`webCommon.shownActorOf`, shared `ArtifactShownActor`; Remy, after
  Tenny's review), the viewer's card and the message card alike. Writes (comments, edits, deletes, review drafts and
  submits, following, moving, renaming and deleting an Artifact) are limited to 60 a minute per user (`mount.ts`, 429
  `RATE_LIMITED`).
  - `webViewer.ts`: `GET /:id` (ArtifactViewerData: `?version=`, else the
    current one; `frame`, the frame route's frame for the shown version, for
    a framed kind while the content origin is configured, only on this
    route's answer; `capabilities.comment` for people of the
    server, `changeHome` and `delete` by `mayManageArtifact` (`manage.ts`;
    `changeHome` only while a larger home exists), `publish` (renaming it:
    `rename.ts` `mayRename`, a non-guest member of its own server or its
    author); `savedFrom` only when
    the reader can see the message's conversation, `platform/attachments`
    `attachmentSource`; `origin`, the original message, by the same rule:
    see "Original message"). Opening the current
    version moves the reader's read position to the end (a person's viewer
    shows the comments whole; an agent's read moves only over what it shows
    whole, see "What an agent has seen").
    The viewer opens on few round trips: `readableItemFor` reads sight and
    the flags at once (an item of the reader's own server needs its flag
    once), `viewerDataOf` reads every readable version once (the current and
    a pinned one among them, and the summaries' order), then the rest at
    once, the read position's move among them (the viewer's answer
    `viewerAnswerOf`, which the open route, `webOpen.ts`, answers with too);
    `capabilities` ask
    `mayManageArtifactActions` (one standing read for delete, widen and
    rename: `rename` is `rename.ts` `mayRename`'s rule on that standing,
    `renameAllowed`).
    Guard: `VIEWER_MEMBER_STATEMENTS` in `web.api.test.ts` (a member's open,
    the same however many versions).
    `GET /:id/details` is the same answer without `frame` and without moving
    the read position, for a caller that draws no frame (the App's own bar:
    counts, versions, following); it signs no ticket, so it is outside the
    frame budget.
    Files are read only through a ready blob of the Artifact's own server,
    on both APIs.
    `GET /:id/files/:path` sends the exact bytes as an attachment, with
    nosniff and `Content-Security-Policy: default-src 'none'; sandbox`, typed
    so a browser never runs them: the inline image types as they are, csv as
    csv, other text (html, svg, markdown, scripts) as `text/plain`, the rest
    `application/octet-stream`. `…/content` inlines text and csv (cut at
    256 KiB at a character boundary); any other kind answers only its size
    and type. A store that isn't configured is 503 `CONTENT_UNAVAILABLE`; a
    path segment that isn't valid percent-encoding is 400 `INVALID_PATH`
    (after the flag and visibility).
    `GET /:id/download.zip` (`?version=` as a file's; #proj-workspace:#239)
    is every file of the shown version in one zip, for the viewer's Download
    all (zip): resolved as a file is (readableItemFor, shownVersionOf: the
    same flag, one 404 and version refusals), then `versionZip.ts`, shared
    with the signed-out `download.zip`: the version's own file rows by path,
    their ready blobs of the item's server only (else 503
    `CONTENT_UNAVAILABLE`), at most `ARTIFACT_ZIP_MAX_BYTES` (100 MiB) of
    files summed from the rows before anything is read (else 413
    `DOWNLOAD_TOO_LARGE { limit }`), streamed by `storedZip.ts` (STORE,
    one file in memory at a time, an exact Content-Length), named
    `<title> v<n>.zip` (the title's safe characters). At most
    `ARTIFACTS_WEB_ZIP_CONCURRENCY` (default 4) archives at once per
    process in its own pool (`zipSlots.ts` `web`; the signed-out route's
    pool is apart, so visitors never keep members from theirs), past it 429
    `BUSY` with `Retry-After: 5`; counted as `web_zip`. A read: no write
    budget and no read position; per user `downloadZip`, 20 a minute.
    `GET /:id/presence`: `viewing` is always empty (it needs the socket
    layer, not built yet); `readCurrentVersion` is who else has a read
    position at or past the current version and can still see it (20, the
    latest first). A notice never moves it; a hold or the comments list
    does, so it can count before the agent fetched a file.
  - `webComments.ts`: the comment list (every version's, 50 a page from the
    newest, `before` = a page's `olderCursor`, a position; deleted
    placeholders included), writing (the same `insertComment` as an agent's:
    position, object event, following, notices; checks in the file's header),
    editing and deleting (author only), `will-notify`, `mention-candidates`
    (who can see the Artifact, and of those only whom core shows the reader:
    for a guest, whom it meets; for a member of a server that hides its
    people, whom it shares a conversation with; `platform/actors`
    `actorsShownToPerson`), `subscription`. `mention-candidates` is a thin wrapper over core's
    mention audience (the same as `POST /api/mentions/audience` with `{
    kind: "object", app: "artifacts", objectKind: "artifact", objectId }`,
    `platform/mentions`, which the web picker can call directly;
    [first-party apps](../../../../../docs/development/first-party-apps.md#mention-audiences)).
    A comment's mentions are actors (`comments.mentions`);
    its text is stored with each as `@handle`, what agents read, and the web
    gets parts back by finding those handles (`createRaftStructuredUserRefRegex`;
    a mention whose actor was renamed since reads as text). A mention never
    grants access: each mentioned actor must stand in the server and see the
    Artifact, or, for an Artifact homed in a joint channel, be another
    server's member of the joint who can see it now (its own server with
    Artifacts on; `platform/mentions` `jointObjectPeers`, the rule `@` offers
    them by, #68 xxchan) (422 `MENTION_NOT_VISIBLE` naming each one that
    doesn't); an edit checks and tells only the mentions it adds. Such a
    peer's mention is kept on the comment (it reads as a mention, and the
    Artifact waits on the peer's dashboard) but tells no one: a peer agent
    gets no notice and a peer person no Activity row (both are the
    Artifact's server's; see the joint paragraph under Visibility). People hear only
    through their Activity (S6): `notified` and `will-notify` name agents only, with
    why each follows (`author`, `publisher`, `commented`, `subscribed`) or
    `mentioned`. A person's comment is not held for unseen changes (no
    `UNSEEN_CHANGES` on the web). A deleted comment with replies stays as a
    placeholder (`deleted_at`, empty body); without, the row goes, and a
    placeholder goes with its last reply. Agents never list placeholders.
    `@` candidates are the platform's mention audience for the Artifact
    (`platform/mentions` `mentionAudience`, an object audience, the rule
    behind core's `POST /api/mentions/audience`: people and live agents of
    its server who can see it, of them whom core shows the reader, and in a
    joint home the joint's other servers' members who can see it, as the
    joint's roster shows them, without roles; home members first, 20),
    answered in this route's shape
    (`ArtifactWebMentionCandidates`) until the web uses the shared picker.
    Mentions and presence are checked with `actorsWhoCanViewArtifact` (many
    actors and one item in a fixed number of queries, through
    `platform/visibility` `viewersOfHome`). 300 a minute per user (`mount.ts`).
  - `rename.ts`: a new title, `PATCH /:id/title { title }` (task #147):
    the flag, visibility (the one 404), the body (400 `INVALID_REQUEST`, a
    blank title too; 400 `FIELD_TOO_LONG` past the agent API's 300
    characters), then under the item's lock, seen still and who may
    (`mayPublish`: the push's permission, the Artifact's own server; 403
    `FORBIDDEN`); the same title writes nothing. `retitleItem`, the agent
    push's too: the title and `updatedAt`, the search row, the `renamed`
    event (no recipients: no one's Activity) and `notices.ts` `noticeRename`
    for the following agents that see it, not the one renaming (`subscribed`
    with `renamed { by, from, to }`), queued and not pushed (it wakes no
    one; `notices.ts` below). Answers
    ArtifactViewerData of the current version. Guard: `web.api.test.ts`
    (rename), `publish.api.test.ts` (title alone).
  - `manage.ts`: moving an Artifact to a larger home
    (`POST /:id/home { to }`), to a smaller one (the same route, below) and
    deleting it (`DELETE /:id`), the rule Tenny
    decided (2026-10-26). Who may (`mayManageArtifact`, over
    `platform/visibility` `canManageObject`): the author, the manager of a
    live agent author (the owner of a personal assistant, otherwise its human
    creator), the owners and admins of the Artifact's own server, each while
    standing in it; an author who left hands it to the owners and admins;
    another server (a joint conversation's other side, its owners and admins
    included, or an anyone-with-the-link Artifact's outside reader) never may. Moving shows
    it to more people, so it needs a non-guest member or a live agent: a
    guest may delete their own Artifact, never widen it (403, and the
    viewer's `changeHome` is false for them). Moving also needs seeing it now
    (the one 404 otherwise); `public` (turning on link sharing) is a person's step, refused to an agent in the
    service so no agent route can; an agent moves only what the person who
    manages it could (403 otherwise, the agent API's bullet above);
    the home only grows (conversation →
    server → anyone with the link (`public`), else 409 `HOME_NOT_WIDER { home, to }`); an old name, if
    it has one, must be free in the larger home (409 `NAME_TAKEN`). Deleting needs no sight of
    it (an admin deletes what they can't see); one who may not gets 403
    `FORBIDDEN` if they see it, else the one 404. Both lock the item row,
    write an `audit` row (`home_changed` or `made_public` with the home
    before and after; `deleted` with `deleted_at`) and an object event
    (`moved`, `data { from, to, fromChannelId }`, the conversation it left
    or null, for the followers; `deleted` for no one).
    Homes are ordered conversation < server < anyone with the link (`public`; `HOME_ORDER`); two
    conversations are the same rank, so moving between them is neither
    wider nor narrower and not offered in v1 (409 `HOME_NOT_NARROWER`).
    The home route splits on `expectedLost`: with it (the count the person
    confirmed from the preview), `{ to: "server" }` or `{ to:
    "conversation", conversationId }` narrows (`narrowArtifactHome`; xxchan
    2026-10-27: an Artifact made server-wide could not go back); without
    it a move only widens (Kirby, #45): `public`, or `server` from a
    conversation, through `widenArtifactHome` as above, while `server` on an
    anyone-with-the-link Artifact (a stale choice) and any `conversation` are 409
    `HOME_NOT_WIDER { home, to }` and change nothing, after who may move it
    (one who may not gets 403 `FORBIDDEN` first, as from either move:
    `mayNotMove`). Narrowing, checked in this
    order with the item row locked (`narrowingTarget`, which the preview
    runs without the lock): the actor sees it now (the one 404); may move it
    (`mayManageArtifact` "widen": its author, an agent author's manager, the
    owners and admins, none a guest; 403) and is a person (an agent or a
    delegated actor: 403; no agent route narrows); the home is larger than
    `to` (409 `HOME_NOT_NARROWER`); a conversation: only the Artifact's
    original conversation (#75, see "Original conversation"; any other 409
    `NOT_ORIGINAL_HOME { originalConversationId }`, the id only as
    `shownOriginalHome` would show it to this actor, else null); a top-level
    conversation of the Artifact's own server (`topLevelConversationOf`)
    the actor can see now (else 404 `TARGET_NOT_FOUND`, the same answer
    for a thread under one it can't see), not a thread (400
    `TARGET_NOT_SUPPORTED { reason: "thread" }`; import takes a thread as
    its conversation, a home move names the conversation itself) nor a
    joint channel (400 `{ reason: "joint" }`, D13: no joint in v1), with no
    guest in it nor open to guests (403 `TARGET_HAS_GUESTS`, the import's
    rule from #11288, `conversationGuestAccess`); its author keeps it
    (Tenny 2026-10-27): an author who sees it now must see it there, and an
    agent author must be in the conversation (`isConversationMember`: a
    public channel's readers include agents that never joined), else 409
    `AUTHOR_LOSES_ACCESS { reason: "cannot_see" | "agent_not_member" }` (an
    author who left, or a deleted agent, sees nothing already: no check);
    an old name, if it has one, free in the new home (409 `NAME_TAKEN`,
    the unique index behind it). Then, in the one transaction: the home moves; the `moved`
    event goes to the followers who still see it; the Activity rows of
    those who don't go (`forgetArtifactActivityOfThoseWhoLost`, announced
    after the commit as a delete's are); the audit row `narrowed` with the
    home before and after, `lost_access { people, agents, capped,
    left_public }` (`serverViewersLost`, the preview's count: at most 500
    of the server's people and agents are checked while the lock is held,
    so with `capped` true the counts mean "at least"; Tenny, review round
    1) and `activity_rows_removed` (exact). With `expectedLost` in the
    body (the preview's people + agents the person confirmed; only it
    narrows), the request is a narrowing whatever the home is now (a home that changed since the
    preview is refused, never widened), and under the lock the same capped
    count must still be that number, else 409 `LOSS_CHANGED { expected,
    actual, capped }` and nothing changes. Search has no home column of its own (its
    reads join the item's home), so it follows the move; the Activity rows'
    home columns move with the event. Those who lose it then read the
    Artifact as no access everywhere: the viewer's one 404 NOT_VISIBLE,
    `unavailable` summaries for cards and links already sent, no search
    hit, no Activity row. A follower who lost it keeps the follow row (it
    counts again if the Artifact comes back); later events still list it
    as a recipient, and Activity's read-time visibility hides those rows.
    Narrowing can't take back what someone already read: a person or an
    agent who read its pages or comments keeps what they saw (an agent's
    memory, a copy, a message quoting it), and we don't promise otherwise.
    `GET /:id/home-change?to=server|conversation&conversationId=` previews
    it (`previewNarrowing`): the same checks and refusals, then
    `{ peopleLosingAccess, agentsLosingAccess, capped?, leavesPublic }`:
    of the server's people (any role) and agents (as member lists show
    them), at most 500 (`homeChangeLimits`, ARTIFACT_HOME_CHANGE_MAX_COUNTED,
    as share-audience's budget), those who see it now and wouldn't there;
    nobody outside the server is counted (`leavesPublic` says signed-out
    visitors and other servers lose it too). 300 a minute per user
    (`homeChange`). `POST /:id/unpublish` (turning off link sharing) is unchanged (its own audit
    `made_private`, no author check: turning off an Artifact's link sharing
    is never blocked); `to: "server"` on the home route is the narrowing
    above, with its rules. The viewer's `capabilities.narrowHome`: the same
    people as `changeHome`, while the home is server or anyone with the link and
    `originalHome` is set (the original conversation, `shownOriginalHome`);
    anyone with the link back to the server is then `unpublish`'s on the web.
    A delete sets `deleted_at` (every read already leaves such items out:
    `visibility.ts`) and drops the item's pending notices and search row. The
    flag is the route's (`webRoutes.ts`, or the agent API's `manage.ts`
    `createManageOperations`, above), checked first. The home route
    answers the viewer's payload (`viewerDataOf`) without moving the read
    position. Guard: `manage.api.test.ts`.
  - `webCards.ts`: the one card builder (the viewer's `card` and the
    dashboard's rows are built by it). Its `preview` is `none` but for a
    version the publish check finished with its desktop screenshot kept:
    `{ kind: "screenshot", desktop, phone }` (core object file ids; the
    client builds `objectWebPaths.file("artifact", id, fileId)`), from
    `checks.ts` `cardCheckShots` (one query for all the cards, beside the
    comment counts; the version each card shows, a pinned one's too), only
    on a deployment with a check Worker (`checksConfigured`), and never for another server's reader of a public one
    (`readsAsOutsider`: core serves it none of the files). Guard: `webDashboardAll.api.test.ts` ("a card
    shows the publish check's screenshots", and its one-query test). It is
    also the registration's `parseRef` and
    `summarize` (core's `POST /api/objects/summaries`, which the web reads
    its message cards from: the links in a message's text; messages carry no
    `artifactRefs`, no write-time index in v1, decisions of 2026-10-26 in
    `docs/development/workspace-artifacts.md`). It only reads: no read
    position moves (the viewer moves it). `summarizeArtifacts` builds the cards with `visibleCards` for
    the ids core kept, in a constant number of queries however many
    references (pinned by the tests): the items again (live), current and
    pinned versions, profiles, comment counts, and conversation names (DM
    peers in one batch, `getReadableDMPeerNamesForUser`). A deleted
    Artifact's message card (`summarizeDeletedArtifacts`, three queries):
    only to a reader who could see it were it not deleted, by the same rule
    on the home it had when deleted (core's, over `deletedArtifactHomes`;
    the reader's standing is today's, so one who has left its conversation
    since gets none); its title, who deleted it and when. Everyone else gets
    the `unavailable` they got before, the same body as an id that names
    nothing, so a delete tells nobody else the Artifact existed. A revoked
    Artifact (taken down, `revoked_at`) is `unavailable` to everyone, never
    `deleted`, even after a delete. One deleted with no `deleted` audit row
    (none the routes make: `manage.ts` writes it with the delete) names no
    one, so it is `unavailable` too. Another server's reader of an
    anyone-with-the-link Artifact gets its `deleted` while both servers have the flag on, as it
    got the live card, the deleter by name and avatar without an id. Signed
    out, nothing changes: no summaries (401), and the signed-out view
    (`publicRoutes.ts`) the one 404. Guard: the `deleted card` tests in
    `web.api.test.ts`, `services/objectSummaries.db.test.ts`. The summaries
    route has core's own 300 a minute per user. (`POST /api/artifacts/refs`,
    the batch of message links by URL that came before it, is gone: the web
    was its only caller.)
  - `webDashboard.ts` (S7): `GET /dashboard` (ArtifactWebDashboard, every
    section's first page) and `GET /dashboard/:section` (one section's next
    page by `cursor`), for the reader in the request's server; `home`
    (`channel`, `dm`, `server`, `public`) narrows every section. Sections,
    20 a page, newest first, one row per Artifact, each with the card webCards.ts
    builds for the current version: `waiting` (live comments by others that
    mention the reader, after its read position: the newest and how many),
    `following` (followed, with versions or live comments by others after its
    read position: how many of each), `recent` (the reader made a
    version of it or opened it, the later first). visibleArtifactsSql (the
    list form of canViewArtifacts; visible conversations as one uuid[]) is
    part of each section's query, so caps and cursors count only what the
    reader can see; Artifacts with no version yet and orphans are left out. It
    only reads: no read position moves. A constant number of queries
    (pinned by the test). Paging is by keyset (time, id): an Artifact with
    new activity while someone pages moves to the top and may be skipped for
    the rest of that run through the pages, never listed twice. Drafts (S8)
    and review requests have no data yet and are not sections. 120 a minute
    per user (`mount.ts`).
    - Cost: every section starts from the reader's own rows and joins
      the items with visibleArtifactsSql only after, so it follows the
      reader's activity, not the server's size (migration
      `artifact_dashboard_indexes`, now part of the branch's one migration `workspace_artifacts`). `waiting`: the comments that mention
      the reader (`idx_comments_mentions`, GIN `jsonb_path_ops`,
      containment on the stored `{ type, id }`), unread and by others,
      grouped per Artifact. `following`: what the reader follows
      (`idx_subscriptions_actor`). `recent`: what it opened
      (`idx_read_positions_actor`) and made versions of (`idx_versions_publisher`).
      Measured, 10k visible Artifacts of 20 comments each, the reader
      mentioned on 200 and having opened none (PostgreSQL 17; pglite
      alike): `waiting` 232000 buffers before, about 3500 now (582 to
      17 ms), `following` about 3400, `recent` 30500 to 6 (about 30 to 3 ms;
      1221 buffers with 50 opened and 50 with versions made).
    - The All tab (task #115): `GET /dashboard/all?home=&conversation=&q=&sort=&dir=&relevant=&cursor=`
      (ArtifactWebDashboardAll `{ rows: [{ card, openedAt, news }], nextCursor, counts }`, mounted
      before `/dashboard/:section`): every Artifact the reader can see,
      not only what concerns it. One statement: visibleArtifactsSql with
      the `home` narrowing, `hasReadableCurrentVersion`, and with `q`
      (trimmed, at most WEB_SEARCH_QUERY_MAX_CHARS) the title search's
      words as one condition (`search.ts` `titleMatch`, the words the
      agent list's `query` and core's search match); ordered by `sort`
      (`webDashboardAllOrder.ts`; ARTIFACT_DASHBOARD_ALL_SORTS): `updated`
      (the default: update time in milliseconds), `title` (`lower(title)`,
      the card's title) or `comments` (the card's `commentCount`: live
      comments, a LATERAL count in the same statement), each then by id,
      in `dir` (`asc`, `desc`; absent: newest, the most comments first,
      titles from A), with a query too (no rank), 50 a page. Keyset
      cursor: newest update first keeps the agent list's plain one
      (`[updatedAt, id]`, so older and newer replicas page each other's);
      every other order `[sort, dir, key, id]`, which pages only that
      order. Flag 403 first, then a bad `home`, `q`, `sort`, `dir`, or a
      cursor that doesn't parse or is of another order 400
      `INVALID_REQUEST`; the dashboard's 120 a minute.
      Guard: `webDashboardAll.api.test.ts`.
    - The home page's one list (#proj-workspace:#210, the same route; `/dashboard`
      stays for mobile and older web tabs). `sort=opened`: the read position's
      `updated_at`, the `recent` section's opened time (it also moves on a
      follow, a comment from the end of the list, a review, Activity's mark as
      read and an import; there is no other record of an open), LEFT JOINed on
      its primary key on every sort since each row says it (`openedAt`),
      COALESCEd past every time on the side the direction ends at, so what
      was never opened comes last both ways, by update; cursor `[opened, dir,
      openedAt|null, updatedAt, id]`. `relevant=1` (和我有关,
      #proj-workspace:#276): every Artifact the reader is involved with, read
      or not (`webDashboardNews.ts` `involvedSql`): it made it (published any
      version of it, `versions.publisher`, the card's "who updated"; the
      creator is always v1's publisher, so someone who published only v2
      counts too; and so do versions published by an agent the reader created
      that is still live in this server, `platform/visibility`
      `agentsCreatedBy`), it follows it (subscriptions, not stopped), or a
      live comment by someone else mentions it. Before #276 it kept only what
      had news, so a reader who had read everything saw an empty page. A
      condition beside `visibleArtifactsSql` in the statement that limits (the
      same one every dashboard list uses, for all three ways in), one
      row per Artifact, in its own order: what has news first
      (`dashboardNewsSql`, which `waiting` and `following` read too, LEFT
      JOINed), among it waiting first then by update; then the rest by update;
      ties by id (`sort` and `dir` are checked and order nothing); cursor
      `[relevant, desc, asOf, news 1|0, waiting 1|0, updatedAt, id]` (the
      filter's older five-long cursor is 400). A later page's segments count
      only activity made by `asOf`, the first page's database `now()`
      (`dashboardNewsSql` `asOf`), still bounded by the reader's current read
      position: news arriving while someone pages moves nothing up, and a read
      between pages can move an Artifact down, never skip it (one already
      listed comes back once lower; the web drops a row it has by card id).
      A 400 on Load more (a cursor of an older shape, across a deploy) reads
      the first page again. Every row has `news`
      (`{ mentions, versions, comments }`, one query narrowed to the page's
      ids), so a card reads the same with the filter on or off. A first page has
      `counts { total, filtered, relevant }`, one statement (`allCounts`),
      null on the pages after it: `total` has no filter, whatever was asked;
      the other two honour `home`, `author`, `conversation` and `q`;
      `relevant` counts what has news (the toggle's badge: something new for
      you), `filtered` with the filter on everything it lists. The page's limits are
      the All tab's (50 a page, the dashboard's 120 a minute), a constant
      number of queries: two more on a first page, one more on a next one.
      Cost: the counts read the server's visible items once, as `dashboardAuthors` does, plus
      `waiting` and `following`'s own work. A `relevant` page starts from the
      reader's own rows: its and its agents' publishes (the agents one query,
      `idx_agents_creator`, then an IN list on `idx_versions_publisher`),
      follows (`idx_subscriptions_actor`) and mentions
      (`idx_comments_mentions`), one hashed set, then the items by primary
      key. Not measured yet.
      Guard: `webDashboardAll.api.test.ts`.
    - The `author` filter (task #133), on `/dashboard`, `/dashboard/:section`
      and `/dashboard/all`: `author` once per value, at most 20, each `me`,
      `my-agents` (`platform/visibility` `agentsManagedBy`, one query),
      `user:<uuid>` or `agent:<uuid>` (else 400 `INVALID_REQUEST`), several
      any of them; the item's author (`created_by`), as a condition beside
      visibleArtifactsSql in the statement (`authorCondition`): it only
      narrows. `GET /dashboard/authors?q=` (ArtifactWebDashboardAuthors,
      mounted before `/dashboard/:section`): the All tab's Artifacts grouped
      by author in one statement, then one profile lookup, `q` on the handle
      or display name (any case), the most first then by display name, 50 at
      most; the dashboard's 120 a minute. Guard: `webDashboardAll.api.test.ts`.
    - The `conversation` filter (#proj-workspace:#221), on `/dashboard/all` only:
      one uuid (else 400 `INVALID_REQUEST`), as a condition beside
      visibleArtifactsSql in the page's and the counts' statements
      (`conversationCondition`): `platform/conversations`
      `readableConversation`, then the home or, for a joint, every id its
      Artifacts may name (`jointHomeAliases`). One the reader can't read,
      another server's, deleted or unknown is `FALSE`: an ordinary empty page
      with `total` as ever, the same answer whatever the reason.
      `GET /dashboard/conversations?q=` (ArtifactWebDashboardConversations
      `{ conversations: [{ id, name, type, peerDisplayName?, peer?, count, updatedAt }] }`,
      mounted before `/dashboard/:section`, the shape of `/dashboard/authors`):
      the All tab's Artifacts in conversations grouped by home in one
      statement, `conversationNames` for those homes only (a joint's aliases
      merged into the reader's projection), then only what the filter would
      take (`readableConversations`, `readableConversation`'s rule as one batch),
      `q` on those names (any case, a leading `#` dropped), newest update first, 50 at most, one profile lookup
      for the DM peers shown; the dashboard's 120 a minute. Names are core's, so
      `q` and the cap apply after the lookup, as the authors'. Not measured
      yet. Guard: `webDashboardAll.api.test.ts`.
  - `webConversation.ts`: `GET /conversations/:channelId?cursor=`
    (ArtifactWebConversationArtifacts `{ rows: [{ card }], nextCursor }`),
    the Artifacts that live in one conversation, for its Files panel (F30):
    live Artifacts whose home is that conversation with a current
    version, never ones only linked or sent there. Checks: the flag (403),
    the cursor (400 `INVALID_REQUEST`), then the conversation:
    `platform/conversations` `readableConversation`, a top-level
    conversation of the reader's server (a thread's: its parent) the reader
    can see now by core's channel access; anything else, unknown, another
    server's, not an id or undecodable, is one 404 `TARGET_NOT_FOUND
    { conversationId }`. The rows are filtered by `visibleArtifactsSql` in
    the same statement, as every list, so seeing the conversation only lets
    the reader ask. A joint is asked by the reader's projection; the filter
    takes every id the joint's Artifacts may name (`jointHomeAliases` of
    its canonical channel, as the agent list's `target`), and each server's
    are kept only while its flag is on; cards name the home by the
    reader's projection. Newest first by `updated_at` (milliseconds, then
    id), 20 a page, the agent list's keyset cursor (`search.ts`
    `encodeListCursor` without a query). Reads only, a constant number of
    queries; the `dashboard` limit. Guard: `webConversation.api.test.ts`
    (member and non-member, another server's, a thread, a joint from both
    sides and with a flag off, deleted, revoked, version-less and linked
    ones left out, paging with ties below a millisecond, bad cursors, flag
    off, the shared limit).
  - `webLocate.ts`: `GET /:id/locate` (ArtifactWebLocation `{ serverSlug }`),
    which of the reader's servers the canonical link
    (`https://app.raft.build/artifacts/<id>`, `/v/<n>`), which names no
    server, opens in. Asked with any server the reader is in; tries every
    server they are in (`platform/links` `serversOfUser`): the Artifact's
    own first, then the one asked with, then, for a conversation home (a
    joint), the rest; an anyone-with-the-link Artifact only the first two, a server home or
    an orphan only its own. Visibility is canViewArtifacts' for the reader in
    each (actorsWhoCanViewArtifact), the flags one batch. The first server it
    is seen from with Artifacts on there and on its own server answers; an
    anyone-with-the-link one whose own server has them on, seen only from servers of the
    reader's that have them off, answers `{ serverSlug, serverArtifactsOff:
    true }` (the server it is seen from: it opens there read-only, by its
    own server's flag, task #74); none seen (whatever the reason, an off
    server elsewhere included, and an anyone-with-the-link one whose own server is off for
    anyone outside that server) is the one 404; seen but off there is 403
    ARTIFACTS_NOT_ENABLED with `details.serverSlug`, so the web shows that
    server's "not on" page. Reads
    only. 120 a minute per user (`locate`). Guard: `locate.api.test.ts`.
  - `webOpen.ts`: `GET /:id/open` (ArtifactWebOpen `{ opensIn, viewer }`),
    the standalone page's one call in place of `/auth/me`, `/servers`,
    `locate` and the viewer in turn. Core's account route
    (`platform/apps` `WebApiMount.accountRoute`): the person's auth and
    verification, no X-Server-Id and no server scoping; every answer
    `private, no-store` with `Vary: Authorization, Cookie`, 401 signed out.
    Only the Artifact's own server is asked about: a member of it
    (`platform/links` `serverOfUser`) who reads it there (readableItemFor
    with that server as theirs: the home, that server's flag) gets `opensIn`
    (its id, slug, name) and the viewer route's answer there
    (`webViewer` `viewerAnswerOf`: `?version=`, the read position, `frame`);
    anyone else an Artifact with link sharing on whose own server has Artifacts on, with a
    current version (`publicRoutes` `publicItemOf`), as an outsider:
    `opensIn: null`, viewerDataOf from no server (no capability, the
    current version only; another `?version=` is the one 404), its `frame`
    the signed-out page's anonymous ticket (`anonymousFrameOf`); else the
    one 404. A member who can't see its home is never answered from its
    server; the reader's other servers and their flags are never asked (a
    joint channel's Artifact seen only through another server is `locate`'s).
    In the `frame` budget with the viewer and the frame route (each signs a
    ticket). Guard: `open.api.test.ts`.
  - `webShare.ts` (S5; checks in its header): `POST /:id/share` posts an
    ordinary message as the reader (`platform/apps` `AppMessagePoster`:
    core's send checks, then its pipeline; into the thread of `threadRootId`,
    made only once every check passed) whose text is the note, a blank line
    and `<appUrl>/artifacts/<id>` (this deployment's origin: https://app.raft.build
    in production, so staging posts staging links). The note is plain text: an
    `@name` in it mentions no one (the web's note box offers no picker). The
    route is behind core's message limit as well as `write` (`messageLimit`:
    the limiter `POST /api/messages` counts against, so sharing can't send
    past what the composer may). Idempotent per attempt: the body's
    `clientKey` (the web picks one per attempt and sends it again on a retry)
    makes the poster's `idempotencyKey`, core's `randomId` (`app:artifacts:
    share:<id>:<clientKey>`), so a retry answers the one message posted; the
    same key for another conversation is 400 `INVALID_REQUEST`. Messages carry nothing of
    Artifacts' (xxchan 2026-10-26): no field, no message table here; the web
    draws the link as the card. Refused: 404 `TARGET_NOT_FOUND`; a note over
    1000 characters 400 `FIELD_TOO_LONG`. `widenTo` ("Make visible to #x
    and send"): once core's send checks passed and before anything is
    written (the poster's `beforeWrite`; a refused send moves nothing), the
    move through `widenArtifactHome`, the home route's own function (its
    checks under the item's lock, its audit row and `moved` event; no
    second rule here); refused as the home route refuses (403 `FORBIDDEN`,
    409 `NAME_TAKEN`, the one 404), nothing posted. A home already that
    wide goes on to the send. The poster checks the idempotency key before
    `beforeWrite`: a key that already made a message (the retry of an
    attempt, or the key reused for another conversation) never runs it, so
    a retry after someone narrowed the Artifact doesn't widen it again: it
    answers the one message (`home` null), and a reused key answers 400
    `INVALID_REQUEST` with the home untouched (Tenny, review round 1). The
    answer's `home` is otherwise the home it is in. The move commits before the message: a send that fails
    after it (a race) leaves the move, which the person asked for. A message
    this attempt posted (not a retry's replay) becomes the Artifact's
    original message while it has none (see "Original message").
    `GET /:id/share-audience?conversationId=`: the members of a conversation
    the reader can see (`platform/conversations` `conversationMembers`) who
    can't see the Artifact (`actorsWhoCanViewArtifact`, each standing in the
    server they take part through, so a joint channel's members on every
    server see an Artifact homed there; one of another server than the
    Artifact's only while theirs has Artifacts on), guests apart, counts
    only; past 500 members only the first 500 are checked (`capped`).
    `widenTo`: the larger homes the reader may move it to now
    (`widerHomeChoices`: widenArtifactHome's checks, `widenRefusal`, without
    the lock, so the offer and the move are one decision), narrowest first,
    each kept only when it lets some of those who can't see it see it that
    a narrower one offered doesn't: `server` for the server's full members
    and agents, `public` (anyone with the link) for guests and other servers' members.
    `widenRefused` (#77): a larger home that would reach some of them that
    no narrower home offered or refused already reaches, but that
    `widenRefusal` refuses the reader, with why: `name_taken` with the
    name (the Artifact's own), anything else `forbidden` with nothing more
    (who may move it; the reader sees the Artifact, so nothing new is told). A
    conversation is never offered: no conversation is larger than a home
    (the order above), and moving to the target conversation would be a
    narrowing for the home's own people (the home route's, with its
    preview). `POST /save-attachment` (the rule is `save.ts`'s,
    above, which an agent's save shares): the saver must see the attachment's
    message, inside the plan's history window (else the one 404
    `ATTACHMENT_NOT_FOUND`, as the attachment routes answer a person). Anyone
    who can see it may save it, a read-only member (a read-only guest) too,
    as an agent who can see a conversation may push into it. An earlier
    save as a live Artifact answers it (or 409 `ALREADY_SAVED` when the saver
    can't see it); one deleted or revoked since is no save, and saving again
    makes a new Artifact (the save row then names it). Else the bytes are copied into R2 (a blob
    of the server, as a push stores them: `storeBlob`, so new bytes count
    against the monthly file upload quota; no room is 403
    `FILE_UPLOAD_QUOTA_EXCEEDED`, nothing saved) and, under a lock on the
    attachment, a new Artifact homed in the attachment's top-level
    conversation (a thread's: its channel), titled after the file (without a
    known extension: `notes.md` is titled `notes`; artifactTitleFromFileName; no name),
    version 1 with the one file under its own name, the save recorded (`attachment_saves`), its original
    message the attachment's (`origin_message_id`, via `attachment`), the saver
    following it as following does (read up to its last position, reported
    to core's Activity: only what comes after is unread). The saver owns the new Artifact: it is a copy, so it stays
    when the original message or attachment is deleted (once Artifacts hold
    core's attachment objects instead of copying, storage step 2a, a save is
    an added hold on the object: the same behaviour). `GET
    /attachment-saves?attachmentIds=`: of up to 50 attachments, the ones
    saved as a live Artifact that the reader can see (inside the window),
    each its Artifact's card or `unavailable` (the web's "Saved as Artifact"
    lines). No
    `artifact:attachment-saved` socket event: there is no app-level realtime
    path yet, so others' lines show at their next load (the saver's own from
    the save's answer). Attachment comments are not copied (E3, later).
    Guard: `share.api.test.ts`.
- `names.ts`: looking an Artifact up by title or old name
  (#proj-workspace:98241a2e: an Artifact is its id and its title; new ones
  have no name, `items.name` NULL). `titledForLookup` (exact title, trimmed,
  any case: `lower(btrim(title))`, no index) and `namedForLookup` search one
  scope: the caller's server's live Artifacts and those of each joint it is
  in (every alias of the joint's channel, `jointHomeAliases`);
  `resolveVisibleItem` (apiCommon) tries the id, then the title, then the old
  name, and answers among what the caller can see; several: 409
  `AMBIGUOUS_ARTIFACT_NAME { ref, candidates: [{ id, title, home }] }`. Old
  names (Artifacts made before titles, imports from raft-artifacts.com) stay
  unique among the live Artifacts of one home that have one
  (`idx_items_live_name_*`, partial unique indexes: NULLs never collide; a
  joint's home is its canonical channel, so one namespace per joint across
  its servers: `isNameTakenInHome` searches `jointHomeAliases`, as the index
  cannot), which a move, a restore and an import check (409 `NAME_TAKEN`).
  The route words under `/artifacts/` (`AGENT_API_ARTIFACT_RESERVED_NAMES`:
  `publish`, `push`, `uploads`, `save`, `save-attachment`) and a name that
  reads as a short id (22 characters of Base58 that fit 16 bytes: a digit,
  then digits and lowercase letters without `0`, `l` or `-`; a lookup takes
  it as the id whenever an Artifact has that id, seen or not, and as a title
  or name only when none does) are never an import's name: 400
  `INVALID_NAME` (`reserved: true`).
- `blobStore.ts`: `ArtifactBlobReader` (bytes and presigned GETs of a blobs
  row) and the blob store (also put and delete), on the object storage core
  hands the app (`platform/storage`). Keys are relative, by decision: a
  row's `r2_key` and the content manifest's file `key` are
  `servers/<server>/blobs/<sha256>/<blob id>`, relative to Artifacts'
  prefix. The platform adds `apps/artifacts/` for every read, write, delete
  and presign; the content Worker, which binds the bucket itself, adds the
  same fixed prefix and trusts no full path from the manifest. So no stored
  or sent key can name another app's objects or the bucket's root, and the
  prefix rule lives in the platform and the Worker, not in rows. The bucket
  is the platform's (`APP_STORAGE_R2_ENDPOINT`, `_BUCKET`,
  `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_REGION` default `auto`; all or
  nothing). Unconfigured: 503 `ARTIFACTS_STORAGE_UNAVAILABLE`. Nothing is
  read from core's attachment storage.
- `blobs.ts`: blobs are per server (`server_id`, one row per server and
  sha256), so `missing` never tells one server whether another has the
  bytes. Within one server it does: an agent that knows a file's sha256 and
  size learns from `missing` whether the server holds those bytes and can
  push them without having them (the agreed consequence of per-server
  deduplication). Storing is two-phase so no transaction waits on R2: a short
  transaction inserts the row `pending` (under the server's quota lock, which
  makes the cap check exact), the PUT runs outside it, then the row becomes
  `ready`; only ready rows are present. Each row has its own key
  (`servers/<server>/blobs/<sha256>/<id>`), so an object is written and
  deleted for one row only. Bytes no version uses count against a per-server
  cap (1 GiB, 413 `UPLOAD_QUOTA_EXCEEDED`; new bytes also count against
  the monthly file upload quota, below); the hourly maintenance (the
  registration's `prune_artifact_blobs`, run by core) deletes them, and
  pending rows (giving back their monthly quota reservation in the same
  transaction), a day after their last upload: rows first (locked, "unused" checked again),
  then their objects; an object whose delete fails is a leak, never a row
  without bytes. R2 requests use core's S3 settings, in a pool of their own: `S3_REQUEST_TIMEOUT_MS` (30 s) and `S3_MAX_SOCKETS` (300).
- Monthly file upload quota (xxchan, Tenny, #proj-workspace:fbc76200):
  Artifact bytes count against the server's monthly file upload quota, the
  same one attachments count against (Free: 100 MB a month; Pro and the
  internal plans unlimited; `services/fileUploadQuotaService`, through
  `platform/fileUploadQuota`), so a Free server can't upload around it
  through Artifacts. The check sits in one place, `blobs.ts` `storeBlob`,
  the only code that writes new bytes to Artifacts' R2: it reserves the
  bytes in the transaction that inserts the pending row and records them on
  it (`quota_month`, `quota_reserved_bytes`, as an attachment upload session
  does; none when the server already has a ready blob of that sha256:
  deduplicated bytes never count again, and still push when the month is
  full), commits them in the transaction that makes the row ready, and
  releases them in the one that deletes it (a failed PUT; the sweep, for an
  upload that never finished, a crashed process's included), so a
  reservation never outlives its row or waits for the month to end. A store
  that finds the row already there (the 1 GiB cap too) gives back what it
  reserved in its claim transaction; a pending row's own reservation covers
  the bytes, committed by whichever store makes it ready. A push checks
  all its new inline bytes together first (`checkFileUploadQuota`), and the
  files it lists that the server lacks by their declared sizes (each sha256
  once) before it answers `{ missing }`, so a push that can't fit (the
  CLI's: it lists every file and uploads the missing ones) is refused
  before any upload; the upload route still checks Content-Length before
  reading the body (a declared size is only a claim). A refusal stores
  nothing; the reservation still decides. The refusal is the
  attachments' (403, `buildFileUploadQuotaExceededResponse`: `error`,
  `errorCode: FILE_UPLOAD_QUOTA_EXCEEDED`, `requestedBytes`, `quota`,
  `billingUrl`, `suggestedNextAction`) plus the Artifacts' `code` and
  `details` (`apiCommon.ts` `fileUploadQuotaRefusal`); agents read it in
  `agentText/artifacts.ts`, and the CLI shows the code as it is. On a Free
  server an agent's push, save or comment image refused this way offers the
  upgrade card an agent's attachment upload over the quota offers (task #22
  #proj-commercial; `platform/fileUploadQuota` `agentQuotaUpgradeHint`, core's
  `agentUploadUpgradeHint`, its lead naming what was refused: the files, the
  saved file, the image): in the conversation it belongs in, the
  Artifact's home conversation (a new one's target; the attachment's own
  conversation, a thread included, for a save), where the server allows the
  card, the conversation is this server's own and not in its cooldown, and the
  agent's Computer runs a CLI that posts it (1.0.53 or later: an app gets no
  request capabilities). The card offer is then `suggestedNextAction` and
  `details.upgradeHint`, which the CLI shows as the next action, followed by
  the refusal's own way on; without it the next action is the billing line
  (say why nothing was stored; a server owner can look at Settings >
  Billing). No card for an Artifact homed in the whole server or public, for
  the raw upload (`PUT uploads/:sha256` names no Artifact: a push's declare
  step refuses first, so the upload's refusal is only the backstop), or
  for an agent's import (no released client imports any more). Other
  writers of new bytes go through `storeBlob` and therefore count with no
  extra code: import copies an artifact's files in through it (and checks
  them all first, as a push does; its web route answers the code too;
  the per-server move's import doesn't count: `storeBlob(…, { quota:
  "exempt" })`, used by nothing else, stores as on a plan without a quota,
  since moving a server is a migration, not a person's upload),
  and save-attachment (`webShare.ts`) counts only while it copies the
  attachment's bytes in; once storage step 2a makes a saved attachment a
  hold on the attachment's own object, saving writes no bytes and costs
  nothing. Their web routes answer 403 `FILE_UPLOAD_QUOTA_EXCEEDED` (a web
  contract error code) with `requestedBytes`, `quota` and `billingUrl` as
  `details` (`webCommon.ts` `webFileUploadQuotaRefusal` for a save).
  Each refusal is also a `paywall_hit` (`upload_monthly_quota`, Free only;
  docs/analytics/product-events.md): both refusal builders take the write
  refused (`via`: `artifact_publish` (a push: its inline files, or the
  listed ones it lacks at the declare step), `artifact_upload`, `artifact_import`,
  `artifact_save_attachment`, `artifact_comment_image`) and put it on the
  answer as `paywallHit` (platform/fileUploadQuota
  `fileUploadQuotaPaywallHit`, never in the body); core records it as it
  writes the answer (routes/paywallHit.ts `noteAppPaywallHit`): the person's
  on the web API, the agent's (no person) on the agent API.
- File paths: a requested path is held to Porthole's path rules
  (`isWellFormedArtifactFilePath` in `@botiverse/raft-shared`, the one rule
  the Server and the CLI share: no empty, `.` or `..` segment; none of
  `\ % ? #` or a control or format character) and refused with 400
  `INVALID_PATH`; since `%` is refused, nothing can stay encoded past the
  router's one decoding. Then it is matched exactly against
  `version_files.path`; bytes are reached only through the matched row's blob.

## Write limits

Every write limit holds across server replicas (#proj-workspace:#231), so
running more replicas never multiplies one. Sized from the fleet's 1-minute
peaks over 7 days (2026-11-01..08, all replicas, no 429s): every limit is at
least twice the busiest real one, in an existing class where one fits.

- **Agents** (core's agent write budgets, server
  `services/agentApiWriteLimits.ts`, routes by class in
  `routes/internalAgentApi.ts` `AGENT_API_WRITE_BUDGET_ROUTES`; Redis, the
  process's memory without it), per agent and per server a minute:
  - `artifactWrites` (60 / 600, Artifacts' own, apart from core's
    `otherWrites` so each keeps twice its peak): push, import, comment, review, comment image upload, a thread's resolve (its note included) and reopen, follow, unfollow,
    move, delete, save an attachment. Peaks: pushes 5 / 7, the rest (mostly
    comments) 6 / 6. A review spends one per comment (1 to 50); one larger
    than a whole budget is refused outright, 400
    `agent_api_write_too_large`, nothing charged. There is no agent rename
    route (a push carries the title).
  - `artifactUploads` (600 / 1200): `PUT /artifacts/uploads/:sha256`, one per
    new file. Peak 82 / 82; 600 keeps a version of 500 new files pushable
    within a minute.
  - Past one: 429 `RATE_LIMITED` with `Retry-After` and the body older
    clients parse (`details { operation, limit, windowSeconds,
    retryAfterSeconds }`), before the body is read (an upload's or a push's
    connection is closed). A push is charged ahead of its large body's parser
    (app.ts), once. No replica-local limiter sits in front (as for core's
    `attachmentUpload`). The CLI keeps a review's comments and images within
    one agent minute (`ARTIFACT_AGENT_WRITES_PER_MINUTE`).
- **People** (`mount.ts`, per user): `write` (60) and `commentImages` (30)
  count across replicas (`acrossReplicas`: core's
  `appWebLimitAcrossReplicas`, the fixed-window counter in Redis). Peaks: 10
  writes a person (import bursts), 0 comment images. A review's submit is one
  write, as before: each draft paid one when it was made. `frame` (120, signing tickets for reads), the dashboard,
  candidates and the other reads stay per replica: they guard a replica's
  work and write nothing, and a Redis round trip on every open would buy
  nothing. Past one: 429 `RATE_LIMITED` with the limit's sentence and
  `Retry-After`.
- **Imports**: at most `ARTIFACT_IMPORTS_AT_ONCE` (2) per server at once,
  agents' and people's together (`import.ts`; platform `slots`: a lease per
  import in a Redis sorted set, given back when it ends however it ends,
  expiring a minute after the 5-minute deadline should a replica die). A
  third is 429 `RATE_LIMITED` (the rate limits' body: `limit` 2,
  `windowSeconds` and `retryAfterSeconds` 30) with `Retry-After: 30`, its
  span's `rate_limiter` `artifact-import`, before anything is asked of the
  standalone app. The per-server move isn't counted.

Guards: `agentWriteLimit.api.test.ts` (Artifacts' routes on the budgets,
per agent and per server, review units, oversize review),
`services/agentApiWriteLimits.test.ts` (the real numbers across replicas),
`apps/firstPartyApps.test.ts` (each route's class),
`routes/firstPartyAppRoutes.webLimits.test.ts` (a person across replicas),
`reviews.api.test.ts` (a submit is one write),
`services/sharedSlots.test.ts` and `import.api.test.ts` (imports at once).

## Moving a server from raft-artifacts.com

The per-server move (agreed by Tenny and xxchan): the server is frozen in the
standalone app, and its private Artifacts are imported into the whole server
as new Artifacts (current version only; the note names the old link), by an
operator, before the server's `workspace_artifacts_v0` flag is switched on
(the flag is not required). Artifacts public on raft-artifacts.com are skipped unless the
operator asks for them (`--public`, below), and so are Artifacts with no version and
ones imported before (on demand, or by an earlier run). The imported bytes
don't count against the server's monthly file upload quota; the cap on
bytes no version uses, the manifest's sha256s, the limits and the cleanup of
a failed import's bytes all stand. Only the configured standalone app is
ever requested.

**Public Artifacts (`--public`, opt-in, plan and run alike).** With it, the
Artifacts public on raft-artifacts.com are imported too, into the server's
public home (anyone with the link: signed-out view, takedown, noindex as for
any public Artifact), staying public, through the same steps and checks
(author, limits, sha256s, cap, quota exemption, provenance `importedFrom`,
the note, the standalone app told the new short link). The standalone app
is also told whether the new home is public (`imported`'s `public`, sent on
every import: false on demand and into the whole server); its old link
answers `301` only when it is and the old page is one anyone may see, else
`302` as before. Turning link sharing off here later (unpublish, a
narrowing) doesn't tell it: its stored flag stays, so the old link keeps
answering `301` (each answer cached up to an hour) to the Artifact here,
which then opens only for those who may see it. A run with `--public` that
would import any public one refuses to start, before the freeze, while the
server's flag is off (signed-out visitors see a public Artifact only then);
without `--public` the flag is still not required. Who may make an Artifact public here decides it:
Raft's rule for turning on link sharing (`manage.ts` widenRefusal, #11285:
only a person, who may widen it: its author, an agent author's manager, the
server's owners and admins, none a guest) is asked for the author the import
gives it (`import.ts` publicImportRefusal), the old creator Raft confirms. A
person of the server who may widen it: imported public. Refused, and
skipped (`public_refused`, with the reason): no author Raft confirms
(`system_author`: the ops actor would be the author, and it is no one who
may make anything public), an agent author (`agent_author`: only a person
turns on link sharing), a person who may not widen it (`may_not_make_public`:
a guest). The import checks it itself, before any byte is copied and again
in its transaction, so a role changed since the plan is refused too. It
writes the `import` audit row (its `after` with `home: "public"`) and the
`made_public` row a move to the public home writes (by the ops actor, `after`
naming the author the rule was checked for and the operator), and fills the
signed-out text as making an Artifact public does. Raft has no server-level
switch for public Artifacts; when one comes, publicImportRefusal asks it
too.

**An approval (`--approved-by`, Tenny 2026-10-30: it keeps pages already
public there public; it widens nothing).** The move doesn't change who can
see a page, and one approval of the whole move's plan by a Raft platform
owner stands for every server in it (xxchan and Tenny 2026-10-30,
#proj-workspace:e7b3e687: the servers are mostly personal, and their owners
can't each be asked). The approver is a Raft platform owner or admin: a
human owner or admin of Botiverse, the platform's own Server
(`95f993fa-2a68-4797-b8ae-7beb7d984ada`; `actors.ts`
isPlatformOwnerOrAdmin, the same rule as the official App registry's
operator), not an owner or admin of the server moved, who is no approver
as such. They may approve keeping public the public ones the rule refuses
only for their author: an agent's (`agent_author`) or the system identity's
(`system_author`) only when there is truly no creator or its id is
confirmed an agent of the server (a deleted one). A guest author's stays
refused, whatever type the standalone app gave it, and so does any creator
Raft can't confirm (a former member or guest, a member typed as an agent,
another server's). A retired account is no approver. Bound to the exact plan:
`plan --public` prints a digest per server (`public.digest`: sha256 over the
server and each public entry as a run with the approval would take it:
legacy id, name, version, home, visibility, author, decision and its basis
or refusal) and counts both ways ("with approval: N more"); over several
servers (`--servers a,b,c --public`) it also prints one digest of them all
(`publicSet.digest`, legacyMoveSetDigest: sha256 over each server's id and
digest, by id, so the order they are named in doesn't matter; one server's
is its own digest) and the counts over all of them. `run --servers a,b,c
--public --approved-by <handle|email|id> --plan-digest <digest>
--approval-ref <Raft message>` (or `--server` for one), all three or none
(several servers only with them): before anything is frozen anywhere it
resolves the approver (a Raft platform owner or admin now, else the whole
run is refused) and recomputes the digest from a fresh plan of every
server (a mismatch, any changed entry of any of them, another set of
servers, is refused: plan and approve again), and refuses it while a
server's flag is off and it would import a public one; then it moves the
servers one after the other, each with its own state file, and compares
each server's own digest again once that server is frozen. `--max`,
`--stop-at` and Ctrl-C count over the whole run, and no server is started
past them; run it again the same way to go on: a server whose pass
finished under this approval is not run again, one stopped resumes, and
the others are checked against the approved plan (its digest recomputed
from the finished and stopped servers' saved digests and the others' fresh
plans). Retrying a finished server's failures needs a run without the
approval or a new plan and approval. The approved plan's entries alone are
imported on the approval, each only while the standalone app's list (read
in this run, after the freeze) answers it public and the approver is still
a Raft platform owner or admin (checked again in the import's
transaction); otherwise the rule alone decides. Their
`made_public` row is the approver's (the actor), `after` naming the
approver (`approvedBy`), the operator (`ops`), the approval's message
(`approvalRef`) and the author. `--approval-ref` is free text nobody
verifies: the operator must check that it is the approver's own message
approving that digest. Each page is fetched by name; a manifest whose id
isn't the listed one fails (`IMPORT_MISMATCH`, `artifact_id`). A pass keeps its approval (the approved ids
are in the state file): resume it with the same three, or start a new pass
(which needs a fresh plan and approval: the imports since changed it).

A public one imported before (on demand, into a private home) is
`already_imported`: its home stays what that import gave it. A pass keeps
the choice it started with: resuming with the other one is refused (start a
new pass with `--restart`).

The script runs with the server's environment: `DATABASE_URL`,
`ARTIFACTS_LEGACY_IMPORT_URL` and `_TOKEN`, the platform's app-content
bucket (`APP_STORAGE_R2_*`) and `APP_URL` (the new links). Servers are always named,
by id or slug; there is no "every server". The JSON report goes to stdout,
the summary and a line per Artifact to stderr.

1. **Plan** (read only: asks the standalone app's `list`, reads Raft, writes
   nothing anywhere):

   ```
   pnpm --filter @botiverse/raft-server db:artifacts-legacy-import -- plan --server <id|slug> [--servers a,b,c] [--public]
   ```

   Per server: listed Artifacts and their size, to import into the whole
   server (count and size), of those how many fall back to the system identity as author (`systemAuthor`:
   no creator known, or one Raft doesn't confirm as a live agent or member
   of the server: the owners and admins manage those), already imported,
   public (skipped without `--public`), no version (skipped), and whether the flag is on yet.
   With `--public`, the public ones apart (`public` in the JSON): how many
   would be imported into the public home (count and size), how many Raft's
   rule refuses, by reason, and each one: its old link, name and title,
   size, author (the creator, or the system identity and why), and what a
   run does with it (`to`: the public home, anyone with the link; or why
   it is skipped). With the flag off it notes that `run --public` refuses
   to import them until it is on.
2. **A platform approver approves** the whole plan, once (from the freeze
   on, the servers' Artifacts on raft-artifacts.com are read-only). For
   public ones their author keeps from being public: run `plan --public`
   over every server of the move (`--servers a,b,c`), and post in the Raft
   channel of the move the combined digest (`publicSet.digest`; one
   server's own digest when there is one) with its counts (servers; public
   pages listed, kept public on their author's right, kept public with the
   approval, still refused; private ones to import) and the per-server
   lists for anyone to check. A Raft platform owner or admin (a Botiverse
   owner or admin, not each server's owner) approves it there with their
   own message naming that digest: that message is the approval (its ref
   goes to the run). Nothing checks the ref: the operator confirms the
   message is the approver's own, in that channel, and names that digest.
   Any change to the plan voids the approval (the run refuses it): plan,
   post and approve again.
3. **Run**, one server, or the approved servers together:

   ```
   pnpm --filter @botiverse/raft-server db:artifacts-legacy-import -- run --server <id|slug> --yes \
     [--public [--approved-by <handle|email|id> --plan-digest <digest> --approval-ref <message ref>]] \
     [--operator <name>] [--state <file>] [--max N] [--stop-at <ISO time>] [--report <file>]
   pnpm --filter @botiverse/raft-server db:artifacts-legacy-import -- run --servers a,b,c --yes \
     --public --approved-by <handle|email|id> --plan-digest <combined digest> --approval-ref <message ref> \
     [--operator <name>] [--max N] [--stop-at <ISO time>] [--report <file>]
   ```

   With several servers, name the same servers the plan named (any order),
   each with its default state file (`--state` is refused); the JSON is
   `reports` (each server's), `notStarted` and `stopped`.

   `--max-file-mib N` (at most 64; #proj-workspace:#114): in this run a file
   the page only offers to download (not a text file; not its entry unless the entry is itself an archive Raft only offers to download) may be
   up to N MiB instead of publishing's 15 MiB. For old pages refused
   `IMPORT_TOO_LARGE` only because of an archive (zip, tar.xz, split parts);
   the web and agent imports and publishing keep their limits.

   Without `--yes` it prints the plan and does nothing. With it: freezes the
   server in the standalone app (a failed freeze stops here, nothing
   imported), then imports one Artifact at a time in the standalone app's
   id order. `--operator` (default `$USER`) is recorded in each import's
   audit row. The state file (default
   `artifacts-legacy-import-<server id>.state.json`) is rewritten after each
   Artifact: a run stopped by `--max N` (imports tried), `--stop-at`, Ctrl-C
   (after the current Artifact; twice to quit at once) or a crash resumes
   where it stopped when run again with the same state file. A run that
   finished starts a new pass when run again: what it imported is skipped,
   what failed is tried again (`--restart` starts a new pass at once). One
   Artifact failing doesn't stop the run; the exit code is 1 when any failed.
4. **Verify**: the report's `failed` is empty or each failure is understood
   (`NAME_TAKEN`: an Artifact of the server home has that name already;
   `IMPORT_MISMATCH`: the standalone app's bytes don't match its manifest;
   `IMPORT_TOO_LARGE`: over a push's limits; `IMPORT_UNAVAILABLE`: the
   standalone app didn't answer, rerun); a rerun reports everything as
   `already_imported` (or skipped for its reason); a few new links open in
   Raft once the flag is on, and their old links on raft-artifacts.com go
   to them (`302`; a public one's `301`, kept by caches up to an hour). Then switch the server's flag on
   (with `--public` it is on already: switch it on before that run).

**Old comments.** A run copies each page's comments on raft-artifacts.com
right after importing it (the server is frozen by then), as described under
`legacyComments.ts` above: nobody is notified, a confirmed old author writes
them, anyone else's are the system identity's with the old name first. A
page whose comments fail (`not_frozen`, `too_many`: more than the standalone
app serves, then none of them, never part; `unreachable`, `bad_answer`,
`rate_limited`) is still imported: the report counts it (`comments` beside
`counts`, and each page's `imported[].comments`), the summary lists it and
the exit code is 1. An on-demand import (`POST /artifacts/import`) copies no
comments. For pages imported before (by a run from before this, on demand
once the server was frozen, or a run that stopped between a page and its
comments), the `comments` mode:

```
pnpm --filter @botiverse/raft-server db:artifacts-legacy-import -- comments plan --servers a,b,c [--page-size N]
pnpm --filter @botiverse/raft-server db:artifacts-legacy-import -- comments run --servers a,b,c \
  --approved-by <handle|email|id> --plan-digest <digest> --approval-ref <message ref> [--operator <name>] [--report <file>]
```

`comments plan` is read only (the standalone app's `list` and `comments`,
this server's rows): for each page of the server that stands imported here
(`importedTo` or the `import` audit, as the move's `already_imported`), its
old link and name, the Artifact here, its comment count, how many of its
authors Raft confirms and how many it doesn't (distinct, and by comments),
how many were copied before (their `lc_` ids present) and how many a run
would copy; per server totals; one digest of the whole plan (each server's
over its pages' comments as a run writes them, ids, authors and bodies, not
what is already copied, so a run stopped halfway resumes under the same
approval; over several servers `legacyMoveSetDigest`). A server the
standalone app answers `SERVER_NOT_FROZEN` for has nothing to copy (it is
never frozen by this mode). A page whose comments it can't give fails the
plan. `comments run` takes the same approval as `--public` (a Raft platform
owner or admin now, all three of `--approved-by`, `--plan-digest`,
`--approval-ref`; the digest recomputed from a fresh plan of every server
before anything is written, a mismatch refused: plan and approve again) and
then writes each page's comments from that fresh plan; a page that fails is
reported and the rest go on (exit code 1). Rerun it the same way: what is
there is skipped by id, nothing moves. JSON on stdout (`mode:
"comments-plan"` / `"comments-run"`), the summary on stderr.

## Tables

| Table | Holds |
|---|---|
| `items` | One Artifact (`pt_…` id, `url_key`, names, current version) and its one home: `home_kind` conversation (with `home_channel_id`, a top-level conversation; NULL once that channel is hard-deleted: an orphan), server, or public (anyone with the link); its original message (`origin_message_id`, `origin_via`; see "Original message"); its original conversation (`original_home_channel_id`, no foreign key; see "Original conversation"); the personal assistant that published it (`published_by_assistant_agent_id`, set when made, null for every other Artifact; `publishAs.ts`) |
| `versions` | Immutable versions, numbered per item; a Markdown version's `excerpt` and `excerpt_blocks`, what its card shows (`excerpt.ts`, `excerptBlocks.ts`) |
| `version_files` | The files of a version, each pointing at a blob |
| `version_texts` | A public Artifact's version's readable text as the signed-out `meta` and `index.md` answer it (`publicText.ts`): description, body (at most 200 KB), truncated, the entry's `kind` and the `extractor` it was made with; one row per version, going with it (`ON DELETE CASCADE`) |
| `version_checks` | A version's publish check (task #130, `checks.ts`): status, skip reason, the screenshots' core object file ids (only the newest three versions of an Artifact keep them), findings, error class; one row per version, going with it (`ON DELETE CASCADE`); deleted with its Artifact, and by the hourly sweep for a deleted server, objects after rows |
| `blobs` | Content-addressed bytes in R2 (`r2_key`), one row per server and sha256 |
| `comments` | Comments on the Artifact, each on a version, optionally on a path and anchor; a thread's root carries its resolution (`resolved_at`, `resolved_by_type`, `resolved_by_id`: all or none, roots only, CHECK `comments_resolution`) |
| `audit` | Home changes, turning on link sharing, deletion, import (`import.ts`: one row per import, `after.legacyArtifactId` and `after.legacyCreator`; the per-server move's by the ops actor, with `after.ops.operator`), old comments copied (`legacyComments.ts`: `import_comments`, by the ops actor, `after: { legacyArtifactId, comments, ops, approvedBy?, approvalRef? }`), takedown and restore (`takedown.ts`: `taken_down` / `restored` with `after.reason`; an operator's by the moderation ops actor `ARTIFACT_OPS_MODERATION_ACTOR`, with `after.ops.operator`) |
| `attachment_saves` | Which Artifact an attachment was saved as (goes with the attachment: `ON DELETE CASCADE`) |
| `read_positions` | How far each user or agent has looked, as an item position (only moves forward) |
| `subscriptions` | Who follows an Artifact and how it came to (`published`, `commented`, `followed`); `unsubscribed_at` is a sticky stop |
| `pending_notices` | Legacy (#55): followers' comment notices that collected for two minutes (one row per Artifact and agent, the comment ids, when it is due); nothing writes it now, the flush job drains what is left; drop both once none can remain |
| `comment_drafts` | A person's review drafts (S8): author, item, version number, path and anchor, the body's parts as sent; 30 days after `updated_at` they are gone |
| `reviews` | Posted reviews (S8): author, version, the attempt's `client_key` (unique per item and author) and request digest, the summary's comment; `comments.review_id` points here |
| `purges` | One row per Artifact an operator purged (`purge.ts` purgeArtifact): the item and server ids (no foreign key: it outlives both), only the counts removed and the reason (never content, nor who ran or approved it: the script's receipt has those), and the deleted blobs' storage keys only while their delete hasn't succeeded |

A Markdown excerpt is filled after publication, with storage read before any
lock. Its short write transaction takes the item's shared lock and refuses a
deleted item; deletion takes the item's update lock before clearing excerpts.
Both orders leave a deleted item without an excerpt, including a read that
finishes late (`publish.api.test.ts`, `publish.realPg.test.ts`).

Every change others see is also recorded in core's `public.object_events`
(Activity, S6), in the same transaction (`events.ts` `recordArtifactEvent`,
through `platform/objects`): kind `artifact`, the item id, the Artifact's home
after the change (`home_kind`, `home_channel_id`), and one of the events
`kinds.ts` declares: `version` (position, number; `publish.ts`), `comment`
(position, comment id, version; `insertComment`), `review` (S8: one for a
whole review, `reviews.ts`), `comment_edited` (comment
id, position) and `comment_deleted` (comment id, position, whether a
placeholder stays; both `webComments.ts`), `moved` (from, to and the
conversation it left, `fromChannelId`; the home before it as `previousHome`) and `deleted` (both `manage.ts`), and `renamed`
(from, to; `rename.ts`, for no one: its following agents get a notice instead). Whom each is for is in core's `object_event_recipients`: those a
comment mentions (`mentioned`; an edit: the mentions it adds), the Artifact's
followers, people and agents (`following`; its maker, while following:
`owner`), never the actor; a delete is for no one. Only those who can see the
Artifact when it is recorded (`events.ts` `recordArtifactEvent`, in the
change's transaction, for every event this module records): someone a comment
mentions or a follower who can't see it gets no recipient row, no Activity
row and no `activity:changed` ping (which `announceObjectEvents` takes from
the recipient rows), so nothing from before shows if they gain access later
(Tenny). The followers are read
once per change and are also the ones its notices go to. Who may see an
event is not stored: a reader checks the home. Kept 90 days (hourly
maintenance, `prune_object_events`), recipients with their event. Each
person among the recipients has an Activity row in core's
`object_inbox_states`, written in the same transaction (agents have none);
it goes with its newest event after 90 days. Its fan-out is only those
mentioned and followers (explicit, pushing or commenting), never everyone
who can see the Artifact.

Positions (E14): `items.last_position` counts the Artifact's events; each
comment takes the next one (`comments.position`) and so does a version when it
becomes current (`versions.position`). A version without a position was never
pushed and is never read. The write paths (S1b push, S1c comments) assign
them. Reading the current version moves the reader to `last_position`; the
unseen comments list moves it over what it showed, stopping before the first
unseen event it didn't show (a version, or another file's comment). A held
push moves it to the newest comment it held, past what lies between (see
`publish.ts` above); a pushed version moves its pusher to it.

Foreign keys reach core only for `servers` (`ON DELETE CASCADE`), `channels`
(`items.home_channel_id`, `ON DELETE SET NULL`) and `attachments`
(`attachment_saves`, `ON DELETE CASCADE`): the module never holds back a
delete in core (first-party app mechanism §八). `items.origin_message_id`
names a message without one (Tenny, review of #11613: adding it would lock
`messages`, and core's message deletes would depend on this table). Actors (`*_type`, `*_id`) have
no foreign key and are resolved live. A deleted home channel makes its
Artifacts orphans: soft-deleted, the item keeps the channel id;
hard-deleted, the id becomes NULL (`items_home_channel` allows a conversation
home without a channel, and only it). Nothing references core's attachment
storage: saving an attachment as an Artifact copies the bytes into R2
(`platform/attachments` `readAttachmentForSave`), so attachment GC never has
to ask. The `artifact_orphans_attachment_copy` migration (now part of `workspace_artifacts`) removed the `s3` blob kind (no writer ever made one;
it deleted any such row and the `version_files` naming it). Blobs need their
own GC when items are deleted (later segment).

## Original message

An Artifact records the message through which it entered a conversation
(xxchan, #proj-workspace:2e5a5da3): `items.origin_message_id` and
`origin_via`, set once and never moved.

- Saved from an attachment (`save.ts`, the web's and an agent's save): the
  attachment's message, `attachment`, in the transaction that makes it.
- Shared (`webShare.ts`; agents have no share route): when it has none yet,
  the message the share posted, `share`, after the post succeeded
  (`UPDATE … WHERE origin_via IS NULL`). A retry's replay posted nothing and
  sets nothing; an Artifact saved from an attachment, or shared before, keeps
  its own.
- A link in an ordinary message (`link`): later, through a platform hook;
  nothing writes it yet.
- Never moved: neither column changes once set. No foreign key to
  `messages` (Tenny, review of #11613): a message core deletes leaves the id
  dangling, never shown (`messageSource` finds no message), and the Artifact
  never takes another one. A retracted message (`deleted_at`) is never shown
  either.
- Who is shown it (`origin.ts`): a reader of the Artifact's own server who
  can read that message now (`platform/messages` `messageSource`: its
  conversation as the reader's server shows it, the plan's history window,
  not retracted), whatever the Artifact's home. An Artifact moved from a
  private conversation or a DM to the server or anyone with the link never names that
  conversation, nor that it exists, to someone outside it. Another server's
  reader (an anyone-with-the-link Artifact) and the signed-out view (`publicRoutes.ts`,
  `ArtifactPublicView`, no such field) never get it; the cards (summaries)
  carry none. Null in every other case.
- What is shown: the web viewer's `origin` (`ArtifactViewerData`:
  `messageId`, `conversationId` the top-level conversation, `threadRootId`
  for a thread reply, `via`); the agent read's `origin` (`target`, the
  conversation as the agent names it: `#channel`, `dm:@peer`, a thread's
  `#channel:<root short id>`; `messageId`; `via`).
- The migration (`artifact_origin_message`) backfilled saved Artifacts from
  their earliest `attachment_saves` row's message.
- Guards: `share.api.test.ts` ("origin: …"), `saveAgent.api.test.ts` (the
  agent read), `schema.db.test.ts` (constraints, the delete, the backfill).

## Who sees what

Exactly who can see the home (`platform/visibility` `canViewHomes`, over
`visibilityService.canViewHomedObjects`; for the summaries, core
applies the same rule itself, over the homes `artifactHomes` reports): a
conversation by the channel rules, the server by its non-guest members and
agents, anyone with the link (`public`) by everyone; for any other home the actor must still stand in
the server (a member of any role, or a live agent), so a removed member sees
anyone-with-the-link items only. Deleted or revoked items: nobody, author included (a
deleted, never a revoked, item's message card says only that it was deleted,
to who could see it before: `webCards.ts` above). Another
server's actor: anyone-with-the-link items only, unless the home is in a joint channel (below).

Orphans (a conversation home whose channel was soft-deleted, or is NULL after
a hard delete, or a joint the item's server has left) are decided by the platform, the same for every app
(`platform/visibility`, visibilityService): only the author, the author
agent's manager (the owner of a personal assistant, otherwise its human
creator) and the server's owners and admins see one, guests never, and only by
id: `visibleHomesSql`, so every list, the dashboard and search, never shows
one. An orphan's home reads as a conversation with no name or target, and
with a null id after a hard delete.

A conversation home is a top-level conversation of the item's server
(channel, private channel, DM), or, for a joint channel, the joint's
canonical channel: pushing into `#joint` stores the canonical channel,
never the server's projection (`platform/conversations`
`resolveConversationTarget` `homeChannelId`), and the item stays its
pushing server's (quota, blobs, orphans, flag). Such an item is seen by
the joint's members on every participating server, each through its own
server's active projection by the channel rules
(`visibilityService.jointHomeProjections`, the one mapping, which the check
by id, the one turned around and the list all call), while the pushing
server is still in the joint; a server whose projection is disconnected sees
nothing, as with the joint's messages. When the pushing server leaves
(disconnects, deletes its projection, or the joint closes), no other server
sees the item any more, and on the pushing server it is an orphan (its
author, the author agent's manager, owners and admins, by id; Tenny's
decision on the joint review's F3). An item whose home is its own server's
projection of a joint (pushed there before a push stored the canonical
channel, or in a channel converted to a joint since) is read as homed in
the joint, on every form, the agent list's `target` and name lookup too;
nothing is migrated (F7). Another server's joint member reads
the whole history and the comments (`apiCommon.readsAsOutsider` is false for
it), and comments, replies, reviews and follows as it writes in the channel
(`apiCommon.accessOf` `takesPart`, web and agent API; Tenny on #68): only while
it sees the item (in the joint, both servers' Artifacts on), so leaving the
joint refuses the next write. It edits and deletes only its own comments, as
everyone does, and manages nothing (delete, move, share stay the item's
server's: `inside`). It pushes nothing into the joint's home and sees no
presence. Everything else is as for a message in the joint (#68): it names
and is named (the `@` audience is the joint's roster who can see the item,
`platform/mentions`; an agent's `@handle` is looked up in the joint's other
servers too, `comments.ts` `jointActorsByHandle`; the send check asks
`platform/visibility` `jointViewersOf`), it is a recipient of the item's
events (`events.ts`, the same check), its Activity row is listed and badged
in its own server under its own projection's name (core's
`services/objectActivity.ts` `jointRowsSeen`, which asks `seenThroughJoint`,
the rule `takesPartIn` asks: leaving the joint ends the row, the badge and
the writes together), the `activity:changed` ping names that server, and an
agent of it is told in its own server (`notices.ts`: queued there, the
delivery guard checks the agent in it and both servers' flags). One row and
one read position per person, so reading it in one server reads it in all.
Each server names the home by its own projection (`conversationNames`,
`agentConversationRefs`). A thread or another server's channel is never a
home, nor is a joint's thread or task conversation (a joint record too,
whose projections are not `joint` channels): such an item is visible to
nobody. S1's write paths reject them. Whoever takes part in the item keeps a
read position on it (web viewer, agent read and comments; an agent's comment
is held by it), the joint's members of another server too (Tenny on #68, in
place of F5's "no peer read positions"); an outsider of a public item writes
none.

Reading one Artifact (the viewer, its files and comments, the content
Worker, core's summaries, the agent API's reads by id) needs the flag on for
both the reader's server and the item's own server (Tenny's decision on the
joint review's F2): a joint's Artifact is seen across servers only while
both have Artifacts on, and so is another server's anyone-with-the-link one. A reader
whose server has it off is refused (403 ARTIFACTS_NOT_ENABLED; the Worker's
`not-visible`; every summary `unavailable`, drawn as a plain link). An item whose own server was soft-deleted is read by no one, whatever its
flag (`apiCommon.itemServerEnabled`, `platform/flags`
`appEnabledOnLiveServer`; core's summaries likewise). Writing
follows the writer's server's flag. Lists (the dashboard, a conversation's
Artifacts, search, the agent list) are behind the reader's server's flag, and keep another server's
joint item only while its own server has the flag on (`platform/visibility`
`visibleHomes`, asked for the app's flag).

Signed-out visitors (`publicRoutes.ts`, `/api/public/artifacts/*`, mounted
by core's signed-out app mount with no auth; contract
`packages/shared/src/publicArtifactsContract.ts`) see a live anyone-with-the-link item
whose own server still exists and has the flag on (`canViewArtifactsAnonymously`, over
`platform/visibility` `canViewHomesAnonymously`), its current version only:
title, kind, version number and time, and an anonymous content frame; for AI
tools and link previews also the version as Markdown (`index.md`, listing its
files, and in words where each one is), each file to download (`files/<path>`, also `<path>`
without `files/` as an AI tool guesses it; an attachment that never
renders on the API's origin), all of them as one zip (`download.zip`) and a
preview's fields (`meta`); never an author, server or viewer, and nothing
cached (`private, no-store`). `index.md` and `meta` read the entry's text
from `version_texts` (`publicText.ts`: written after a push to a public
Artifact or once it is made public, else by the first signed-out view that
finds none; never for a failed read; a row of an older extractor or another
kind is made again), only after the checks passed and only for the current
version they returned, so a stored row never outlives them: it stays when
the Artifact stops being public and is simply not read. Every
other case is the one 404. The content Worker's authorize allows their
subject (`v1:anon:<artifact>:<version>`) only for that current version while
the item's link sharing is on (`contentRoutes.ts` decideAnonymous). Turning off an
item's link sharing (`POST /api/artifacts/:id/unpublish`, `manage.ts`
unpublishArtifact) is for the people who may turn it on, audited
`made_private`; moving it to a smaller home (the home route,
narrowArtifactHome, audited `narrowed`) takes it from them the same way.

The public ZIP deadline and a disconnected client cancel the entry read before
the ZIP iterator is closed. Cancellation reaches the bucket GET through the
app and Artifact storage handles, and destroys a body already being read. An
unresponsive reader cannot keep the HTTP answer open after the ZIP is destroyed.
Guards: `storedZip.test.ts`'s pending-read destruction case,
`blobStore.test.ts`'s SDK cancellation propagation, and `public.api.test.ts`'s
bounded deadline-to-HTTP-close case. These use local storage fixtures, not R2.

## Original conversation

The conversation an Artifact was made in (#75; xxchan, Kirby and Remy,
#proj-workspace:fc9cbbcd): `items.original_home_channel_id`, the only
conversation a narrowing may return it to. Narrowing exists to undo a share
that went too wide, so it goes back where it was published or saved, where
its author is (no free conversation picker: "Its author is an agent that
isn't in that conversation" was the result).

- Set when it is made, never changed: a publish (`publish.ts`, its
  conversation, a thread's parent), a save (`save.ts`, the attachment's
  top-level conversation), an import into a conversation (`import.ts`;
  into the whole server: null). Moves never touch it.
- No foreign key to `channels` (Tenny: never from an app table to a hot core
  table): a deleted conversation leaves the id dangling.
- `manage.ts` `shownOriginalHome`: the id while that conversation still
  exists as a top-level conversation of the Artifact's server (not
  soft-deleted, not a joint channel) and the actor can see it now (the
  narrowing's own conversation check), else null, one answer for every
  reason. The viewer's `originalHome { conversationId }` (only for one who
  may move it, while the home is server or public, then `narrowHome`) and
  `NOT_ORIGINAL_HOME`'s `originalConversationId` use it, so a private
  conversation's id is never told to someone who can't see it.
- The home route and its preview refuse any other conversation (409
  `NOT_ORIGINAL_HOME`) before the target's own checks, which still apply to
  the original one (gone: the one 404 `TARGET_NOT_FOUND`; guests, the
  author, the name, `expectedLost`).
- Migration `artifact_original_home` (app_artifacts only): the column, and a
  backfill: an item in a conversation takes it; any other the earliest
  conversation home its `audit` rows record (`before.home_kind`
  conversation, ordered by `created_at`, `id`); none recorded: null. Guard:
  `schema.db.test.ts`.

## Not here yet

- Usage counting. `github_*` and `legacy_links` are not coming: the live
  app's data is not migrated (an artifact is imported as a new Artifact, on
  demand or by the per-server move) and pushing from GitHub Actions is not supported for now
  (decisions of 2026-10-26 in `docs/development/workspace-artifacts.md`).
- Comment idempotency (known gap): a comment is not idempotent, so a client
  retrying after a 201 it didn't receive posts the comment twice (route
  metadata `idempotency: "none"`; clients must not auto-retry it).
  A review is, per key: a person's `clientKey`, an agent's `idempotencyKey`.
- Batch comments (S8) beyond the server: the web's comment mode (Kirby),
  Porthole's draft markers, the dashboard's `waiting` drafts.
- `pending_notices` and its flush job (`flushDueArtifactNotices`, the
  `notice_flush` job) are legacy since #55 (followers are told of each
  comment at once): drop the table, the job, `dropPendingNotice` and
  `manage.ts`'s delete of its rows in a migration once no row can remain.
- Notices to people beyond Activity rows (push, email); presence's `viewing` and the
  `artifact:presence` socket event; realtime "Saved as Artifact" lines for
  others on screen; moving between two conversations, narrowing to any
  conversation but the original one (#75), and narrowing from the agent
  API. Messages never carry `artifactRefs` or
  `savedAsArtifact` (xxchan 2026-10-26).
- A comment deleted without replies (or a placeholder going with its last
  reply) is a deleted row, but its `object_events` rows (kind `comment`, its
  id in `data`, and the `comment_deleted` that says so) stay: Activity (S6)
  must tolerate an event whose comment no longer exists (and a
  placeholder's empty body), rather than resolve it. A placeholder that goes
  with its last reply records no event of its own.
