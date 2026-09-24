import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import Modal from "../Modal";

export default function DialogCard({
  title,
  titleId,
  onClose,
  children,
  maxWidthClass = "max-w-md",
  testId,
  closeOnBackdrop = false,
}: {
  title: ReactNode;
  titleId?: string;
  onClose: () => void;
  children: ReactNode;
  maxWidthClass?: string;
  testId?: string;
  /** Passed through because some callers close on backdrop and some must not.
   *  Without it, adopting this shell would silently take backdrop-close away
   *  from a dialog that had it — a behaviour change wearing a refactor's
   *  clothes. Defaults to the previous behaviour of this component. */
  closeOnBackdrop?: boolean;
}) {
  const { formatMessage } = useIntl();
  return (
    <Modal onClose={onClose} closeOnBackdrop={closeOnBackdrop}>
      <div className={`card-brutal w-full ${maxWidthClass} p-6`} data-testid={testId}>
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-bold uppercase">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="btn-brutal-sm bg-white p-1"
            aria-label={formatMessage({ id: "common.close" })}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </Modal>
  );
}
