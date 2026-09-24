/**
 * Canonical key/value row — small label above value.
 *
 * Replaces the inline `<div><div className="text-xs text-black/50 mb-1">Foo</div><span className="text-sm text-black font-mono">bar</span></div>` pattern that appears 30+ times across detail panels (HumanDetailPanel, AgentDetailPanel, MachineDetailPanel) and the SettingsPanel body.
 *
 * Background: stdrc 2026-05-12 #wg-theme:a987f888 asked for strong-signal
 * primitives to be lifted in one PR. KeyValueRow is the second of the three.
 *
 * Slots:
 * - `label`           — the muted label text (string or node)
 * - `value`           — the value content (string or node, often code/mono)
 * - `mono`            — true → render the value cell in `font-mono`
 * - `breakAll`        — true → render the value cell with `break-all` (long
 *                       emails, hostnames, etc.)
 * - `action`          — optional inline trailing element rendered next to the
 *                       label (e.g. an edit pencil button)
 * - `className`       — additional classes on the outer wrapper
 * - `valueClassName`  — additional classes on the value cell
 *
 * Typography defaults match the canonical detail-panel KV convention: label
 * is `text-xs text-black/50 mb-1`, value is `text-sm text-black`. Pass
 * `mono` for fields like email / dates / IDs that are conventionally rendered
 * in monospace.
 *
 * If your row needs an inline-editable value (with Save/Cancel and per-row
 * loading state), this primitive is not the right fit — it intentionally
 * stays a presentational primitive. Inline-edit shells like the role / avatar
 * editors in HumanDetailPanel keep their own structure.
 */

import type { ReactNode } from "react";

export type KeyValueRowProps = {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  breakAll?: boolean;
  action?: ReactNode;
  className?: string;
  valueClassName?: string;
};

export default function KeyValueRow({
  label,
  value,
  mono = false,
  breakAll = false,
  action,
  className,
  valueClassName,
}: KeyValueRowProps) {
  const wrapperCls = className ? className : undefined;
  const valueClsParts = ["text-sm text-black"];
  if (mono) valueClsParts.push("font-mono");
  if (breakAll) valueClsParts.push("break-all");
  if (valueClassName) valueClsParts.push(valueClassName);
  const valueCls = valueClsParts.join(" ");
  return (
    <div className={wrapperCls}>
      <div className="mb-1 flex items-center gap-2">
        <div className="text-xs text-black/50">{label}</div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={valueCls}>{value}</div>
    </div>
  );
}
