import { Button, Select, SelectContent, SelectIcon, SelectList, SelectTrigger, SelectValue, Popover, PopoverTrigger, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle } from "@botiverse/raft-ui";
import { useCallback, useState, useEffect, useMemo } from "react";
import { ChevronRight, Shield } from "lucide-react";
import type { ServerRole } from "@botiverse/raft-shared";
import { useServerStore } from "../../../store/serverStore";
import { useAgentStore } from "../../../store/agentStore";
import { useServerPermissions } from "../../../hooks/useServerPermissions";
import Banner from "../../../components/ui/Banner";
import { useIntl } from "react-intl";
import SectionHeader from "../../../components/ui/SectionHeader";
import SelectionPopover from "../../../components/ui/SelectionPopover";
import { getAdminCandidatePrincipals, getAdminPrincipalKey, getAdminPrincipalLabel, getAdminPrincipalRoleOptions, getAdminPrincipals } from "../../../utils/serverAdminSettings";
import type { ServerAdminSettingsPrincipal } from "../../../utils/serverAdminSettings";
import { AdminPrincipalRow } from "../../../components/settings/AdminPrincipalRow";
import type { SelectOption } from "../shared/selectOptions";
import { renderSelectItems } from "../shared/renderSelectItems";
import { renderPrincipalAvatar } from "./renderPrincipalAvatar";
import { OwnComputersTransferNote } from "../../../components/member/MemberRemovalImpactNote";
import { useMemberRemovalImpact } from "../../../components/member/useMemberRemovalImpact";
import { useAuthStore } from "../../../store/authStore";

type AdminRole = Extract<ServerRole, "owner" | "admin">;

