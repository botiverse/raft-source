import { useEffect, useState, useCallback, useRef } from "react";
import {
  ChevronRight,
  FolderClosed,
  FolderOpen,
  FileText,
  File,
  RefreshCw,
  ArrowLeft,
  AlertTriangle,
  Eye,
  EyeOff,
} from "lucide-react";
import { InlineCode } from "raft-ui";
import { SegmentedControl, SegmentedControlItem, SegmentedControlLabel } from "raft-ui";
import { useIntl } from "react-intl";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import api from "../../api/client";
import SectionEyebrow from "../ui/SectionEyebrow";
import Spinner from "../ui/Spinner";
import { useResizablePanel } from "../../hooks/useResizablePanel";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { transparentImageBackgroundClass } from "../../utils/imagePreviewStyles";
import { MARKDOWN_BLOCKQUOTE_BASE_CLASS } from "../markdown/MarkdownContent";
import CodeBlock from "../markdown/CodeBlock";
import CopyIconButton from "../ui/CopyIconButton";
import { useAgentStore } from "../../store/agentStore";
import type { AgentRuntimeProfileRef } from "../../store/agentStore";
import type { FileNode } from "@botiverse/raft-shared";

interface FileContent {
  content: string | null;
  binary: boolean;
  path: string;
  size: number;
  modifiedAt: string;
  mimeType?: string;
  encoding?: "utf-8" | "base64";
}

function workspaceViewPreferenceKey(agentId: string) {
  return `slock:agentWorkspace:${agentId}:showHidden`;
}

// --- File tree node component ---

