import { accessTokenForTest } from "./credentials";

export function createHttpClient(baseUrl: string) {
  return {
    /** Requests as `human`, in a sign-in made on first use (one per `as` call). */
    as(human: { id: string }, server?: { id: string }) {
      let headers: Promise<Headers> | undefined;
      const signedIn = () => {
        headers ??= accessTokenForTest(human.id).then((token) => {
          const value = new Headers({ Authorization: `Bearer ${token}` });
          if (server) value.set("X-Server-Id", server.id);
          return value;
        });
        return headers;
      };
      return {
        async get(path: string) {
          return fetch(new URL(path, baseUrl), { headers: await signedIn() });
        },
        async request(path: string, init: RequestInit) {
          const requestHeaders = new Headers(await signedIn());
          new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
          return fetch(new URL(path, baseUrl), { ...init, headers: requestHeaders });
        },
      };
    },
  };
}
