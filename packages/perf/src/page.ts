/**
 * Pure helpers of src/measure.ts that know about the Raft web page: which hosts
 * are production, how the off arm removes the boot prefetch, and where the
 * app's own render milestone is reported. Unit-tested in src/page.test.ts.
 */

/** A host this tool must not touch without --allow-production. */
export function isProductionHost(url: string): boolean {
  const host = new URL(url).hostname.replace(/\.$/, "").toLowerCase();
  return host === "raft.build" || host.endsWith(".raft.build");
}

/** The off arm: the page's boot prefetch config emptied, so the inline script reads null and sends nothing. */
export function withoutBootPrefetch(html: string): string {
  return html.replace(/(<script type="application\/json" id="raft-boot-prefetch">)[^<]*(<\/script>)/, "$1null$2");
}

/** content_ms of a rendered slock.web.boot_timing event in a web-traces upload body, if any. */
export function bootContentMs(body: string): number | null {
  try {
    const found: number[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") {
        const record = node as { name?: unknown; attrs?: { content_ms?: unknown; outcome?: unknown } };
        if (record.name === "slock.web.boot_timing" && record.attrs?.outcome === "rendered" && typeof record.attrs.content_ms === "number") {
          found.push(record.attrs.content_ms);
        }
        Object.values(node).forEach(walk);
      }
    };
    walk(JSON.parse(body));
    return found.length ? found[0] : null;
  } catch {
    return null;
  }
}