export function AdminsSection() {
  const { formatMessage } = useIntl();
  const members = useServerStore((s) => s.members);
  const loadMembers = useServerStore((s) => s.loadMembers);
  const updateMemberRole = useServerStore((s) => s.updateMemberRole);
  const allAgents = useAgentStore((s) => s.agents);
  const loadAgents = useAgentStore((s) => s.loadAgents);
  const updateAgent = useAgentStore((s) => s.updateAgent);
  const { role, capabilities } = useServerPermissions();

  const agents = useMemo(() => allAgents.filter((agent) => !agent.deletedAt), [allAgents]);
  const [selectedPrincipalKey, setSelectedPrincipalKey] = useState("");
  const [selectedRole, setSelectedRole] = useState<AdminRole>("admin");
  const [adminPrincipalSearch, setAdminPrincipalSearch] = useState("");
  const [principalPickerOpen, setPrincipalPickerOpen] = useState(false);
  const [savingPrincipalKey, setSavingPrincipalKey] = useState<string | null>(null);
  const [error, setError] = useState("");

  const canManageAdminRoles = capabilities.changeMemberRoles;
  const admins = useMemo(() => getAdminPrincipals(members, agents), [members, agents]);
  const candidates = useMemo(() => getAdminCandidatePrincipals(members, agents, role), [members, agents, role]);
  // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
  const selectedCandidate = candidates.find((principal) => getAdminPrincipalKey(principal) === selectedPrincipalKey) ?? null;
  const selectedRoleOptions = useMemo(
    () => (selectedCandidate ? getAdminPrincipalRoleOptions(role, selectedCandidate) : []),
    [role, selectedCandidate],
  );
  const adminRoleSelectOptions = useMemo<SelectOption[]>(() => [
    { value: "owner", label: formatMessage({ id: "settings.admins.owner" }), disabled: !selectedRoleOptions.includes("owner") },
    { value: "admin", label: formatMessage({ id: "settings.admins.admin" }), disabled: !selectedRoleOptions.includes("admin") },
  ], [formatMessage, selectedRoleOptions]);
  const ownerCount = members.filter((member) => member.role === "owner").length;
  // An owner about to make someone else owner: what becomes of the Computers
  // they attached here, from their own removal impact (Warden, 2026-11-09).
  const serverId = useServerStore((s) => s.current?.id);
  const selfUserId = useAuthStore((s) => s.user?.id);
  const grantsOwner = role === "owner" && selectedRole === "owner" && selectedCandidate?.kind === "human";
  const ownImpact = useMemberRemovalImpact(serverId, grantsOwner ? selfUserId : null);
  const filteredCandidates = useMemo(() => {
    if (!adminPrincipalSearch.trim()) return candidates;
    const needle = adminPrincipalSearch.trim().toLowerCase();
    return candidates.filter((principal) => {
      const label = getAdminPrincipalLabel(principal, formatMessage).toLowerCase();
      const identity = principal.kind === "human"
        ? [principal.email, principal.name].filter(Boolean).join(" ")
        : `@${principal.name}`;
      return `${label} ${identity}`.toLowerCase().includes(needle);
    });
  }, [adminPrincipalSearch, candidates, formatMessage]);

  useEffect(() => {
    if (!canManageAdminRoles) return;
    void loadMembers();
    void loadAgents();
  }, [canManageAdminRoles, loadAgents, loadMembers]);

  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (selectedPrincipalKey && !candidates.some((principal) => getAdminPrincipalKey(principal) === selectedPrincipalKey)) {
      // oxlint-disable-next-line react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      setSelectedPrincipalKey("");
    }
  }, [candidates, selectedPrincipalKey]);

  // Each opening starts from an empty search.
  const handlePrincipalPickerOpenChange = useCallback((open: boolean) => {
    if (open) setAdminPrincipalSearch("");
    setPrincipalPickerOpen(open);
  }, []);

  // List-dep default narrowing: when the candidate (or current admin's own
  // role) changes, the available admin role options shrink/grow; fall the
  // user's `selectedRole` back to the first option if their previous pick
  // isn't in the new set. NOT a mirror-prop pattern — `selectedRole` is a
  // user-editable choice that must be narrowed when the available set
  // shifts. Same shape as CreateAgentDialog's list-dep default in PR #2524.
  useEffect(() => {
    if (!selectedCandidate) {
      // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-chain-state-updates -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
      setSelectedRole("admin");
      return;
    }
    const options = getAdminPrincipalRoleOptions(role, selectedCandidate);
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (!options.includes(selectedRole)) {
      // oxlint-disable-next-line react-doctor/no-derived-state
      setSelectedRole(options[0] ?? "admin");
    }
  }, [role, selectedCandidate, selectedRole]);

  const popoverOptions = useMemo(() => filteredCandidates.map((principal) => {
    const key = getAdminPrincipalKey(principal);
    return {
      key,
      checked: key === selectedPrincipalKey,
      onClick: () => {
        setSelectedPrincipalKey(key);
        setPrincipalPickerOpen(false);
        setAdminPrincipalSearch("");
      },
      label: principal.kind === "human"
        ? principal.email ? `${getAdminPrincipalLabel(principal, formatMessage)} · ${principal.email}` : getAdminPrincipalLabel(principal, formatMessage)
        : formatMessage(
          { id: "settings.admins.principalAgentSuffix" },
          { name: getAdminPrincipalLabel(principal, formatMessage) },
        ),
      reserveLeadingSlot: true,
      avatar: renderPrincipalAvatar(principal, "compact-list"),
    };
  }), [filteredCandidates, formatMessage, selectedPrincipalKey]);

  const updateAdminPrincipalRole = useCallback((
    principal: ServerAdminSettingsPrincipal,
    nextRole: Extract<ServerRole, "owner" | "admin" | "member">,
  ) => {
    if (principal.kind === "human") {
      return updateMemberRole(principal.userId, nextRole);
    }
    const agentRole: Extract<ServerRole, "admin" | "member"> = nextRole === "member" ? "member" : "admin";
    return updateAgent(principal.id, { serverRole: agentRole });
  }, [updateAgent, updateMemberRole]);

  const handlePromote = useCallback(async () => {
    if (!selectedCandidate) return;
    const key = getAdminPrincipalKey(selectedCandidate);
    setSavingPrincipalKey(key);
    setError("");
    try {
      await updateAdminPrincipalRole(selectedCandidate, selectedRole);
      setSelectedPrincipalKey("");
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.admins.failedUpdateRole" }));
    } finally {
      setSavingPrincipalKey(null);
    }
  }, [formatMessage, selectedCandidate, selectedRole, updateAdminPrincipalRole]);

  const handleDemote = useCallback(async (principal: ServerAdminSettingsPrincipal) => {
    const key = getAdminPrincipalKey(principal);
    setSavingPrincipalKey(key);
    setError("");
    try {
      await updateAdminPrincipalRole(principal, "member");
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.admins.failedRemoveRole" }));
    } finally {
      setSavingPrincipalKey(null);
    }
  }, [formatMessage, updateAdminPrincipalRole]);

  const handleClearPrincipal = useCallback(() => {
    setSelectedPrincipalKey("");
    setPrincipalPickerOpen(false);
  }, []);

  const handleSelectedRoleChange = useCallback((value: string | null) => {
    if (value == null) return;
    setSelectedRole(value as AdminRole);
  }, []);

  if (!canManageAdminRoles) return null;

  return (
    <div className="mb-6">
      <SectionHeader
        className="mb-3"
        icon={<Shield size={16} />}
        label={formatMessage({ id: "settings.admins.sectionLabel" })}
        count={admins.length}
      />

      {/* One ListRowGroup (DS Forms › A setting's row; cindyz, #proj-raft-ui:#220):
          adding an owner or admin is the first row (its fields side by side from 32rem
          of the group's own width), then a row per owner and admin. The Add row has
          no avatar, so the line under it starts at the row's edge (16px), not at the
          next row's text. */}
      <ListRowGroup className="@container [&>[data-slot=list-row]:nth-child(2)]:[--list-row-rule-start:16px]" data-testid="admins-rows">
        <ListRow variant="plain" interactive={false}>
          <ListRowBody render={<div />}>
            <ListRowTitle>{formatMessage({ id: "settings.admins.addLabel" })}</ListRowTitle>
            <div className="flex flex-col gap-2 pt-2 @lg:flex-row">
              {/* raft-ui Popover: the list is placed in a portal under the
                  field, as wide as it, and kept on screen; the popover owns the
                  toggle, outside presses and Escape. */}
              <div className="min-w-0 @lg:flex-[1_1_0%]">
                <Popover open={principalPickerOpen} onOpenChange={handlePrincipalPickerOpenChange}>
                  <PopoverTrigger
                    render={(
                      <button
                        type="button"
                        data-testid="admin-principal-picker"
                        disabled={candidates.length === 0 || savingPrincipalKey != null}
                        className="flex h-control w-full min-w-0 items-center justify-between gap-2 rounded-(--control-radius) border-[1.5px] border-line-field bg-layer-card pr-3 pl-3.5 text-left text-subhead font-semibold outline-none hover:overlay-medium focus-visible:shadow-focus disabled:cursor-not-allowed disabled:border-line-hairline disabled:bg-fill-muted disabled:text-foreground-disabled"
                      />
                    )}
                  >
                    <span className={`truncate ${selectedCandidate ? "text-foreground" : "font-medium text-foreground-hint"}`}>
                      {selectedCandidate
                        ? selectedCandidate.kind === "human" && selectedCandidate.email
                          ? `${getAdminPrincipalLabel(selectedCandidate, formatMessage)} · ${selectedCandidate.email}`
                          : getAdminPrincipalLabel(selectedCandidate, formatMessage)
                        : candidates.length > 0 ? formatMessage({ id: "settings.admins.membersSearchPlaceholder" }) : formatMessage({ id: "settings.admins.noMembers" })}
                    </span>
                    <ChevronRight size={16} className={`shrink-0 text-foreground-hint transition-transform ${principalPickerOpen ? "rotate-90" : ""}`} />
                  </PopoverTrigger>
                  <SelectionPopover
                    title={formatMessage({ id: "settings.admins.membersPickerTitle" })}
                    width="trigger"
                    searchable
                    search={adminPrincipalSearch}
                    onSearchChange={setAdminPrincipalSearch}
                    searchPlaceholder={formatMessage({ id: "settings.admins.membersSearchPlaceholder" })}
                    emptyLabel={formatMessage({ id: "settings.admins.noMatchingMembers" })}
                    options={popoverOptions}
                    showClear={!!selectedCandidate}
                    onClear={handleClearPrincipal}
                  />
                </Popover>
              </div>
              <div className="@lg:w-[120px] @lg:shrink-0">
                <Select
                  value={selectedRole}
                  onValueChange={handleSelectedRoleChange}
                  items={adminRoleSelectOptions}
                  disabled={!selectedCandidate || selectedRoleOptions.length === 0 || savingPrincipalKey != null}
                >
                  <SelectTrigger className="w-full min-w-[120px]">
                    <SelectValue placeholder={formatMessage({ id: "settings.admins.rolePlaceholder" })} />
                    <SelectIcon />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>
                      {renderSelectItems(adminRoleSelectOptions)}
                    </SelectList>
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="accent" size="lg"
                type="button"
                onClick={handlePromote}
                disabled={!selectedCandidate || selectedRoleOptions.length === 0 || savingPrincipalKey != null}
                className="@lg:shrink-0"
              >
                {selectedCandidate && savingPrincipalKey === getAdminPrincipalKey(selectedCandidate) ? formatMessage({ id: "settings.common.saving" }) : formatMessage({ id: "settings.admins.updateRole" })}
              </Button>
            </div>
            {grantsOwner ? <OwnComputersTransferNote state={ownImpact} className="mt-2" /> : null}
          </ListRowBody>
        </ListRow>
        {admins.length > 0 ? (
          admins.map((admin) => (
            <AdminPrincipalRow
              key={getAdminPrincipalKey(admin)}
              admin={admin}
              role={role}
              ownerCount={ownerCount}
              savingPrincipalKey={savingPrincipalKey}
              onDemote={handleDemote}
            />
          ))
        ) : (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowDescription wrap>{formatMessage({ id: "settings.admins.emptyState" })}</ListRowDescription>
            </ListRowBody>
          </ListRow>
        )}
      </ListRowGroup>
      {/* Adding and removing share this line, so it is under the whole group,
          not in the Add row. */}
      {error && (
        <Banner intent="warning" density="sm" className="mt-3" data-testid="admins-error">
          {error}
        </Banner>
      )}
    </div>
  );
}
