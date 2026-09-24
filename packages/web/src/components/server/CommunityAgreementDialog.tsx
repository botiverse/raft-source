import { useState } from "react";
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import Modal from "../Modal";
import Banner from "../ui/Banner";
import AgreementBody from "./AgreementBody";

export interface CommunityAgreement {
  id: string;
  title: string;
  bodyMarkdown: string;
  version: number;
}

export default function CommunityAgreementDialog({
  agreement,
  onClose,
  onAgree,
}: {
  agreement: CommunityAgreement;
  onClose: () => void;
  onAgree: (agreementId: string) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleAgree = async () => {
    setSubmitting(true);
    setError("");
    try {
      await onAgree(agreement.id);
    } catch (err: any) {
      const response = err?.response?.data;
      setError(
        response?.error === "agreement_changed"
          ? formatMessage({ id: "server.communityAgreement.updated" })
          : formatMessage({ id: "server.communityAgreement.failedToJoin" }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg card-brutal p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">{agreement.title}</h2>
            <div className="mt-0.5 text-xs text-black/50">
              {formatMessage({ id: "server.communityAgreement.version" }, { version: agreement.version })}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn-brutal-sm shrink-0 bg-white p-1"
            title={formatMessage({ id: "common.close" })}
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[50vh] overflow-y-auto border-2 border-black bg-white p-4 text-sm">
          <AgreementBody source={agreement.bodyMarkdown} />
        </div>

        {error && (
          <Banner intent="warning" density="sm" className="mt-4 font-bold">
            {error}
          </Banner>
        )}

        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="btn-brutal bg-white px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {formatMessage({ id: "server.communityAgreement.cancel" })}
          </button>
          <button
            type="button"
            onClick={handleAgree}
            disabled={submitting}
            className="btn-brutal bg-brutal-pink px-3 py-1.5 text-xs disabled:opacity-50"
          >
            {submitting
              ? formatMessage({ id: "server.communityAgreement.joining" })
              : formatMessage({ id: "server.communityAgreement.agreeContinue" })}
          </button>
        </div>
      </div>
    </Modal>
  );
}
