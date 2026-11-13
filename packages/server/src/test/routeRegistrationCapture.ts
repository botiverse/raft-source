// Runtime route registration capture (task #91 route enumeration contract).
//
// Enumerates the app's real mutating route surface (or, on request, its GET surface) from what Express actually
// registers, not from source text:
// `Router.prototype.route` (which every `router.post/put/patch/delete/all` and `app.<method>` goes through) and
// `Router.prototype.use` (mounts) are wrapped while the app is built. Install BEFORE dynamically importing the app,
// because route modules register their routes at import time.
//
// Two independent derivations are cross-checked so the capture cannot silently miss a surface:
//   1. composed paths — each captured route joined with every mount chain that reaches it from the root;
//   2. dispatch stack — a walk of the root router's `stack` layers, the structure Express dispatches through.
// A captured mutating route with no mount chain (an unmounted router), a route reachable in the dispatch stack that
// was never captured, or a per-route occurrence mismatch between the two is reported as a problem.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Express 5 re-exports `router`; resolve it from express so the patched prototype is the one the app uses.
const RouterModule = require(require.resolve("router", { paths: [require.resolve("express")] })) as {
  prototype: Record<string, (...args: unknown[]) => unknown>;
};

type RouteLike = { path: unknown; methods: Record<string, boolean | undefined> };
type LayerLike = { route?: RouteLike; handle?: unknown };
type Registration = { router: object; path: unknown; route: RouteLike };
type Mount = { parent: object; path: unknown; child: object };

export type RegisteredMutatingRoute = { method: string; path: string };

export type RouteMethodSet = "mutating" | "read";

export interface CaptureSession {
  /**
   * Routes registered during this session and reachable from `root`, plus structural problems: the mutating
   * methods by default, GET with `{ methods: "read" }`.
   */
  collect(root: object, options?: { methods?: RouteMethodSet }): { routes: RegisteredMutatingRoute[]; problems: string[] };
}

export interface RouteRegistrationCapture {
  /** Registrations made after this call belong to the returned session (until the next `session()` call). */
  session(): CaptureSession;
  restore(): void;
}

const MUTATING_METHODS = new Set(["post", "put", "patch", "delete", "_all"]);
// HEAD is answered by the GET handler, so GET alone is the read surface.
const READ_METHODS = new Set(["get"]);

function isRouter(value: unknown): value is { stack: LayerLike[] } {
  return typeof value === "function" && Array.isArray((value as { stack?: unknown }).stack);
}

function isExpressSubApp(value: unknown): boolean {
  return typeof value === "function" && typeof (value as { set?: unknown }).set === "function"
    && typeof (value as { handle?: unknown }).handle === "function";
}

function renderPaths(path: unknown): string[] {
  if (Array.isArray(path)) return path.flatMap(renderPaths);
  return [path instanceof RegExp ? String(path) : String(path)];
}

function joinPath(prefix: string, segment: string): string {
  if (segment === "/") return prefix === "" ? "/" : prefix;
  return prefix + segment;
}

function selectedMethods(route: RouteLike, selected: ReadonlySet<string>): string[] {
  return Object.keys(route.methods)
    .filter((method) => route.methods[method] && selected.has(method))
    .map((method) => (method === "_all" ? "ALL" : method.toUpperCase()));
}

