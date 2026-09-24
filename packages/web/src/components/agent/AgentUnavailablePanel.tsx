import { Bot, TriangleAlert, X } from "lucide-react";
import { useIntl } from "react-intl";
import { useMobileBack } from "../../hooks/useAppNavigate";
import { useServerStore } from "../../store/serverStore";
import EmptyState from "../ui/EmptyState";
import PanelHeader from "../ui/PanelHeader";

export default function AgentUnavailablePanel({ onClose }: { onClose?: () => void }) {
  const { formatMessage } = useIntl();
  const slug = useServerStore((s) => s.current?.slug);
  const onMobileBack = useMobileBack(onClose ?? (slug ? `/s/${slug}/members` : "/"));

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <PanelHeader
        title={formatMessage({ id: "agent.detail.unavailableTitle" })}
        onMobileBack={onMobileBack}
        mobileBackProps={{
          "data-testid": "agent-mobile-back",
          title: formatMessage({ id: "common.announcement.back" }),
        }}
        icon={<Bot size={18} />}
        iconBg="bg-gray-200"
        actions={onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="btn-brutal-sm hidden size-7 items-center justify-center bg-white md:flex"
            title={formatMessage({ id: "common.close" })}
          >
            <X size={14} />
          </button>
        ) : null}
      />
      <EmptyState
        className="flex flex-1 flex-col justify-center"
        icon={<TriangleAlert size={36} />}
        title={formatMessage({ id: "agent.detail.unavailableTitle" })}
        description={formatMessage({ id: "agent.detail.unavailableDescription" })}
        data-testid="agent-unavailable-panel"
      />
    </div>
  );
}
