import { signAccessToken } from "../../middleware/auth.js";

export function createHttpClient(baseUrl: string) {
  return {
    as(human: { id: string }, server?: { id: string }) {
      const headers = new Headers({ Authorization: `Bearer ${signAccessToken(human.id)}` });
      if (server) headers.set("X-Server-Id", server.id);
      return {
        get(path: string) {
          return fetch(new URL(path, baseUrl), { headers });
        },
        request(path: string, init: RequestInit) {
          const requestHeaders = new Headers(headers);
          new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
          return fetch(new URL(path, baseUrl), { ...init, headers: requestHeaders });
        },
      };
    },
  };
}