export function installRouteRegistrationCapture(): RouteRegistrationCapture {
  const proto = RouterModule.prototype;
  const originalRoute = proto.route;
  const originalUse = proto.use;
  let current: { registrations: Registration[]; mounts: Mount[] } = { registrations: [], mounts: [] };

  proto.route = function capturedRoute(this: object, path: unknown) {
    const route = originalRoute.call(this, path) as RouteLike;
    current.registrations.push({ router: this, path, route });
    return route;
  };

  proto.use = function capturedUse(this: object, ...args: unknown[]) {
    // Mirrors router@2 `use` argument parsing: a leading non-function (after unwrapping nested arrays) is the path.
    let path: unknown = "/";
    let handlers = args;
    let probe: unknown = args[0];
    while (Array.isArray(probe) && probe.length !== 0) probe = probe[0];
    if (typeof probe !== "function") {
      path = args[0];
      handlers = args.slice(1);
    }
    for (const handler of (handlers as unknown[]).flat(Infinity)) {
      if (isRouter(handler)) current.mounts.push({ parent: this, path, child: handler });
    }
    return originalUse.apply(this, args);
  };

  return {
    session() {
      const state = { registrations: [] as Registration[], mounts: [] as Mount[] };
      current = state;
      return {
        collect(root: object, options?: { methods?: RouteMethodSet }) {
          const selected = options?.methods === "read" ? READ_METHODS : MUTATING_METHODS;
          const problems: string[] = [];
          // Mounts are global to the process (an app router may be mounted by a router built in another session).
          const prefixesOf = (router: object, trail: Set<object>): string[] => {
            if (router === root) return [""];
            if (trail.has(router)) return [];
            const nextTrail = new Set(trail).add(router);
            return state.mounts
              .filter((mount) => mount.child === router)
              .flatMap((mount) => prefixesOf(mount.parent, nextTrail)
                .flatMap((prefix) => renderPaths(mount.path).map((segment) => joinPath(prefix, segment))));
          };

          // One mount call is one dispatch layer even when its path is an array, so the dispatch-stack cross-check
          // compares against mount chains, not against expanded paths.
          const chainCountOf = (router: object, trail: Set<object>): number => {
            if (router === root) return 1;
            if (trail.has(router)) return 0;
            const nextTrail = new Set(trail).add(router);
            return state.mounts
              .filter((mount) => mount.child === router)
              .reduce((sum, mount) => sum + chainCountOf(mount.parent, nextTrail), 0);
          };

          // Derivation 2: occurrences of each route object in the dispatch stack reachable from root.
          const stackOccurrences = new Map<RouteLike, number>();
          const walk = (router: { stack: LayerLike[] }, trail: Set<object>) => {
            if (trail.has(router)) {
              problems.push("router mount cycle in dispatch stack");
              return;
            }
            const nextTrail = new Set(trail).add(router);
            for (const layer of router.stack) {
              if (layer.route) {
                stackOccurrences.set(layer.route, (stackOccurrences.get(layer.route) ?? 0) + 1);
              } else if (isRouter(layer.handle)) {
                walk(layer.handle, nextTrail);
              } else if (isExpressSubApp(layer.handle)) {
                problems.push("express sub-app mounted: its routes are invisible to this contract");
              }
            }
          };
          if (!isRouter(root)) throw new Error("collect(root): root must be a router with a stack");
          walk(root, new Set());

          const rows = new Set<string>();
          const captured = new Set<RouteLike>();
          for (const registration of state.registrations) {
            captured.add(registration.route);
            const methods = selectedMethods(registration.route, selected);
            if (methods.length === 0) continue;
            const prefixes = prefixesOf(registration.router, new Set());
            const fullPaths = prefixes.flatMap((prefix) =>
              renderPaths(registration.path).map((segment) => joinPath(prefix, segment)));
            for (const method of methods) {
              if (fullPaths.length === 0) {
                problems.push(`unmounted router registers ${method} ${renderPaths(registration.path).join("|")}`);
              }
              for (const fullPath of fullPaths) rows.add(`${method} ${fullPath}`);
            }
            const occurrences = stackOccurrences.get(registration.route) ?? 0;
            const chains = chainCountOf(registration.router, new Set());
            if (fullPaths.length > 0 && occurrences !== chains) {
              problems.push(
                `mount graph mismatch for ${methods.join(",")} ${fullPaths[0]}: ${chains} mount chain(s), `
                + `${occurrences} dispatch-stack occurrence(s)`,
              );
            }
          }
          for (const [route] of stackOccurrences) {
            if (!captured.has(route) && selectedMethods(route, selected).length > 0) {
              problems.push(`dispatch stack has an uncaptured ${options?.methods === "read" ? "read" : "mutating"} route: ${renderPaths(route.path).join("|")}`);
            }
          }

          const routes = [...rows].sort().map((row) => {
            const space = row.indexOf(" ");
            return { method: row.slice(0, space), path: row.slice(space + 1) };
          });
          return { routes, problems };
        },
      };
    },
    restore() {
      proto.route = originalRoute;
      proto.use = originalUse;
    },
  };
}
