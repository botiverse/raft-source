// Compile-time proofs for `@botiverse/raft-sdk/app` (RFC 079 §8.2 item 3: a
// Server request without a Server cannot be written). NOT a runtime test: its
// teeth are the ts-expect-error directives and the exact-key checks below,
// exercised by `pnpm --filter @botiverse/raft-sdk typecheck`. A Server method
// on the top-level client, or a `server_id` parameter anywhere, makes a
// directive unused or a key check false, and typecheck fails.
import {
  createRaftAppClient,
  type CreateRaftAppClientOptions,
  type RaftAppClient,
  type RaftAppPrincipalType,
  type RaftAppServer,
  type RaftAppServerClient,
  type RaftAppServerRole,
  type ServerId,
} from "./app";

type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const topLevelKeys: Exactly<keyof RaftAppClient, "userinfo" | "servers" | "forServer"> = true;
const serverKeys: Exactly<keyof RaftAppServerClient, "serverId" | "serverinfo" | "membership" | "agents"> = true;
const optionKeys: Exactly<keyof CreateRaftAppClientOptions, "accessToken" | "baseUrl" | "fetch"> = true;
// Every method takes no argument: there is nowhere to put a Server.
const noArguments: Exactly<
  Parameters<RaftAppClient["userinfo"]> | Parameters<RaftAppClient["servers"]>
  | Parameters<RaftAppServerClient["serverinfo"]> | Parameters<RaftAppServerClient["membership"]>
  | Parameters<RaftAppServerClient["agents"]>,
  []
> = true;

async function proofs(raft: RaftAppClient, server: RaftAppServer) {
  // @ts-expect-error the top-level client has no Server read: go through forServer
  await raft.serverinfo();
  // @ts-expect-error the top-level client has no Server read: go through forServer
  await raft.membership();
  // @ts-expect-error the top-level client has no Server read: go through forServer
  await raft.agents();
  // @ts-expect-error userinfo names no Server
  await raft.userinfo({ server_id: server.id });
  // @ts-expect-error servers takes no Server
  await raft.servers({ server_id: server.id });

  const bound = raft.forServer(server.id);
  const id: ServerId = bound.serverId;
  // @ts-expect-error the bound client adds server_id itself
  await bound.serverinfo({ server_id: id });
  // @ts-expect-error the bound client adds server_id itself
  await bound.membership({ server_id: id });
  // @ts-expect-error the bound client adds server_id itself
  await bound.agents({ server_id: id });
  // @ts-expect-error the bound Server cannot be changed
  bound.serverId = id;

  // @ts-expect-error a client is never created for a Server
  createRaftAppClient({ accessToken: "slock_at_x", server_id: id });
  // @ts-expect-error a client is never created for a Server
  createRaftAppClient({ accessToken: "slock_at_x", serverId: id });

  // Roles and principal types are open: a value Raft adds later still types.
  const knownRole: RaftAppServerRole = server.role;
  const futureRole: RaftAppServerRole = "auditor";
  const futureType: RaftAppPrincipalType = "app_bot";
  void knownRole;
  void futureRole;
  void futureType;

  // @ts-expect-error a plain string is not a ServerId: only the SDK mints one
  const minted: ServerId = "95f993fa-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  void minted;
}

void topLevelKeys;
void serverKeys;
void optionKeys;
void noArguments;
void proofs;
