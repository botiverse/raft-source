import { sanitizeAppLocalReturnPath } from "@botiverse/raft-shared";

/** The page to land back on after verifying, sent only when it isn't the home page (the server validates it again). */
export function landingBody(returnTo: string | null | undefined): { returnTo?: string } {
  const path = sanitizeAppLocalReturnPath(returnTo);
  return path === "/" ? {} : { returnTo: path };
}
