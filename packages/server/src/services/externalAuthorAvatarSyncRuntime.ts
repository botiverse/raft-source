type AvatarSyncRequest = Readonly<{
  authorType: "user" | "agent";
  authorId: string;
}>;

type AvatarSyncHandler = (request: AvatarSyncRequest) => Promise<unknown>;

const handlers = new Set<AvatarSyncHandler>();

export function installExternalAuthorAvatarSyncHandler(handler: AvatarSyncHandler): () => void {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export async function requestExternalAuthorAvatarSync(request: AvatarSyncRequest): Promise<void> {
  await Promise.allSettled([...handlers].map((handler) => handler(request)));
}

export function __resetExternalAuthorAvatarSyncHandlersForTests(): void {
  handlers.clear();
}
