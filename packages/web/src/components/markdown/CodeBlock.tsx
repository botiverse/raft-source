import { Children, isValidElement, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { CodeBlock as RuiCodeBlock, CodeBlockActions, CodeBlockBody, CodeBlockPre } from "@botiverse/raft-ui";
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
  /** Classes for the code's `pre`. With the copy button, raft-ui's CodeBlock
   *  draws the frame and the padding, so pass only what the code itself needs. */
  className: string;
  /** Classes for raft-ui's CodeBlockBody, e.g. to follow the message's
   *  font-size preference instead of the fixed code size. */
  bodyClassName?: string;
  code?: string;
  language?: string | null;
  /** The bare wrapper's classes, for a host that draws its own frame and has
   *  no copy button (the Mermaid source view). */
  wrapperClassName?: string;
  /** Hosts that provide their own copy affordance (e.g. the Mermaid toolbar)
   *  hide the hover copy icon so the same action never appears twice. */
  showCopyButton?: boolean;
}

export default function CodeBlock({
  children,
  className,
  bodyClassName,
  code,
  language,
  wrapperClassName = "group relative my-2",
  showCopyButton = true,
}: CodeBlockProps) {
  const { formatMessage } = useIntl();
  const extractedCodeText = useMemo(() => extractCodeBlockText(children), [children]);
  const codeText = code ?? extractedCodeText;
  const codeClassName = codeLanguageClass(language);
  const content = code !== undefined ? (
    <code className={codeClassName}>
      <ShikiHighlightedCode code={code} language={language} />
    </code>
  ) : (
    children
  );

  // raft-ui's CodeBlockPre measures its overflow with a ResizeObserver it
  // doesn't guard; where there is none (jsdom, very old browsers) the code
  // renders in a plain pre instead of throwing.
  const canObserveResize = typeof ResizeObserver !== "undefined";

  if (!showCopyButton) {
    return (
      <div data-code-block="" className={wrapperClassName}>
        <pre className={className}>{content}</pre>
      </div>
    );
  }

  // raft-ui's CodeBlock (Raft Design System › CodeBlock): the actions take a
  // column of their own at the top right, so the copy button never covers
  // the first line, and the code scrolls beside it. CodeBlockPre makes a
  // scrolling block reachable from the keyboard. The copy icon stays a
  // hover-revealed, chrome-less affordance (index.css .r-code-copy), like the
  // bookmark button on a message row; `group` lets it show on hover.
  return (
    <RuiCodeBlock data-code-block="" className="group">
      <CodeBlockBody className={bodyClassName}>
        <CodeBlockActions>
          <CopyButton text={codeText} resetKey={codeText} enabled={Boolean(codeText)}>
            {({ copied, disabled, onClick, onMouseDown }) => (
              <CopyIconButton
                onClick={onClick}
                onMouseDown={onMouseDown}
                disabled={disabled}
                copied={copied}
                copiedLabel={formatMessage({ id: "ui.copy.codeCopied" })}
                copyLabel={formatMessage({ id: "ui.copy.code" })}
                surface="code"
                // An action embedded in the block's frame: radius-chip.
                className="rounded-chip"
              />
            )}
          </CopyButton>
        </CodeBlockActions>
        {canObserveResize ? (
          <CodeBlockPre className={className} aria-label={formatMessage({ id: "ui.codeBlock.region" })}>
            {content}
          </CodeBlockPre>
        ) : (
          <pre className={className}>{content}</pre>
        )}
      </CodeBlockBody>
    </RuiCodeBlock>
  );
}
