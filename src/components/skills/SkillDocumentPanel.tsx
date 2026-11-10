import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronRight,
  FileCode,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import {
  skillsApi,
  type InstalledSkill,
  type SkillDocument,
  type SkillFileEntry,
} from "@/lib/api/skills";
import MarkdownEditor from "@/components/MarkdownEditor";
import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useDarkMode } from "@/hooks/useDarkMode";
import { SkillMarkdownPreview } from "./SkillMarkdownPreview";

interface FileTreeFolderNode {
  kind: "folder";
  name: string;
  path: string;
  children: FileTreeNode[];
}

interface FileTreeFileNode {
  kind: "file";
  name: string;
  path: string;
  size: number;
}

type FileTreeNode = FileTreeFolderNode | FileTreeFileNode;

function buildFileTree(entries: SkillFileEntry[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const folderMap = new Map<string, FileTreeFolderNode>();

  const ensureFolder = (
    segments: string[],
    parentChildren: FileTreeNode[],
  ): FileTreeFolderNode => {
    const folderPath = segments.join("/");
    const existing = folderMap.get(folderPath);
    if (existing) return existing;

    const folder: FileTreeFolderNode = {
      kind: "folder",
      name: segments[segments.length - 1],
      path: folderPath,
      children: [],
    };
    folderMap.set(folderPath, folder);
    parentChildren.push(folder);
    return folder;
  };

  for (const entry of entries) {
    const parts = entry.relativePath.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    let currentChildren = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const folder = ensureFolder(parts.slice(0, i + 1), currentChildren);
      currentChildren = folder.children;
    }

    currentChildren.push({
      kind: "file",
      name: parts[parts.length - 1],
      path: entry.relativePath,
      size: entry.size,
    });
  }

  const sortNodes = (nodes: FileTreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.path === "SKILL.md") return -1;
      if (b.path === "SKILL.md") return 1;
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.kind === "folder") sortNodes(node.children);
    }
  };

  sortNodes(root);
  return root;
}

