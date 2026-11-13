import { useEffect, useState } from "react";
import { getServerSso } from "./ssoApi";

/** Each Server's answer, asked once: whether its SSO section shows. */
const answers = new Map<string, Promise<boolean>>();

/**
 * Whether Settings › Administration shows this Server's Single sign-on
 * section, by the section's own test (ServerSsoSection): GET
 * /servers/:id/sso answers, which it doesn't while `server_sso_v1` is off for
 * the Server (404) or for a member who isn't an admin (403). A failed read
 * is no, and is asked again next time.
 */
export function serverSsoShown(serverId: string): Promise<boolean> {
  let answer = answers.get(serverId);
  if (!answer) {
    answer = getServerSso(serverId).then((settings) => settings !== null, () => {
      answers.delete(serverId);
      return false;
    });
    answers.set(serverId, answer);
  }
  return answer;
}

/**
 * serverSsoShown for the Settings search, asked only once `ask` is true (a
 * search by someone who may edit the Server's settings); false until it answers.
 */
export function useServerSsoShown(serverId: string | null, ask: boolean): boolean {
  const [answer, setAnswer] = useState<{ serverId: string; shown: boolean } | null>(null);
  useEffect(() => {
    if (!ask || !serverId) return;
    let live = true;
    void serverSsoShown(serverId).then((shown) => {
      if (live) setAnswer({ serverId, shown });
    });
    return () => {
      live = false;
    };
  }, [ask, serverId]);
  return answer?.serverId === serverId && answer.shown;
}

/** Forget every answer (tests). */
export function resetServerSsoShownForTests(): void {
  answers.clear();
}
