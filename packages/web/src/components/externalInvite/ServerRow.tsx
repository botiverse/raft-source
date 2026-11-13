import { ListRow, ListRowBody, ListRowGroup, ListRowMeta, ListRowTitle } from "@botiverse/raft-ui";
import type { Server } from "../../store/serverStore";
import AvatarSlot from "../ui/AvatarSlot";

/**
 * One server, shown not chosen (DS ListRow › inset list, display-only: no
 * chevron, no press): its tile, its name and a machine-type line under it.
 */
export function ServerRow({ server, name, meta }: { server: Server | null; name: string; meta: string | null }) {
  return (
    <ListRowGroup className="mb-6" data-testid="external-invite-server-row">
      <ListRow interactive={false}>
        <span className="shrink-0" aria-hidden="true">
          <AvatarSlot
            context="list-row"
            type="server"
            serverAvatarUrl={server?.avatarUrl ?? null}
            serverInitial={name.slice(0, 1)}
          />
        </span>
        <ListRowBody>
          <ListRowTitle>{name}</ListRowTitle>
          {meta ? <ListRowMeta>{meta}</ListRowMeta> : null}
        </ListRowBody>
      </ListRow>
    </ListRowGroup>
  );
}
