import type { ReactNode } from "react";
import { useIntl } from "react-intl";

type AgreementBlock =
  | { type: "paragraph"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

const unorderedPattern = /^\s*[-*]\s+(.+)$/;
const orderedPattern = /^\s*\d+[.)]\s+(.+)$/;

function pushParagraph(blocks: AgreementBlock[], lines: string[]) {
  if (lines.length > 0) {
    blocks.push({ type: "paragraph", lines: [...lines] });
    lines.length = 0;
  }
}

function parseAgreementBody(source: string): AgreementBlock[] {
  const blocks: AgreementBlock[] = [];
  const paragraphLines: string[] = [];
  let list: Extract<AgreementBlock, { type: "ul" | "ol" }> | null = null;

  const flushList = () => {
    if (list && list.items.length > 0) blocks.push(list);
    list = null;
  };

  for (const rawLine of source.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    const unordered = unorderedPattern.exec(line);
    const ordered = orderedPattern.exec(line);

    if (!line.trim()) {
      pushParagraph(blocks, paragraphLines);
      flushList();
      continue;
    }

    if (unordered || ordered) {
      pushParagraph(blocks, paragraphLines);
      const type = unordered ? "ul" : "ol";
      const item = (unordered?.[1] ?? ordered?.[1] ?? "").trim();
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list!.items.push(item);
      continue;
    }

    flushList();
    paragraphLines.push(line.trim());
  }

  pushParagraph(blocks, paragraphLines);
  flushList();
  return blocks;
}

function renderLines(lines: string[]): ReactNode {
  return lines.map((line, index) => (
    <span key={index}>
      {index > 0 && <br />}
      {line}
    </span>
  ));
}

export default function AgreementBody({ source }: { source: string }) {
  const { formatMessage } = useIntl();
  const blocks = parseAgreementBody(source);
  if (blocks.length === 0) {
    return (
      <p className="text-black/50">
        {formatMessage({ id: "server.communityAgreement.nothingToPreview" })}
      </p>
    );
  }

  return (
    <div className="space-y-2 whitespace-pre-wrap break-words">
      {blocks.map((block, index) => {
        if (block.type === "ul") {
          return (
            <ul key={index} className="list-disc space-y-1 pl-5">
              {block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}
            </ul>
          );
        }
        if (block.type === "ol") {
          return (
            <ol key={index} className="list-decimal space-y-1 pl-5">
              {block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}
            </ol>
          );
        }
        return <p key={index}>{renderLines(block.lines)}</p>;
      })}
    </div>
  );
}
