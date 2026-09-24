import { Profiler } from "react";
import type { PropsWithChildren } from "react";

/**
 * Render-count harness for behavioral component tests.
 *
 * This is the cheap, jsdom-level alternative to e2e for the "selective
 * re-render" class of tests (see docs/sops/mutation-evidence.md): render a component,
 * dispatch a store action, and assert *which* subtrees re-rendered — instead of
 * asserting on source text (a false-green proxy) or standing up a full e2e rig.
 *
 * Usage (run with `pnpm --filter @botiverse/raft-web test:dom`):
 *
 *   const rc = createRenderCounter();
 *   render(
 *     <>
 *       <rc.Count id="rowA"><Row agentId="a" /></rc.Count>
 *       <rc.Count id="rowB"><Row agentId="b" /></rc.Count>
 *     </>,
 *   );
 *   const before = rc.get("rowB");
 *   act(() => { useSomeStore.getState().updateOnlyA(); });
 *   assert.equal(rc.get("rowB"), before); // sibling must NOT re-render
 *
 * Each `<Count id>` wraps a subtree in a React Profiler and counts its commits.
 * The counter is scoped to the factory call, so tests don't share state.
 */
export function createRenderCounter() {
  const counts = new Map<string, number>();

  function Count({ id, children }: PropsWithChildren<{ id: string }>) {
    return (
      <Profiler
        id={id}
        onRender={() => counts.set(id, (counts.get(id) ?? 0) + 1)}
      >
        {children}
      </Profiler>
    );
  }

  return {
    /** Wrap a subtree whose render commits you want to count. */
    Count,
    /** Commit count for an id (0 if never rendered). */
    get: (id: string): number => counts.get(id) ?? 0,
    /** Reset all counts (e.g. to ignore mount renders before an action). */
    reset: (): void => counts.clear(),
  };
}