function formatFileSize(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isMarkdownFile(relativePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(relativePath);
}

export function SkillDocumentPanel({
  skill,
  onClose,
  startEditing = false,
}: {
  skill: InstalledSkill;
  onClose: () => void;
  startEditing?: boolean;
}) {
  const { t } = useTranslation();
  const darkMode = useDarkMode();
  const queryClient = useQueryClient();
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set(),
  );
  const [document, setDocument] = useState<SkillDocument | null>(null);

  const { data: fileEntries = [{ relativePath: "SKILL.md", size: 0 }] } =
    useQuery({
      queryKey: ["skills", "files", skill.id],
      queryFn: async () => {
        try {
          const list = await skillsApi.listFiles(skill.id);
          return list.length > 0
            ? list
            : [{ relativePath: "SKILL.md", size: 0 }];
        } catch {
          return [{ relativePath: "SKILL.md", size: 0 }];
        }
      },
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    });

  const queryKey = useMemo(
    () =>
      selectedPath === "SKILL.md"
        ? ["skills", "document", skill.id]
        : ["skills", "file", skill.id, selectedPath],
    [skill.id, selectedPath],
  );

  const {
    data: fetchedDocument,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey,
    queryFn: () =>
      selectedPath === "SKILL.md"
        ? skillsApi.readDocument(skill.id)
        : skillsApi.readFile(skill.id, selectedPath),
    enabled: document === null,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(startEditing);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const savingRef = useRef(false);
  const dirty = document !== null && content !== document.content;
  const fileTree = useMemo(() => buildFileTree(fileEntries), [fileEntries]);
  const showFileTree = fileEntries.length > 1;
  const isMarkdown = isMarkdownFile(selectedPath);

  useEffect(() => {
    if (fetchedDocument && !error && !isFetching && document === null) {
      setDocument(fetchedDocument);
      setContent(fetchedDocument.content);
    }
  }, [fetchedDocument, error, isFetching, document]);

  const applySelectPath = (nextPath: string) => {
    setSelectedPath(nextPath);
    setDocument(null);
    setContent("");
    setEditing(false);
  };

  const handleSelectFile = (nextPath: string) => {
    if (savingRef.current || nextPath === selectedPath) return;
    if (dirty) {
      setPendingPath(nextPath);
      setConfirmDiscard(true);
    } else {
      applySelectPath(nextPath);
    }
  };

  const toggleFolder = (folderPath: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  };

  const handleClose = () => {
    if (savingRef.current) return;
    if (dirty) {
      setPendingPath(null);
      setConfirmDiscard(true);
    } else {
      onClose();
    }
  };

  const handleConfirmDiscard = () => {
    setConfirmDiscard(false);
    if (pendingPath !== null) {
      const target = pendingPath;
      setPendingPath(null);
      applySelectPath(target);
    } else {
      onClose();
    }
  };

  const handleCancelDiscard = () => {
    setPendingPath(null);
    setConfirmDiscard(false);
  };

  const handleSave = async () => {
    if (!document || !dirty || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const result =
        selectedPath === "SKILL.md"
          ? await skillsApi.saveDocument(skill.id, content, document.revision)
          : await skillsApi.saveFile(
              skill.id,
              selectedPath,
              content,
              document.revision,
            );
      setDocument(result.document);
      setContent(result.document.content);
      queryClient.setQueryData<SkillDocument>(queryKey, result.document);
      queryClient.setQueryData<InstalledSkill[]>(
        ["skills", "installed"],
        (skills) =>
          skills?.map((entry) =>
            entry.id === skill.id ? result.skill : entry,
          ),
      );
      await queryClient.invalidateQueries({ queryKey: ["skills", "backups"] });
      queryClient.setQueryData<SkillFileEntry[]>(
        ["skills", "files", skill.id],
        (entries) =>
          entries?.map((entry) =>
            entry.relativePath === selectedPath
              ? { ...entry, size: new Blob([result.document.content]).size }
              : entry,
          ),
      );
      setEditing(false);
      if (result.syncErrors.length) {
        toast.warning(t("skills.document.syncPartial"), {
          description: result.syncErrors.join("\n"),
          closeButton: true,
        });
      } else {
        toast.success(t("skills.document.saved"), {
          description: t("skills.backup.location", { path: result.backupPath }),
          closeButton: true,
        });
      }
    } catch (error) {
      toast.error(t("skills.document.saveFailed"), {
        description: String(error),
        closeButton: true,
      });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const renderTreeNodes = (nodes: FileTreeNode[], depth = 0) =>
    nodes.map((node) => {
      if (node.kind === "folder") {
        const isCollapsed = collapsedFolders.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              onClick={() => toggleFolder(node.path)}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              className="flex w-full items-center gap-1.5 rounded-md py-1.5 pr-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            >
              {isCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 shrink-0" />
              )}
              {isCollapsed ? (
                <Folder className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
              ) : (
                <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500/80" />
              )}
              <span className="truncate">{node.name}</span>
            </button>
            {!isCollapsed && (
              <div role="group">
                {renderTreeNodes(node.children, depth + 1)}
              </div>
            )}
          </div>
        );
      }

      const active = node.path === selectedPath;
      const Icon = isMarkdownFile(node.path) ? FileText : FileCode;
      const formattedSize = formatFileSize(node.size);

      return (
        <button
          key={node.path}
          type="button"
          aria-current={active ? "page" : undefined}
          onClick={() => handleSelectFile(node.path)}
          style={{ paddingLeft: `${depth * 12 + 12}px` }}
          className={`flex w-full items-center justify-between gap-2 rounded-md py-1.5 pr-2 text-left text-xs transition-colors ${
            active
              ? "bg-primary/15 font-medium text-primary"
              : "text-foreground/80 hover:bg-muted/60 hover:text-foreground"
          }`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{node.name}</span>
          </span>
          {formattedSize && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {formattedSize}
            </span>
          )}
        </button>
      );
    });

  const panelTitle =
    selectedPath === "SKILL.md"
      ? t("skills.document.title", { name: skill.name })
      : t("skills.document.fileTitle", {
          name: skill.name,
          file: selectedPath,
          defaultValue: `${skill.name} · ${selectedPath}`,
        });

  return (
    <>
      <FullScreenPanel
        isOpen
        title={panelTitle}
        onClose={handleClose}
        footer={
          document && !error ? (
            <Button
              onClick={handleSave}
              disabled={
                !dirty ||
                (selectedPath === "SKILL.md" && !content.trim()) ||
                saving
              }
            >
              {saving ? t("common.saving") : t("common.save")}
            </Button>
          ) : undefined
        }
      >
        <div
          className={
            showFileTree
              ? "grid grid-cols-1 gap-4 md:grid-cols-[240px_minmax(0,1fr)] items-start"
              : undefined
          }
        >
          {showFileTree && (
            <aside
              aria-label={t("skills.document.files", {
                defaultValue: "文件目录",
              })}
              className="glass rounded-xl border border-white/10 p-3 space-y-2 md:sticky md:top-0"
            >
              <div className="flex items-center justify-between px-2 py-1 border-b border-border/50">
                <span className="text-xs font-semibold text-foreground">
                  {t("skills.document.files", { defaultValue: "文件目录" })}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {t("skills.document.fileCount", {
                    count: fileEntries.length,
                    defaultValue: `${fileEntries.length}`,
                  })}
                </span>
              </div>
              <nav className="max-h-[65vh] overflow-y-auto space-y-0.5 pr-1">
                {renderTreeNodes(fileTree)}
              </nav>
            </aside>
          )}

          <div className="min-w-0">
            {!document && !error ? (
              <p role="status">{t("skills.loading")}</p>
            ) : error ? (
              <div role="alert" className="space-y-3">
                <p>{t("skills.document.loadFailed")}</p>
                <p className="break-words text-sm text-muted-foreground">
                  {String(error)}
                </p>
                <Button onClick={() => void refetch()}>
                  {t("skills.document.retry")}
                </Button>
              </div>
            ) : document ? (
              <div className="glass rounded-xl border border-white/10 p-6 space-y-4">
                <div className="flex items-center justify-between gap-4">
                  <div
                    role="group"
                    aria-label={t("skills.document.mode")}
                    className="flex gap-2"
                  >
                    <Button
                      variant={editing ? "outline" : "default"}
                      aria-pressed={!editing}
                      disabled={saving}
                      onClick={() => setEditing(false)}
                    >
                      {t("skills.document.preview")}
                    </Button>
                    <Button
                      variant={editing ? "default" : "outline"}
                      aria-pressed={editing}
                      disabled={saving}
                      onClick={() => setEditing(true)}
                    >
                      {t("skills.document.edit")}
                    </Button>
                  </div>
                  {dirty && (
                    <span className="text-sm text-muted-foreground">
                      {t("skills.document.unsaved")}
                    </span>
                  )}
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  {document.path}
                </p>
                {skill.repoOwner && (
                  <p className="text-xs text-muted-foreground">
                    {t("skills.document.updateWarning")}
                  </p>
                )}
                {editing ? (
                  <MarkdownEditor
                    ariaLabel={selectedPath}
                    value={content}
                    onChange={setContent}
                    darkMode={darkMode}
                    readOnly={saving}
                    minHeight="360px"
                  />
                ) : isMarkdown ? (
                  <SkillMarkdownPreview content={content} />
                ) : (
                  <pre className="my-2 overflow-x-auto rounded-lg bg-muted/60 p-4 font-mono text-xs leading-relaxed text-foreground">
                    <code>{content}</code>
                  </pre>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </FullScreenPanel>
      <ConfirmDialog
        isOpen={confirmDiscard}
        title={t("skills.document.discardTitle")}
        message={t("skills.document.discardMessage")}
        confirmText={t("skills.document.discard")}
        onConfirm={handleConfirmDiscard}
        onCancel={handleCancelDiscard}
      />
    </>
  );
}