function TreeNode({
  node,
  depth,
  selectedPath,
  expandedDirs,
  loadingDirs,
  loadingLabel,
  getChildren,
  onSelectFile,
  onToggleDir,
}: {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  loadingLabel: string;
  getChildren: (dirPath: string) => FileNode[] | undefined;
  onSelectFile: (path: string) => void;
  onToggleDir: (path: string) => void;
}) {
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedPath === node.path;
  const isMemory = node.name === "memory.md";
  const isLoading = loadingDirs.has(node.path);
  const hiddenTextClass = node.isHidden ? "text-black/55" : "";

  if (node.isDirectory) {
    const children = isExpanded ? getChildren(node.path) : undefined;
    return (
      <div>
        <button
          type="button"
          onClick={() => onToggleDir(node.path)}
          className={`flex w-full items-center gap-1 py-1 pr-2 text-sm text-left hover:bg-black/5 transition-colors ${
            isSelected ? "bg-brutal-pink/20" : ""
          }`}
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <ChevronRight
            size={14}
            className={`shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
          />
          {isExpanded ? (
            <FolderOpen size={14} className="shrink-0 text-brutal-orange" />
          ) : (
            <FolderClosed size={14} className="shrink-0 text-brutal-orange" />
          )}
          <span className={`truncate font-medium ${hiddenTextClass}`}>{node.name}</span>
        </button>
        {isExpanded && (
          <div>
            {isLoading ? (
              <div
                className="flex items-center gap-1.5 py-1 text-xs text-black/40 font-mono"
                style={{ paddingLeft: `${(depth + 1) * 16 + 22}px` }}
              >
                <Spinner size="xs" />
                {loadingLabel}
              </div>
            ) : children ? (
              children.map((child) => (
                <TreeNode
                  key={child.path}
                  node={child}
                  depth={depth + 1}
                  selectedPath={selectedPath}
                  expandedDirs={expandedDirs}
                  loadingDirs={loadingDirs}
                  loadingLabel={loadingLabel}
                  getChildren={getChildren}
                  onSelectFile={onSelectFile}
                  onToggleDir={onToggleDir}
                />
              ))
            ) : null}
          </div>
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelectFile(node.path)}
      className={`flex w-full items-center gap-1 py-1 pr-2 text-sm text-left transition-colors ${
        isSelected
          ? "bg-brutal-pink/20 border-r-2 border-brutal-pink"
          : "hover:bg-black/5"
      }`}
      style={{ paddingLeft: `${depth * 16 + 22}px` }}
    >
      <FileText size={14} className="shrink-0 text-black/50" />
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

export default function AgentWorkspace({ agentId, compact }: { agentId: string; compact?: boolean }) {
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
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
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

  // Load root workspace files
  const loadRoot = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    setLoadedDirs(new Map());
    setLoadingDirs(new Set());
    try {
      const { data } = await api.get(`/agents/${agentId}/workspace-files`, {
        params: { includeHidden: showHiddenFiles },
      });
      if (currentAgentIdRef.current !== agentId) return;
      const tree = data.files as FileNode[];
      setRootFiles(tree);
      setExpandedDirs(new Set());
    } catch (err) {
      console.error("Failed to load workspace files:", err);
      setRootFiles([]);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [agentId, showHiddenFiles]);

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
    } catch (err) {
      console.error(`Failed to load directory ${dirPath}:`, err);
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  }, [showHiddenFiles]);

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
    try {
      const { data } = await api.get(`/agents/${agentId}/workspace-files`, {
        params: { includeHidden: showHiddenFiles },
      });
      if (currentAgentIdRef.current !== agentId) return;
      const tree = data.files as FileNode[];
      setRootFiles(tree);

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
  }, [agentId, loadDirectoryDirect, showHiddenFiles]);

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

  // Resizable file tree panel (desktop only, not in compact mode)
  const {
    width: treeWidth,
    handleResizeStart,
    handleResizeMove,
    handleResizeEnd,
  } = useResizablePanel({ storageKey: "slock:workspaceTreeWidth", min: 160, max: 600, defaultWidth: 256 });

  const workspacePath = runtimeWorkspacePath ?? `~/.slock/agents/${agentId}/`;
  const [copied, setCopied] = useState(false);

  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(workspacePath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [workspacePath]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-brutal-cream">
      {/* Workspace path bar */}
      <div className="flex items-center gap-2 border-b border-black/10 bg-white px-3 py-1.5">
        <span className="min-w-0 truncate text-xs font-mono text-black/50">
          {workspacePath}
        </span>
        <CopyIconButton
          onClick={handleCopyPath}
          copied={copied}
          copiedLabel={formatMessage({ id: "agent.workspace.copiedPath" })}
          copyLabel={formatMessage({ id: "agent.workspace.copyPath" })}
          surface="light"
          iconSize={12}
          className="shrink-0"
        />
      </div>

      <div className="flex min-h-0 flex-1">
      {/* Left pane: file tree — full width when compact/mobile and no file selected, resizable on desktop */}
      <div
        className={`${selectedPath ? (compact ? "hidden" : "hidden md:flex") : "flex"} relative ${compact ? "min-w-full" : "min-w-full md:min-w-0"} shrink-0 flex-col ${compact ? "" : "border-r-2 border-black"} bg-white`}
        style={compact ? undefined : { width: treeWidth }}
      >
        {/* Resize handle (desktop only, not in compact mode) */}
        {!compact && (
        <div
          className="hidden md:block absolute right-0 top-0 bottom-0 w-2 -mr-1 z-10 cursor-col-resize touch-none select-none"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
        />
        )}
        {/* Tree header */}
        <div className="flex items-center justify-between border-b border-black/10 px-3 py-2">
          <SectionEyebrow>
            {formatMessage({ id: "agent.workspace.title" })}
          </SectionEyebrow>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => handleToggleHiddenFiles(!showHiddenFiles)}
              className={`flex size-7 shrink-0 items-center justify-center transition-colors hover:text-black ${
                showHiddenFiles ? "text-black" : "text-black/40"
              }`}
              title={showHiddenFiles
                ? formatMessage({ id: "agent.workspace.hiddenFilesShown" })
                : formatMessage({ id: "agent.workspace.hiddenFilesHidden" })}
              aria-label={showHiddenFiles
                ? formatMessage({ id: "agent.workspace.hiddenFilesShown" })
                : formatMessage({ id: "agent.workspace.hiddenFilesHidden" })}
              aria-pressed={showHiddenFiles}
            >
              {showHiddenFiles ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              className="text-black/40 hover:text-black transition-colors"
              title={formatMessage({ id: "agent.workspace.refresh" })}
            >
              <RefreshCw size={12} />
            </button>
          </div>
        </div>

        {/* Tree content */}
        <div className="flex-1 overflow-y-auto py-1">
          {loading ? (
            <div className="px-3 py-4 text-center text-sm text-black/40 font-mono">
              {formatMessage({ id: "agent.workspace.loading" })}
            </div>
          ) : loadError ? (
            <div className="px-3 py-4 text-center">
              <AlertTriangle size={20} className="mx-auto mb-1.5 text-brutal-orange" />
              <div className="text-sm text-black/60 font-mono mb-2">
                {formatMessage({ id: "agent.workspace.filesLoadFailed" })}
              </div>
              <button
                type="button"
                onClick={handleRefresh}
                className="btn-brutal-sm px-2 py-1 text-xs bg-white"
              >
                {formatMessage({ id: "agent.workspace.retry" })}
              </button>
            </div>
          ) : rootFiles.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-black/40 font-mono">
              {formatMessage({ id: "agent.workspace.noFiles" })}
            </div>
          ) : (
            rootFiles.map((node) => (
              <TreeNode
                key={node.path}
                node={node}
                depth={0}
                selectedPath={selectedPath}
                expandedDirs={expandedDirs}
                loadingDirs={loadingDirs}
                loadingLabel={formatMessage({ id: "agent.workspace.loading" })}
                getChildren={getChildren}
                onSelectFile={handleSelectFile}
                onToggleDir={handleToggleDir}
              />
            ))
          )}
        </div>
      </div>

      {/* Right pane: file content viewer — hidden on mobile/compact when no file selected */}
      <div className={`${!selectedPath ? (compact ? "hidden" : "hidden md:flex") : "flex"} min-w-0 flex-1 flex-col`}>
        {!selectedPath ? (
          <div className="flex flex-1 items-center justify-center text-black/30 font-mono text-sm">
            <div className="text-center">
              <File size={32} className="mx-auto mb-2 opacity-30" />
              {formatMessage({ id: "agent.workspace.selectFile" })}
            </div>
          </div>
        ) : loadingFile ? (
          <div className="flex flex-1 items-center justify-center text-black/40 font-mono text-sm">
            {formatMessage({ id: "agent.workspace.loading" })}
          </div>
        ) : !fileContent ? (
          <div className="flex flex-1 items-center justify-center text-black/40 font-mono text-sm">
            {fileError || formatMessage({ id: "agent.workspace.fileLoadFailed" })}
          </div>
        ) : (
          <>
            {/* File header — name + back + view mode toggle */}
            <div className="flex items-center gap-2 border-b border-black/10 bg-white px-4 py-2">
              <button
                type="button"
                onClick={() => { setSelectedPath(null); setFileContent(null); setFileError(null); }}
                className={`${compact ? "" : "md:hidden"} shrink-0 text-black/60 hover:text-black transition-colors`}
              >
                <ArrowLeft size={16} />
              </button>
              {/* min-w-0 wrapper so truncate engages in flex context. Without
                  it, a long unbreakable path keeps its intrinsic width and
                  pushes the right-side toggle/buttons past the panel edge.
                  #proj-uiux task #133. */}
              <span className="min-w-0 flex-1 font-mono text-sm font-medium text-black truncate">
                {fileContent.path}
              </span>
              {fileContent.path.endsWith(".md") && (
                <SegmentedControl
                  value={viewMode}
                  onValueChange={setViewMode}
                  aria-label={formatMessage({ id: "agent.workspace.viewMode" })}
                  className="ml-auto shrink-0"
                >
                  <SegmentedControlItem value="raw" data-testid="workspace-file-view-raw">
                    <SegmentedControlLabel>{formatMessage({ id: "agent.workspace.raw" })}</SegmentedControlLabel>
                  </SegmentedControlItem>
                  <SegmentedControlItem value="preview" data-testid="workspace-file-view-preview">
                    <SegmentedControlLabel>{formatMessage({ id: "agent.workspace.preview" })}</SegmentedControlLabel>
                  </SegmentedControlItem>
                </SegmentedControl>
              )}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4">
              {isWorkspaceImagePreview(fileContent) ? (
                <div className="flex h-full min-h-0 items-center justify-center overflow-auto">
                  <img
                    src={`data:${fileContent.mimeType};base64,${fileContent.content}`}
                    alt={fileContent.path}
                    className={`max-h-full max-w-full border-2 border-black object-contain ${transparentImageBackgroundClass}`}
                  />
                </div>
              ) : fileContent.binary ? (
                <div className="flex h-full items-center justify-center text-black/40 font-mono text-sm">
                  {formatMessage({ id: "agent.workspace.binaryCannotDisplay" })}
                </div>
              ) : fileContent.path.endsWith(".md") && viewMode === "preview" ? (
                <div className="text-sm text-black break-words">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                      pre: ({ children }) => (
                        <CodeBlock className="overflow-x-auto border-2 border-black bg-[#07111f] p-3 pr-12 text-sm text-[#f5f7ff] font-mono [&>code]:border-0 [&>code]:bg-transparent [&>code]:p-0">
                          {children}
                        </CodeBlock>
                      ),
                      code: ({ children, className }) => {
                        if (!className) {
                          return (
                            <InlineCode className="bg-soft-signal/40 text-sm [overflow-wrap:anywhere]">
                              {children}
                            </InlineCode>
                          );
                        }
                        return <code className={className}>{children}</code>;
                      },
                      a: ({ href, children }) => (
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-700 underline decoration-2 underline-offset-2 hover:text-brutal-pink"
                        >
                          {children}
                        </a>
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
                      table: ({ children }) => (
                        <div className="my-2 overflow-x-auto">
                          <table className="border-collapse border-2 border-black text-sm">
                            {children}
                          </table>
                        </div>
                      ),
                      th: ({ children }) => (
                        <th className="border-2 border-black bg-brutal-cyan px-2 py-1 text-left font-bold whitespace-nowrap">
                          {children}
                        </th>
                      ),
                      td: ({ children }) => (
                        <td className="border border-black px-2 py-1">{children}</td>
                      ),
                      h1: ({ children }) => <h1 className="text-xl font-bold mt-4 mb-2">{children}</h1>,
                      h2: ({ children }) => <h2 className="text-lg font-bold mt-3 mb-1.5">{children}</h2>,
                      h3: ({ children }) => <h3 className="text-base font-bold mt-2 mb-1">{children}</h3>,
                      h4: ({ children }) => <h4 className="text-sm font-bold mt-2 mb-1">{children}</h4>,
                      h5: ({ children }) => <h5 className="text-sm font-bold mt-1.5 mb-0.5">{children}</h5>,
                      h6: ({ children }) => <h6 className="text-sm font-bold mt-1.5 mb-0.5 text-black/70">{children}</h6>,
                      hr: () => <hr className="my-3 border-t-2 border-black" />,
                      img: ({ src, alt }) => (
                        <img src={src} alt={alt || ""} className={`my-2 max-w-full border-2 border-black ${transparentImageBackgroundClass}`} />
                      ),
                    }}
                  >
                    {fileContent.content || ""}
                  </ReactMarkdown>
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words text-sm font-mono text-black">
                  {fileContent.content || ""}
                </pre>
              )}
            </div>

            {/* Bottom bar — file size + modified date */}
            <div className="flex items-center gap-3 border-t border-black/10 bg-white px-4 py-1.5 text-xs text-black/40 font-mono">
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
