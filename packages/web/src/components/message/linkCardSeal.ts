// A form's SecretInput values, sealed on this device to the App (RFC 086
// §5.3, web part 2), for the one execute request of a prepared action
// (linkCardExecute.tsx). The JOSE work is shared's `sealInputs` and the header
// binding its `sealedInputsBinding` (packages/shared/src/sealedInputs.ts, the
// one implementation the SDK, Apps and the shared vectors use); nothing here
// does cryptography. That module (and `jose`) loads only when a value is
// sealed, so it stays out of the bundle every page loads.
//
// Fails closed, never re-seals: the card is read again right before sealing,
// and if the App's key, its client key or the card changed meanwhile, or the
// handle has expired (or is about to), nothing is sealed or sent and the
// person presses again (RFC 086 §5.2: a rotation fails the open dialog
// closed). The values are in memory only: the dialog hands them over in a
// Map, which is cleared here as soon as they are sealed or refused. Neither
// they nor the JWE are logged, stored or put in an error.
// docs/development/app-link-previews.md, "Card messages with acting buttons".

import { currentTimeMs } from "@botiverse/raft-shared";
import type { AppCardEncryptionKey } from "@botiverse/raft-shared/src/appLinkPreview";
import type { IntlShape } from "react-intl";
import type { MessageId } from "../../i18n/messages";
import { showWarning } from "./linkCardToasts";
import type { LinkCardMessageView } from "./linkCardExecute";
import type { MessageCardRead } from "./linkCardRead";

/**
 * What a SecretInput button's values are sealed to, from Raft's handle read
 * (never from card content): the App's key (`app.encryption_key`), its client
 * key (the header's `aud`, `app.client_key`), the handle's expiry in Unix
 * seconds (the header's `exp`, the action's `handle_exp`), and the card
 * revision the handle is for.
 */
export type LinkCardSealTo = { key: AppCardEncryptionKey; clientKey: string; handleExp: number; revision: string };

/** A handle with less left than this is not sealed for: the App would refuse it as expired by the time it arrives. */
export const LINK_CARD_SEAL_MIN_LEFT_MS = 5000;

/**
 * The seal target of one action in a read's answer, or null when the read
 * didn't give all of it (an App with no key, a Server older than the field):
 * such a button has nothing to seal to and is never pressed.
 */
export function messageCardSealTo(answer: MessageCardRead, action: MessageCardRead["actions"][number]): LinkCardSealTo | null {
  const key = answer.app?.encryption_key;
  const clientKey = answer.app?.client_key;
  if (!key || !clientKey || action.handle_exp === undefined) return null;
  return { key, clientKey, handleExp: action.handle_exp, revision: answer.card_revision };
}

/** The same App key, client key and card: a target read again still seals to what was shown. The handle (and its expiry) is always new. */
const sameTarget = (a: LinkCardSealTo, b: LinkCardSealTo) =>
  a.key.kid === b.key.kid && a.key.x === b.key.x && a.key.y === b.key.y && a.clientKey === b.clientKey && a.revision === b.revision;

const expiring = (target: LinkCardSealTo) => currentTimeMs() >= target.handleExp * 1000 - LINK_CARD_SEAL_MIN_LEFT_MS;

/**
 * `sealed_inputs` for an execute (RFC 086 §5.3, §5.7): the card is read again,
 * then the values are sealed to `sealTo` with the header binding this request:
 * the viewer and Server of the view (`viewerKey`, `<user>:<server>`), the
 * handle and action, the prepared action, the request's `client_request_id`
 * and the handle's expiry. Null when it fails closed (a warning was shown;
 * nothing may be sent). `values` is cleared either way.
 */
export async function sealLinkCardSecrets(
  context: { viewerKey: string; view: LinkCardMessageView; url: string; format: IntlShape["formatMessage"] },
  request: { actionId: string; handle: string; prepared: { id: string; digest: string }; clientRequestId: string; sealTo: LinkCardSealTo | undefined; values: Map<string, string> },
): Promise<string | null> {
  const { sealTo, values } = request;
  try {
    if (!sealTo || expiring(sealTo)) return refuse(context, "message.appLink.action.form.sealStale");
    const read = await context.view.reread(context.url);
    if (read.kind !== "read") return refuse(context, "message.appLink.action.readFailed");
    const fresh = read.result?.kind === "card" ? read.result.sealsTo?.[request.actionId] : undefined;
    if (!fresh || !sameTarget(fresh, sealTo) || expiring(sealTo)) return refuse(context, "message.appLink.action.form.sealStale");
    const colon = context.viewerKey.indexOf(":");
    const { sealInputs, sealedInputsBinding } = await import("@botiverse/raft-shared/src/sealedInputs");
    const binding = await sealedInputsBinding({
      handle: request.handle, userId: context.viewerKey.slice(0, colon), serverId: context.viewerKey.slice(colon + 1),
      appClientKey: sealTo.clientKey, actionId: request.actionId, prepared: request.prepared, clientRequestId: request.clientRequestId, handleExp: sealTo.handleExp,
    });
    return await sealInputs({ key: sealTo.key, binding, values: Object.fromEntries(values) });
  } catch {
    // A key or binding the shared check refuses, or the module failed to load. The error is not kept: it may describe the input.
    return refuse(context, "message.appLink.action.failed");
  } finally {
    values.clear();
  }
}

function refuse(context: { format: IntlShape["formatMessage"] }, id: MessageId): null {
  showWarning(context.format, id);
  return null;
}
