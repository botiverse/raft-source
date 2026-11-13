import { capabilitySpec, mayPassOn } from "@botiverse/porthole";
import type { PageDeclaration, PortholeConfig } from "@botiverse/porthole";

/**
 * Where a framed page may be searched by Raft's find bar (Porthole's `find`, P131;
 * #proj-workspace:#138). The page reads every query it is sent (the search runs in its own
 * document), so `find` is declared only for a page that can't send what it reads anywhere
 * (Tenny, 9ac186d4; Remy, cea2cbac): Porthole's own pass-on rule (`mayPassOn`, P112: the host
 * functions that carry what a page puts in them to others, such as `db`, a new version, the
 * agent's context; errors sent to the agent; the network beyond the library CDNs), with one
 * judgment of Raft's: `openLink` under its default `confirm` gate doesn't count. Porthole lists
 * it as a carrier (a link the page builds can hold the query), but there the person sees the whole
 * address in Porthole's confirmation ("Open this link?") and opens it themselves; nothing leaves
 * unseen. A config that took the confirmation away would count it again. For a page with any other
 * way out, the find bar isn't offered and Cmd/Ctrl+F stays the browser's. The bar itself no longer
 * says the page sees the query (xxchan, Tenny, #proj-workspace:#168): this rule is the guard.
 */
export function findAllowed(config: PortholeConfig, declaration: PageDeclaration | null): boolean {
  const { openLink, ...others } = config.capabilities;
  const confirmed = openLink !== undefined && (openLink.gates ?? capabilitySpec("openLink").defaultGates).includes("confirm");
  return !mayPassOn(confirmed ? { ...config, capabilities: others } : config, declaration);
}

const plain = new WeakMap<PortholeConfig, PortholeConfig>();

/**
 * The config without `find`, made once per config (a new object would make the frame again): for
 * a frame with no find bar, and a page that may not be searched.
 */
export function withoutFind(config: PortholeConfig): PortholeConfig {
  if (config.capabilities.find === undefined) return config;
  let made = plain.get(config);
  if (!made) {
    const { find: _find, ...capabilities } = config.capabilities;
    made = { ...config, capabilities };
    plain.set(config, made);
  }
  return made;
}
