import type { MessageId } from "../../i18n/messages";
import { Button, InlineCode, SegmentedControl, SegmentedControlItem, SegmentedControlLabel, Separator, Spinner, MarkdownLink, ScrollArea } from "@botiverse/raft-ui";
import { useEffect, useState, useCallback, useRef } from "react";
import {
  ChevronRight,
  FolderClosed,
  FolderOpen,
  FileText,
  File,
  FileSymlink,
  RefreshCw,
  ArrowLeft,
  AlertTriangle,
  Eye,
  EyeOff,
} from "lucide-react";
import { useIntl } from "react-intl";
import ReactMarkdown from "react-markdown";
import type { Components, Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly";
import api from "../../api/client";
import EmptyState from "../ui/EmptyState";
import SectionEyebrow from "../ui/SectionEyebrow";
import Tooltip from "../ui/Tooltip";
import { useColumnWidth } from "../../store/columnWidthStore";
import ColumnResizeHandle from "../ui/ColumnResizeHandle";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { transparentImageBackgroundClass } from "../../utils/imagePreviewStyles";
import { MARKDOWN_BLOCKQUOTE_BASE_CLASS } from "../markdown/MarkdownContent";
import CodeBlock from "../markdown/CodeBlock";
import CopyIconButton from "../ui/CopyIconButton";
import { useAgentStore } from "../../store/agentStore";
import type { AgentRuntimeProfileRef } from "../../store/agentStore";
import type { FileNode } from "@botiverse/raft-shared";
import { ICON_SM_END_PULL, ICON_SM_START_PULL } from "../ui/headEdges";

interface FileContent {
  content: string | null;
  binary: boolean;
  path: string;
  size: number;
  modifiedAt: string;
  mimeType?: string;
  encoding?: "utf-8" | "base64";
}

/** A listing the server cut short (hosted runtimes cap one directory level); `omitted` when it knows how many. */
interface DirTruncation {
  shown: number;
  omitted: number | null;
}

const ROOT_DIR_KEY = "";

function listingTruncation(data: { files?: unknown[]; truncated?: boolean; omitted?: number }): DirTruncation | null {
  if (data.truncated !== true) return null;
  return { shown: data.files?.length ?? 0, omitted: typeof data.omitted === "number" ? data.omitted : null };
}

function TruncationHint({ truncation, indent }: { truncation: DirTruncation; indent: number }) {
  const { formatMessage } = useIntl();
  return (
    <div
      className="py-1 pr-2 text-caption text-foreground-hint"
      style={{ paddingLeft: `${indent}px` }}
      data-testid="agent-workspace-truncated"
    >
      {truncation.omitted !== null
        ? formatMessage({ id: "agent.workspace.truncated" }, { shown: truncation.shown, omitted: truncation.omitted })
        : formatMessage({ id: "agent.workspace.truncatedUnknown" }, { shown: truncation.shown })}
    </div>
  );
}

function workspaceViewPreferenceKey(agentId: string) {
  return `slock:agentWorkspace:${agentId}:showHidden`;
}

// Stable plugin list / component map for the workspace markdown preview —
// passing fresh literals would re-mount ReactMarkdown's AST on every render.
const WORKSPACE_MARKDOWN_REMARK_PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm, remarkCjkFriendly];
const WORKSPACE_MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => (
    <CodeBlock className="text-foreground [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0">
      {children}
    </CodeBlock>
  ),
  code: ({ children, className }) => {
    if (!className) {
      return (
        <InlineCode appearance="message" className="bg-fill-muted text-foreground [overflow-wrap:break-word]">
          {children}
        </InlineCode>
      );
    }
    return <code className={className}>{children}</code>;
  },
  a: ({ href, children }) => (
    <MarkdownLink
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </MarkdownLink>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children, className, ...props }) => (
    <ul
      {...props}
      className={[className, "mb-2 pl-5 list-disc"].filter(Boolean).join(" ")}
    >
      {children}
    </ul>
  ),
  ol: ({ children, className, ...props }) => (
    <ol
      {...props}
      className={[className, "mb-2 pl-5 list-decimal"].filter(Boolean).join(" ")}
    >
      {children}
    </ol>
  ),
  li: ({ children, className, ...props }) => (
    <li
      {...props}
      className={[className, "mb-0.5"].filter(Boolean).join(" ")}
    >
      {children}
    </li>
  ),
  blockquote: ({ children }) => (
    <blockquote className={`${MARKDOWN_BLOCKQUOTE_BASE_CLASS} my-2`}>
      {children}
    </blockquote>
  ),
  // A wide table scrolls sideways in a horizontal raft-ui ScrollArea, as raft-ui's Markdown tables do.
  table: ({ children }) => (
    <ScrollArea orientation="horizontal" className="my-2">
      <table className="border-collapse border border-line-hairline text-callout">
        {children}
      </table>
    </ScrollArea>
  ),
  th: ({ children }) => (
    <th className="border border-line-hairline bg-fill-muted px-2 py-1 text-left font-bold whitespace-nowrap text-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-line-hairline px-2 py-1">{children}</td>
  ),
  h1: ({ children }) => <h1 className="mt-4 mb-2 text-title font-bold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-headline font-bold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 text-body font-bold">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 text-callout font-bold">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-1.5 mb-0.5 text-callout font-bold">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-1.5 mb-0.5 text-callout font-bold text-foreground-muted">{children}</h6>,
  hr: () => <Separator className="my-3" />,
  img: ({ src, alt }) => (
    <img src={src} alt={alt || ""} className={`my-2 max-w-full rounded-container border border-line-hairline ${transparentImageBackgroundClass}`} />
  ),
};

