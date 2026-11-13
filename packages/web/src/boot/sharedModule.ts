/**
 * One loader per lazily loaded module, shared by every caller (a preload at
 * boot or in idle time, the lazy component that renders it), which also
 * remembers the module once it is in. boot/deferredUi renders a component
 * whose module is in straight away instead of through React.lazy: a lazy
 * component suspends on its first render even when its code is already there,
 * and the Suspense fallback then stays up for React's reveal throttle
 * (~300 ms; the "Loading…" line when Create account or Forgot password opens).
 * A failed load is forgotten: the next call fetches again.
 */
type Load<M> = () => Promise<M>;

const loaded = new WeakMap<Load<unknown>, unknown>();
const sharedLoaders = new WeakSet<Load<unknown>>();

export function sharedModule<M>(factory: Load<M>): Load<M> {
  if (sharedLoaders.has(factory)) return factory;
  let module: Promise<M> | null = null;
  const load: Load<M> = () => {
    module ??= factory().then(
      (value) => {
        loaded.set(load, value);
        return value;
      },
      (error: unknown) => {
        module = null;
        throw error;
      },
    );
    return module;
  };
  sharedLoaders.add(load);
  return load;
}

/** The module a sharedModule loader has loaded, or undefined while it isn't in. */
export function loadedModule<M>(load: Load<M>): M | undefined {
  return loaded.get(load) as M | undefined;
}
