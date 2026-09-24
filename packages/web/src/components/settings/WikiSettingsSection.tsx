import { useState } from "react";
import { Network, RotateCcw } from "lucide-react";
import { useIntl } from "react-intl";

import api from "../../api/client";
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import SectionHeader from "../ui/SectionHeader";

function resetFailureKind(error: unknown): "reminders" | "reset" {
  if (typeof error !== "object" || !error || !("response" in error)) return "reset";
  const response = (error as {
    response?: {
      data?: { phase?: string; resetCompleted?: boolean };
    };
  }).response;
  return response?.data?.phase === "reminders" || response?.data?.resetCompleted
    ? "reminders"
    : "reset";
}

export default function WikiSettingsSection() {
  const { formatMessage } = useIntl();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetWiki = async () => {
    setResetting(true);
    setNotice(null);
    setError(null);
    try {
      await api.post("/wiki/reset");
      setResetOpen(false);
      setNotice(formatMessage({ id: "wiki.reset.completed" }));
    } catch (resetError: unknown) {
      setResetOpen(false);
      setError(formatMessage({
        id: resetFailureKind(resetError) === "reminders"
          ? "wiki.reset.failedReminders"
          : "wiki.reset.failed",
      }));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="mb-6" data-testid="wiki-settings-section">
      <SectionHeader
        className="mb-3"
        icon={<Network size={16} />}
        label={formatMessage({ id: "wiki.settings.maintenance" })}
      />
      <div className="space-y-4 border-2 border-black bg-white p-4 shadow-brutal-sm">
        <div>
          <div className="text-sm font-bold text-black">{formatMessage({ id: "wiki.reset.title" })}</div>
          <p className="mt-1 text-sm leading-relaxed text-black/60">
            {formatMessage({ id: "wiki.reset.description" })}
          </p>
        </div>

        {notice && <Banner intent="info" density="sm" withIcon>{notice}</Banner>}
        {error && <Banner intent="warning" density="sm" withIcon>{error}</Banner>}

        <Button
          size="md"
          shape="iconText"
          tone="red"
          data-testid="wiki-reset-open"
          onClick={() => setResetOpen(true)}
        >
          <RotateCcw size={15} />
          {formatMessage({ id: "wiki.reset.action" })}
        </Button>
      </div>

      {resetOpen && (
        <ConfirmDialog
          title={formatMessage({ id: "wiki.reset.title" })}
          message={formatMessage({ id: "wiki.reset.confirmation" })}
          chromeLocale="active"
          confirmLabel={formatMessage({ id: "wiki.reset.action" })}
          loadingLabel={formatMessage({ id: "wiki.reset.loading" })}
          confirmIcon={<RotateCcw size={15} />}
          confirmDisabled={resetting}
          confirmTestId="wiki-reset-confirm"
          closeOnConfirm={false}
          onConfirm={resetWiki}
          onClose={() => setResetOpen(false)}
        />
      )}
    </div>
  );
}
