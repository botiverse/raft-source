import { useState } from "react";
import { X } from "lucide-react";
import { useIntl } from "react-intl";
import Modal from "../Modal";
import SidebarSectionEmojiPicker from "./SidebarSectionEmojiPicker";

export default function SidebarSectionDialog({
  title,
  initialName = "",
  initialEmoji = "",
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  initialName?: string;
  initialEmoji?: string;
  submitLabel: string;
  onSubmit: (value: { name: string; emoji: string | null }) => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const [name, setName] = useState(initialName);
  const [emoji, setEmoji] = useState(initialEmoji);
  const trimmedName = name.trim();

  return (
    <Modal onClose={onClose} closeOnBackdrop>
      <div className="card-brutal w-full max-w-sm bg-white p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-bold uppercase">{title}</h2>
          <button type="button" onClick={onClose} className="btn-brutal-sm bg-white p-1" aria-label={formatMessage({ id: "common.close" })}>
            <X size={18} />
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!trimmedName) return;
            onSubmit({ name: trimmedName, emoji: emoji.trim() || null });
          }}
          className="space-y-4"
        >
          <div>
            <div className="mb-1 text-xs font-bold uppercase">
              {formatMessage({ id: "layout.sidebar.sectionName" })}
            </div>
            <div className="flex items-stretch border-2 border-black bg-white shadow-brutal-sm focus-within:shadow-brutal">
              <SidebarSectionEmojiPicker value={emoji} onChange={setEmoji} />
              <input
                autoFocus
                aria-label={formatMessage({ id: "layout.sidebar.sectionName" })}
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="min-w-0 flex-1 bg-white px-3 py-2 font-display normal-case focus:outline-none"
                placeholder={formatMessage({ id: "layout.sidebar.sectionNamePlaceholder" })}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-brutal bg-white px-3 py-2 text-sm">
              {formatMessage({ id: "layout.sidebar.cancelSection" })}
            </button>
            <button type="submit" disabled={!trimmedName} className="btn-brutal bg-brutal-pink px-3 py-2 text-sm disabled:opacity-50">
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
