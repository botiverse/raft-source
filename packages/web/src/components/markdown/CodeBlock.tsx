import { Children, isValidElement, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import CopyButton from "../ui/CopyButton";
import CopyIconButton from "../ui/CopyIconButton";
import { codeLanguageClass } from "./codeBlockLanguages";
import ShikiHighlightedCode from "./ShikiHighlightedCode";

export function extractCodeBlockText(node: ReactNode): string {
  let text = "";

  Children.forEach(node, (child) => {
    if (typeof child === "string" || typeof child === "number") {
      text += child;
      return;
    }

    if (Array.isArray(child)) {
      text += extractCodeBlockText(child);
      return;
    }

    if (isValidElement<{ children?: ReactNode }>(child)) {
      text += extractCodeBlockText(child.props.children);
    }
  });

  return text;
}

interface CodeBlockProps {
  children: ReactNode;
  className: string;
  code?: string;
  language?: string | null;
  wrapperClassName?: string;
  /** Hosts that provide their own copy affordance (e.g. the Mermaid toolbar)
   *  hide the hover copy icon so the same action never appears twice. */
  showCopyButton?: boolean;
}

export default function CodeBlock({
  children,
  className,
  code,
  language,
  wrapperClassName = "group relative my-2",
  showCopyButton = true,
}: CodeBlockProps) {
  const { formatMessage } = useIntl();
  const extractedCodeText = useMemo(() => extractCodeBlockText(children), [children]);
  const codeText = code ?? extractedCodeText;
  const codeClassName = codeLanguageClass(language);

  // Hover-revealed minimal copy affordance (no card / no border / no
  // shadow). Mirrors the bookmark button at the top-right of every
  // message row — both are "appear on hover, no chrome of their own"
  // affordances. Code blocks live on a dark surface, so the icon uses light
  // tones; touch devices keep the icon softly visible via CopyIconButton.
  return (
    <div className={wrapperClassName}>
      {showCopyButton ? (
        <CopyButton text={codeText} resetKey={codeText} enabled={Boolean(codeText)}>
          {({ copied, disabled, onClick, onMouseDown }) => (
            <CopyIconButton
              onClick={onClick}
              onMouseDown={onMouseDown}
              disabled={disabled}
              copied={copied}
              copiedLabel={formatMessage({ id: "ui.copy.codeCopied" })}
              copyLabel={formatMessage({ id: "ui.copy.code" })}
              surface="dark"
              className="absolute right-2 top-2 z-10"
            />
          )}
        </CopyButton>
      ) : null}
      <pre className={className}>
        {code !== undefined ? (
          <code className={codeClassName}>
            <ShikiHighlightedCode code={code} language={language} />
          </code>
        ) : (
          children
        )}
      </pre>
    </div>
  );
}
