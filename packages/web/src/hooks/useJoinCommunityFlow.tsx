import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { useNavigate } from "react-router-dom";
import { useServerStore } from "../store/serverStore";
import type { CommunityServerSlug, Server } from "../store/serverStore";
import CommunityAgreementDialog from "../components/server/CommunityAgreementDialog";
import type { CommunityAgreement } from "../components/server/CommunityAgreementDialog";

type JoinCommunityOutcome =
  | { status: "joined"; server: Server }
  | { status: "agreement_required"; agreement: CommunityAgreement }
  | { status: "error"; error: unknown; message: string };

type JoinCommunityFlowOptions = {
  onJoined?: (server: Server, slug: CommunityServerSlug) => void;
  onError?: (error: unknown, slug: CommunityServerSlug, message: string) => void;
  joinedServerNavigation?: "same-tab" | "new-tab";
};

function agreementFromJoinError(error: unknown): CommunityAgreement | null {
  const response = (error as { response?: { data?: { error?: string; agreement?: CommunityAgreement } } })?.response?.data;
  if ((response?.error === "agreement_required" || response?.error === "agreement_changed") && response.agreement) {
    return response.agreement;
  }
  return null;
}

function communityJoinErrorMessage(
  error: unknown,
  formatMessage: IntlShape["formatMessage"],
) {
  const typed = error as { response?: { data?: { error?: string } }; message?: string };
  if (typed.message === "server.community.missingAfterJoin") {
    return formatMessage({ id: "server.community.missingAfterJoin" });
  }
  return typed.response?.data?.error
    || formatMessage({ id: "server.communityAgreement.failedToJoin" });
}

export function useJoinCommunityFlow({
  onJoined,
  onError,
  // Stryker disable next-line StringLiteral: values other than "new-tab" keep the default same-tab branch.
  joinedServerNavigation = "same-tab",
}: JoinCommunityFlowOptions = {}) {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const joinCommunityServer = useServerStore((s) => s.joinCommunityServer);
  const [joiningCommunitySlug, setJoiningCommunitySlug] = useState<CommunityServerSlug | null>(null);
  const [pendingAgreement, setPendingAgreement] = useState<CommunityAgreement | null>(null);
  const [pendingCommunitySlug, setPendingCommunitySlug] = useState<CommunityServerSlug | null>(null);

  const reserveJoinedServerTab = useCallback(() => {
    if (joinedServerNavigation !== "new-tab") return null;
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    return tab;
  }, [joinedServerNavigation]);

  const closeReservedTab = (tab: Window | null) => {
    try {
      if (tab && !tab.closed) tab.close();
    } catch {
      // Best effort only. Browsers can refuse script-close for some windows.
    }
  };

  const completeJoin = useCallback(
    (server: Server, slug: CommunityServerSlug, reservedTab?: Window | null) => {
      onJoined?.(server, slug);
      const path = `/s/${server.slug}`;
      if (joinedServerNavigation === "new-tab") {
        if (reservedTab && !reservedTab.closed) {
          reservedTab.location.href = path;
        } else {
          window.open(path, "_blank", "noopener,noreferrer");
        }
        return;
      }
      navigate(path);
    },
    [joinedServerNavigation, navigate, onJoined],
  );

  const joinCommunity = useCallback(
    async (slug: CommunityServerSlug): Promise<JoinCommunityOutcome> => {
      setJoiningCommunitySlug(slug);
      const reservedTab = reserveJoinedServerTab();
      try {
        const joined = await joinCommunityServer({ slug });
        setPendingAgreement(null);
        setPendingCommunitySlug(null);
        completeJoin(joined, slug, reservedTab);
        return { status: "joined", server: joined };
      } catch (error: unknown) {
        const agreement = agreementFromJoinError(error);
        if (agreement) {
          closeReservedTab(reservedTab);
          setPendingCommunitySlug(slug);
          setPendingAgreement(agreement);
          return { status: "agreement_required", agreement };
        }
        closeReservedTab(reservedTab);
        const message = communityJoinErrorMessage(error, formatMessage);
        onError?.(error, slug, message);
        return { status: "error", error, message };
      } finally {
        setJoiningCommunitySlug(null);
      }
    },
    [completeJoin, formatMessage, joinCommunityServer, onError, reserveJoinedServerTab],
  );

  const agreementDialog = pendingAgreement && pendingCommunitySlug ? (
    <CommunityAgreementDialog
      agreement={pendingAgreement}
      onAgree={async (agreementId) => {
        setJoiningCommunitySlug(pendingCommunitySlug);
        const reservedTab = reserveJoinedServerTab();
        try {
          const joined = await joinCommunityServer({ agreementId, slug: pendingCommunitySlug });
          const joinedSlug = pendingCommunitySlug;
          setPendingAgreement(null);
          setPendingCommunitySlug(null);
          completeJoin(joined, joinedSlug, reservedTab);
        } catch (error: unknown) {
          closeReservedTab(reservedTab);
          const message = communityJoinErrorMessage(error, formatMessage);
          onError?.(error, pendingCommunitySlug, message);
          throw error;
        } finally {
          setJoiningCommunitySlug(null);
        }
      }}
      onClose={() => {
        setPendingAgreement(null);
        setPendingCommunitySlug(null);
      }}
    />
  ) : null;

  return {
    agreementDialog,
    joiningCommunitySlug,
    joinCommunity,
  };
}