// --- File tree node component ---

// File names are machine text (Space Mono 13/20); the open file is the
// selected item of a content list (cyan-soft). Rows run edge to edge inside a
// scroller, so focus is drawn inset.
const TREE_ROW_CLASS ="flex w-full items-center gap-1 py-1 pr-2 text-left font-mono text-mono-code text-foreground transition-colors outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--foreground)]";

function TreeNode({
  node,
  depth,
  selectedPath,
  expandedDirs,
  loadingDirs,
  loadingLabel,
  symlinkLabel,
  getChildren,
  getTruncation,
  onSelectFile,
  onToggleDir,
}: {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  loadingLabel: string;
  symlinkLabel: string;
  getChildren: (dirPath: string) => FileNode[] | undefined;
  getTruncation: (dirPath: string) => DirTruncation | undefined;
  onSelectFile: (path: string) => void;
  onToggleDir: (path: string) => void;
}) {
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedPath === node.path;
  const isMemory = node.name === "memory.md";
  const isLoading = loadingDirs.has(node.path);
  const hiddenTextClass = node.isHidden ? "text-foreground-hint" : "";

  if (node.isDirectory) {
    const children = isExpanded ? getChildren(node.path) : undefined;
    const truncation = children ? getTruncation(node.path) : undefined;
    return (
      <div>
        <button
          type="button"
          onClick={() => onToggleDir(node.path)}
          className={`${TREE_ROW_CLASS} ${isSelected ? "bg-info-soft" : "hover:bg-fill-subtle"}`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <ChevronRight
            size={14}
            className={`shrink-0 text-foreground-hint transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
          {isExpanded ? (
            <FolderOpen size={14} className="shrink-0 text-foreground-muted" />
          ) : (
            <FolderClosed size={14} className="shrink-0 text-foreground-muted" />
          )}
          <span className={`truncate font-medium ${hiddenTextClass}`}>{node.name}</span>
        </button>
        {isExpanded && (
          <div>
            {isLoading ? (
              <div
                className="flex items-center gap-1.5 py-1 text-caption text-foreground-hint"
                style={{ paddingLeft: `${(depth + 1) * 16 + 22}px` }}
              >
                <Spinner size="xs" aria-label={loadingLabel} />
                {loadingLabel}
              </div>
            ) : children ? (
              <>
                {children.map((child) => (
                  <TreeNode
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    selectedPath={selectedPath}
                    expandedDirs={expandedDirs}
                    loadingDirs={loadingDirs}
                    loadingLabel={loadingLabel}
                    symlinkLabel={symlinkLabel}
                    getChildren={getChildren}
                    getTruncation={getTruncation}
                    onSelectFile={onSelectFile}
                    onToggleDir={onToggleDir}
                  />
                ))}
                {truncation && <TruncationHint truncation={truncation} indent={(depth + 1) * 16 + 22} />}
              </>
            ) : null}
          </div>
        )}
      </div>
    );
  }

  if (node.isSymlink) {
    // The daemon never follows a link in a workspace (it could point anywhere
    // on the Computer), so a link is shown but cannot be opened.
    return (
      <div
        data-testid="workspace-symlink-row"
        className={`${TREE_ROW_CLASS} cursor-default`}
        style={{ paddingLeft: `${depth * 16 + 22}px` }}
        title={symlinkLabel}
      >
        <FileSymlink size={14} className="shrink-0 text-foreground-hint" aria-hidden="true" />
        <span className={`truncate ${hiddenTextClass}`}>{node.name}</span>
        <span className="sr-only">{symlinkLabel}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelectFile(node.path)}
      className={`${TREE_ROW_CLASS} ${isSelected ? "bg-info-soft" : "hover:bg-fill-subtle"}`}
      style={{ paddingLeft: `${depth * 16 + 22}px` }}
    >
      <FileText size={14} className="shrink-0 text-foreground-muted" />
      <span className={`truncate ${isMemory ? "font-bold" : ""} ${hiddenTextClass}`}>
        {node.name}
      </span>
    </button>
  );
}

// --- Helper: format file size ---

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isWorkspaceImagePreview(fileContent: FileContent): boolean {
  return (
    fileContent.binary
    && fileContent.encoding === "base64"
    && !!fileContent.content
    && !!fileContent.mimeType?.startsWith("image/")
  );
}

function runtimeProfileRefPath(ref: AgentRuntimeProfileRef | string | null | undefined): string | null {
  if (!ref) return null;
  if (typeof ref === "string") return ref.trim() || null;
  return ref.path?.trim() || null;
}

function getFileReadErrorMessage(error: unknown, fallback: string) {
  const response = (error as { response?: { data?: { error?: unknown; message?: unknown } } }).response;
  const serverMessage = response?.data?.error ?? response?.data?.message;
  return typeof serverMessage === "string" && serverMessage.trim()
    ? serverMessage
    : fallback;
}

// --- Main component ---

/** Archived agents get a reason instead of a generic failure. */
function loadErrorMessageId(code: string | null): MessageId {
  if (code === "archive_workspace_unavailable") return "agent.workspace.archivedUnavailable";
  if (code === "machine_offline" || code === "daemon_offline") return "agent.workspace.computerOffline";
  if (code === "computer_access_revoked") return "agent.status.computerAccessRevoked";
  return "agent.workspace.filesLoadFailed";
}

/** Load errors that a retry cannot fix and that leave no Computer path to show. */
function isFinalLoadError(code: string | null): boolean {
  return code === "archive_workspace_unavailable" || code === "computer_access_revoked";
}

export default function AgentWorkspace({ agentId, compact, hosted }: { agentId: string; compact?: boolean; hosted?: boolean }) {
  const { formatMessage } = useIntl();
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const { formatShortDateTime } = useTimeFormatter();
  const runtimeWorkspacePath = useAgentStore((state) => {
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    return runtimeProfileRefPath(agent?.runtimeProfile?.current?.workspacePathRef);
  });
  const [rootFiles, setRootFiles] = useState<FileNode[]>([]);
  const [loadedDirs, setLoadedDirs] = useState<Map<string, FileNode[]>>(new Map());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [truncatedDirs, setTruncatedDirs] = useState<Map<string, DirTruncation>>(new Map());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // Archived agents: why the files cannot be read.
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [viewMode, setViewMode] = useState<"raw" | "preview">("preview");
  const [showHiddenFiles, setShowHiddenFiles] = useState(() => {
    try {
      return localStorage.getItem(workspaceViewPreferenceKey(agentId)) === "true";
    } catch {
      return false;
    }
  });

  // Track current agentId to guard against stale responses
  const currentAgentIdRef = useRef(agentId);
  currentAgentIdRef.current = agentId;

  const setDirTruncation = useCallback((dirPath: string, truncation: DirTruncation | null) => {
    setTruncatedDirs((prev) => {
      if (!truncation && !prev.has(dirPath)) return prev;
      const next = new Map(prev);
      if (truncation) next.set(dirPath, truncation);
      else next.delete(dirPath);
      return next;
    });
  }, []);

  // Load root workspace files
  const loadRoot = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    setLoadErrorCode(null);
    setLoadedDirs(new Map());
    setLoadingDirs(new Set());
    setTruncatedDirs(new Map());
    try {
      const { data } = await api.get(`/agents/${agentId}/workspace-files`, {
        params: { includeHidden: showHiddenFiles },
      });
      if (currentAgentIdRef.current !== agentId) return;
      const tree = data.files as FileNode[];
      setRootFiles(tree);
      setDirTruncation(ROOT_DIR_KEY, listingTruncation(data));
      setExpandedDirs(new Set());
    } catch (err) {
      console.error("Failed to load workspace files:", err);
      setRootFiles([]);
      const code = (err as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
      setLoadErrorCode(typeof code === "string" ? code : null);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [agentId, setDirTruncation, showHiddenFiles]);

  // Direct directory fetch (doesn't depend on loadedDirs state to avoid stale closure issues during loadRoot)
  const loadDirectoryDirect = useCallback(async (aid: string, dirPath: string) => {
    setLoadingDirs((prev) => {
      const next = new Set(prev);
      next.add(dirPath);
      return next;
    });
    try {
      const { data } = await api.get(`/agents/${aid}/workspace-files`, {
        params: { dirPath, includeHidden: showHiddenFiles },
      });
      if (currentAgentIdRef.current !== aid) return;
      setLoadedDirs((prev) => {
        const next = new Map(prev);
        next.set(dirPath, data.files as FileNode[]);
        return next;
      });
      setDirTruncation(dirPath, listingTruncation(data));
    } catch (err) {
      console.error(`Failed to load directory ${dirPath}:`, err);
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [setDirTruncation, showHiddenFiles]);

  // Reset + re-load on agent switch. This clears entity-scoped async UI state
  // and reloads the persisted per-agent hidden-file preference, not prop mirrors.
  // oxlint-disable react-doctor/no-derived-state, react-doctor/no-adjust-state-on-prop-change, react-doctor/no-cascading-set-state, react-doctor/no-chain-state-updates
  useEffect(() => {
    try {
      setShowHiddenFiles(localStorage.getItem(workspaceViewPreferenceKey(agentId)) === "true");
    } catch {
      setShowHiddenFiles(false);
    }
    loadRoot();
    setSelectedPath(null);
    setFileContent(null);
    setFileError(null);
  }, [agentId, loadRoot]);
  // oxlint-enable react-doctor/no-derived-state, react-doctor/no-adjust-state-on-prop-change, react-doctor/no-cascading-set-state, react-doctor/no-chain-state-updates

  // Get children for a directory (from cache)
  const getChildren = useCallback((dirPath: string): FileNode[] | undefined => {
    return loadedDirs.get(dirPath);
  }, [loadedDirs]);

  const getTruncation = useCallback((dirPath: string): DirTruncation | undefined => {
    return truncatedDirs.get(dirPath);
  }, [truncatedDirs]);

  // Load file content when selected
  const handleSelectFile = useCallback(
    async (filePath: string) => {
      setSelectedPath(filePath);
      setViewMode("preview");
      setLoadingFile(true);
      setFileError(null);
      try {
        const { data } = await api.get(
          `/agents/${agentId}/workspace-files/read`,
          { params: { path: filePath } }
        );
        setFileContent(data as FileContent);
      } catch (err) {
        console.error("Failed to read file:", err);
        setFileContent(null);
        setFileError(getFileReadErrorMessage(err, formatMessageRef.current({ id: "agent.workspace.fileLoadFailed" })));
      } finally {
        setLoadingFile(false);
      }
    },
    [agentId]
  );

  const handleToggleDir = useCallback((dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
        // Trigger lazy load if not cached
        if (!loadedDirs.has(dirPath)) {
          loadDirectoryDirect(agentId, dirPath);
        }
      }
      return next;
    });
  }, [agentId, loadedDirs, loadDirectoryDirect]);

  // Refresh: clear cache, re-fetch root, re-fetch children for currently expanded dirs
  const handleRefresh = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    setLoadedDirs(new Map());
    setLoadingDirs(new Set());
    setTruncatedDirs(new Map());
    try {
      const { data } = await api.get(`/agents/${agentId}/workspace-files`, {
        params: { includeHidden: showHiddenFiles },
      });
      if (currentAgentIdRef.current !== agentId) return;
      const tree = data.files as FileNode[];
      setRootFiles(tree);
      setDirTruncation(ROOT_DIR_KEY, listingTruncation(data));

      // Re-fetch children for currently expanded directories
      setExpandedDirs((current) => {
        for (const dirPath of current) {
          loadDirectoryDirect(agentId, dirPath);
        }
        return current;
      });
    } catch (err) {
      console.error("Failed to refresh workspace:", err);
      setRootFiles([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [agentId, loadDirectoryDirect, setDirTruncation, showHiddenFiles]);

  const handleToggleHiddenFiles = useCallback((checked: boolean) => {
    setShowHiddenFiles(checked);
    try {
      localStorage.setItem(workspaceViewPreferenceKey(agentId), checked ? "true" : "false");
    } catch {}
    setSelectedPath(null);
    setFileContent(null);
    setFileError(null);
    setExpandedDirs(new Set());
  }, [agentId]);
  const handleHiddenFilesClick = useCallback(() => handleToggleHiddenFiles(!showHiddenFiles), [handleToggleHiddenFiles, showHiddenFiles]);
  const handleCloseFile = useCallback(() => {
    setSelectedPath(null);
    setFileContent(null);
    setFileError(null);
  }, []);

  // Resizable file tree panel (desktop only, not in compact mode)
  const treeWidth = useColumnWidth("workspaceTree");

  const workspacePath = runtimeWorkspacePath ?? `~/.slock/agents/${agentId}/`;
  const [copied, setCopied] = useState(false);

  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(workspacePath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [workspacePath]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-layer-canvas">
      {/* Workspace path bar; a hosted agent has no local path to copy */}
      {!hosted && !isFinalLoadError(loadErrorCode) && <div className="flex items-center gap-2 border-b border-line-seam bg-layer-canvas px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-mono-meta text-foreground-muted">
          {workspacePath}
        </span>
        <CopyIconButton
          onClick={handleCopyPath}
          copied={copied}
          copiedLabel={formatMessage({ id: "agent.workspace.copiedPath" })}
          copyLabel={formatMessage({ id: "agent.workspace.copyPath" })}
          surface="light"
          className="shrink-0"
        />
      </div>}

      {/* Tree and file side by side once the workspace itself is 36rem wide
          (the tree's 256px and a readable file), whatever the window; below
          that, one pane at a time (raft-ui 0.23: switch on the region). */}
      <div className="@container/workspace flex min-h-0 flex-1">
      {/* Left pane: file tree — full width when compact/narrow and no file selected, resizable when wide */}
      <div
        className={`${selectedPath ? (compact ? "hidden" : "hidden @xl/workspace:flex") : "flex"} relative ${compact ? "min-w-full" : "min-w-full @xl/workspace:min-w-0"} shrink-0 flex-col ${compact ? "" : "border-r border-line-seam"} bg-layer-canvas`}
        style={compact ? undefined : { width: treeWidth }}
      >
        {/* Resize handle (desktop only, not in compact mode) */}
        {!compact && (
        <ColumnResizeHandle column="workspaceTree" edge="right" className="hidden @xl/workspace:block" />
        )}
        {/* Tree header */}
        {/* 12px each side; the last icon-md button is pulled out by its icon
            inset ((32 - 18) / 2) so its 18px icon box ends on the 12px line,
            mirroring the eyebrow's letters (headEdges.ts). */}
        <div className="flex items-center justify-between border-b border-line-seam px-3 py-1.5">
          <SectionEyebrow>
            {formatMessage({ id: "agent.workspace.title" })}
          </SectionEyebrow>
          <div className={`${ICON_SM_END_PULL} flex items-center gap-2`}>
            <Tooltip content={showHiddenFiles
              ? formatMessage({ id: "agent.workspace.hiddenFilesShown" })
              : formatMessage({ id: "agent.workspace.hiddenFilesHidden" })}>
              <Button
                variant="ghost"
                size="icon-md"
                onClick={handleHiddenFilesClick}
                className={showHiddenFiles ? "text-foreground" : "text-foreground-hint"}
                aria-label={showHiddenFiles
                  ? formatMessage({ id: "agent.workspace.hiddenFilesShown" })
                  : formatMessage({ id: "agent.workspace.hiddenFilesHidden" })}
                aria-pressed={showHiddenFiles}
              >
                {showHiddenFiles ? <Eye /> : <EyeOff />}
              </Button>
            </Tooltip>
            <Tooltip content={formatMessage({ id: "agent.workspace.refresh" })}>
              <Button
                variant="ghost"
                size="icon-md"
                onClick={handleRefresh}
                className="text-foreground-muted"
                aria-label={formatMessage({ id: "agent.workspace.refresh" })}
              >
                <RefreshCw />
              </Button>
            </Tooltip>
          </div>
        </div>

        {/* Tree content: each entry is a button, so its raft-ui ScrollArea is no tab stop. */}
        <ScrollArea tabIndex={-1} className="flex-1" contentClassName="py-1">
          {loading ? (
            <div className="px-3 py-4 text-center text-callout text-foreground-hint">
              {formatMessage({ id: "agent.workspace.loading" })}
            </div>
          ) : loadError ? (
            <div className="px-3 py-4 text-center">
              <AlertTriangle size={20} className="mx-auto mb-1.5 text-warning-strong" />
              <div className="mb-2 text-callout text-foreground-muted" data-testid="agent-workspace-load-error">
                {formatMessage({ id: loadErrorMessageId(loadErrorCode) })}
              </div>
              {!isFinalLoadError(loadErrorCode) && (
                <Button variant="outline" size="md"
                  type="button"
                  onClick={handleRefresh}
                >
                  {formatMessage({ id: "agent.workspace.retry" })}
                </Button>
              )}
            </div>
          ) : rootFiles.length === 0 ? (
            <div className="px-3 py-4 text-center text-callout text-foreground-hint">
              {formatMessage({ id: "agent.workspace.noFiles" })}
            </div>
          ) : (
            <>
              {rootFiles.map((node) => (
                <TreeNode
                  key={node.path}
                  node={node}
                  depth={0}
                  selectedPath={selectedPath}
                  expandedDirs={expandedDirs}
                  loadingDirs={loadingDirs}
                  loadingLabel={formatMessage({ id: "agent.workspace.loading" })}
                  symlinkLabel={formatMessage({ id: "agent.workspace.symlinkNotOpened" })}
                  getChildren={getChildren}
                  getTruncation={getTruncation}
                  onSelectFile={handleSelectFile}
                  onToggleDir={handleToggleDir}
                />
              ))}
              {truncatedDirs.get(ROOT_DIR_KEY) && (
                <TruncationHint truncation={truncatedDirs.get(ROOT_DIR_KEY)!} indent={8} />
              )}
            </>
          )}
        </ScrollArea>
      </div>

      {/* Right pane: file content viewer — hidden when compact/narrow and no file selected */}
      <div className={`${!selectedPath ? (compact ? "hidden" : "hidden @xl/workspace:flex") : "flex"} min-w-0 flex-1 flex-col`}>
        {!selectedPath ? (
          <EmptyState
            className="flex flex-1 flex-col items-center justify-center"
            icon={<File size={36} />}
            title={formatMessage({ id: "agent.workspace.selectFile" })}
          />
        ) : loadingFile ? (
          <div className="flex flex-1 items-center justify-center text-callout text-foreground-hint">
            {formatMessage({ id: "agent.workspace.loading" })}
          </div>
        ) : !fileContent ? (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-callout text-foreground-muted">
            {fileError || formatMessage({ id: "agent.workspace.fileLoadFailed" })}
          </div>
        ) : (
          <>
            {/* File header — name + back + view mode toggle */}
            <div className="flex items-center gap-2 border-b border-line-seam bg-layer-canvas px-4 py-2 md:pointer-fine:min-h-(--header-height) md:pointer-fine:py-[2.5px]">
              <Button
                variant="ghost"
                size="icon-md"
                onClick={handleCloseFile}
                aria-label={formatMessage({ id: "common.announcement.back" })}
                className={`${compact ? "" : "@xl/workspace:hidden"} ${ICON_SM_START_PULL} text-foreground-muted`}
              >
                <ArrowLeft />
              </Button>
              {/* min-w-0 wrapper so truncate engages in flex context. Without
                  it, a long unbreakable path keeps its intrinsic width and
                  pushes the right-side toggle/buttons past the panel edge.
                  #proj-uiux task #133. */}
              <span className="min-w-0 flex-1 truncate font-mono text-mono-code text-foreground">
                {fileContent.path}
              </span>
              {fileContent.path.endsWith(".md") && (
                <SegmentedControl
                  value={viewMode}
                  onValueChange={setViewMode}
                  aria-label={formatMessage({ id: "agent.workspace.viewMode" })}
                  className="ml-auto"
                >
                  <SegmentedControlItem value="preview" data-testid="workspace-file-view-preview">
                    <SegmentedControlLabel>{formatMessage({ id: "agent.workspace.preview" })}</SegmentedControlLabel>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="raw" data-testid="workspace-file-view-raw">
                    <SegmentedControlLabel>{formatMessage({ id: "agent.workspace.raw" })}</SegmentedControlLabel>
                  </SegmentedControlItem>
                </SegmentedControl>
              )}
            </div>

            {/* Content. The file scrolls in a raft-ui ScrollArea named after its path (a
                tab stop once it overflows). The padding stays on the area, so
                the image and binary notes still fill its height. */}
            <ScrollArea role="region" aria-label={fileContent.path} className="flex-1 p-4">
              {isWorkspaceImagePreview(fileContent) ? (
                // Fitted to the area and centred in it; the area around it is the scroller.
                <div className="flex h-full min-h-0 items-center justify-center">
                  <img
                    src={`data:${fileContent.mimeType};base64,${fileContent.content}`}
                    alt={fileContent.path}
                    className={`max-h-full max-w-full rounded-container border border-line-hairline object-contain ${transparentImageBackgroundClass}`}
                  />
                </div>
              ) : fileContent.binary ? (
                <div className="flex h-full items-center justify-center text-callout text-foreground-hint">
                  {formatMessage({ id: "agent.workspace.binaryCannotDisplay" })}
                </div>
              ) : fileContent.path.endsWith(".md") && viewMode === "preview" ? (
                <div className="break-words text-callout text-foreground">
                  <ReactMarkdown
                    remarkPlugins={WORKSPACE_MARKDOWN_REMARK_PLUGINS}
                    components={WORKSPACE_MARKDOWN_COMPONENTS}
                  >
                    {fileContent.content || ""}
                  </ReactMarkdown>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-mono-code text-foreground">
                  {fileContent.content || ""}
                </pre>
              )}
            </ScrollArea>

            {/* Bottom bar — file size + modified date */}
            <div className="flex items-center gap-3 border-t border-line-seam bg-layer-canvas px-4 py-1.5 font-mono text-mono-meta text-foreground-hint">
              <span>{formatSize(fileContent.size)}</span>
              <span>{formatShortDateTime(fileContent.modifiedAt)}</span>
            </div>
          </>
        )}
      </div>
      </div>
    </div>
  );
}
