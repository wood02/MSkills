import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  FileDiff,
  FileText,
  History,
  Link2,
  RotateCcw,
  Save,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { promptsApi, type Prompt } from "@/lib/api/prompts";
import type {
  ProjectRuleRelativePath,
  ProjectRuleSnapshotRecord,
} from "@/lib/api/projects";
import {
  useApplyPromptToRuleMutation,
  useInsertAgentsReferenceMutation,
  useProjectRulesQuery,
  useProjectRuleSnapshotsQuery,
  useRestoreRuleSnapshotMutation,
  useSaveProjectRuleMutation,
} from "@/hooks/useProjects";

interface ProjectRulesPanelProps {
  projectId: string;
}

const RULE_FILES: ProjectRuleRelativePath[] = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
];

function getSnapshotActionBadge(
  action: string,
  t: (key: string) => string,
): { label: string; className: string } {
  switch (action) {
    case "before_save":
      return {
        label: t("projects.rules.snapshotAction.before_save"),
        className:
          "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
      };
    case "before_template":
      return {
        label: t("projects.rules.snapshotAction.before_template"),
        className:
          "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300",
      };
    case "before_insert_agents":
      return {
        label: t("projects.rules.snapshotAction.before_insert_agents"),
        className:
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      };
    case "before_restore":
      return {
        label: t("projects.rules.snapshotAction.before_restore"),
        className:
          "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
    default:
      return {
        label: action || t("projects.rules.snapshotAction.unknown"),
        className: "border-border bg-muted/60 text-muted-foreground",
      };
  }
}

export const ProjectRulesPanel: React.FC<ProjectRulesPanelProps> = ({
  projectId,
}) => {
  const { t } = useTranslation();
  const [activePath, setActivePath] =
    useState<ProjectRuleRelativePath>("CLAUDE.md");
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [selectedPromptId, setSelectedPromptId] = useState("");
  const [applyMode, setApplyMode] = useState<
    "managed_block" | "append" | "overwrite"
  >("managed_block");
  const [pendingDeleteSnapshot, setPendingDeleteSnapshot] =
    useState<ProjectRuleSnapshotRecord | null>(null);
  const [pendingSwitchPath, setPendingSwitchPath] =
    useState<ProjectRuleRelativePath | null>(null);
  const [pendingPreviewAction, setPendingPreviewAction] = useState<
    | { kind: "overwrite"; prompt: Prompt }
    | { kind: "insert_agents"; currentContent: string; nextContent: string }
    | null
  >(null);
  const [diffSnapshot, setDiffSnapshot] =
    useState<ProjectRuleSnapshotRecord | null>(null);

  const { data: ruleFiles = [], refetch: refetchRules } =
    useProjectRulesQuery(projectId);
  const { data: snapshots = [] } = useProjectRuleSnapshotsQuery(
    projectId,
    activePath,
  );

  const { data: allPrompts = [] } = useQuery({
    queryKey: ["projects", "all-global-prompts"],
    queryFn: async () => {
      const maps = await Promise.all([
        promptsApi.getPrompts("claude").catch(() => ({})),
        promptsApi.getPrompts("codex").catch(() => ({})),
        promptsApi.getPrompts("gemini").catch(() => ({})),
        promptsApi.getPrompts("opencode").catch(() => ({})),
      ]);
      const seen = new Map<string, Prompt>();
      for (const m of maps) {
        for (const p of Object.values(m)) {
          if (!seen.has(p.id)) seen.set(p.id, p);
        }
      }
      return Array.from(seen.values());
    },
  });

  const saveMutation = useSaveProjectRuleMutation();
  const applyPromptMutation = useApplyPromptToRuleMutation();
  const insertRefMutation = useInsertAgentsReferenceMutation();
  const restoreSnapshotMutation = useRestoreRuleSnapshotMutation();

  const activeFile = useMemo(
    () =>
      ruleFiles.find((f) => f.relativePath === activePath) ?? {
        projectId,
        relativePath: activePath,
        exists: false,
        content: "",
        revisionHash: null,
        sizeBytes: 0,
        hasAgentsReference: false,
        isSymlinkBlocked: false,
      },
    [ruleFiles, activePath, projectId],
  );

  useEffect(() => {
    setDraft(activeFile.content ?? "");
    setDirty(false);
  }, [activeFile.relativePath, activeFile.revisionHash, activeFile.content]);

  useEffect(() => {
    setPendingSwitchPath(null);
    setPendingPreviewAction(null);
    setDiffSnapshot(null);
  }, [projectId]);

  useEffect(() => {
    if (!selectedPromptId && allPrompts.length > 0) {
      setSelectedPromptId(allPrompts[0].id);
    }
  }, [allPrompts, selectedPromptId]);

  const handleSave = async (): Promise<boolean> => {
    try {
      await saveMutation.mutateAsync({
        projectId,
        relativePath: activePath,
        content: draft,
        expectedRevision: activeFile.revisionHash ?? null,
      });
      setDirty(false);
      toast.success(`已保存 ${activePath}`);
      return true;
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
      return false;
    }
  };

  const executeApplyPrompt = async () => {
    if (!selectedPromptId) return;
    try {
      await applyPromptMutation.mutateAsync({
        projectId,
        relativePath: activePath,
        promptId: selectedPromptId,
        applyMode,
        expectedRevision: activeFile.revisionHash ?? null,
      });
      setPendingPreviewAction(null);
      setDirty(false);
      toast.success(`已应用提示词到 ${activePath}`);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleApplyPrompt = async () => {
    if (!selectedPromptId) {
      toast.error("请先选择一个全局提示词模板");
      return;
    }
    if (applyMode === "overwrite") {
      const prompt = allPrompts.find((p) => p.id === selectedPromptId);
      if (prompt) {
        setPendingPreviewAction({ kind: "overwrite", prompt });
        return;
      }
    }
    await executeApplyPrompt();
  };

  const executeInsertAgentsRef = async () => {
    const claudeFile = ruleFiles.find((f) => f.relativePath === "CLAUDE.md");
    try {
      const res = await insertRefMutation.mutateAsync({
        projectId,
        expectedRevision: claudeFile?.revisionHash ?? null,
      });
      setPendingPreviewAction(null);
      if (res.alreadyPresent) {
        toast.info("CLAUDE.md 中已包含有效的 @AGENTS.md 引用");
      } else {
        setActivePath("CLAUDE.md");
        toast.success("已在 CLAUDE.md 顶部插入 @AGENTS.md");
      }
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleInsertAgentsRefClick = () => {
    const claudeFile = ruleFiles.find((f) => f.relativePath === "CLAUDE.md");
    const currentContent = claudeFile?.content ?? "";
    const nextContent = currentContent.trim()
      ? `@AGENTS.md\n\n${currentContent}`
      : `@AGENTS.md\n`;
    setPendingPreviewAction({
      kind: "insert_agents",
      currentContent,
      nextContent,
    });
  };

  const handleSelectRuleFile = (rel: ProjectRuleRelativePath) => {
    if (rel === activePath) return;
    if (dirty) {
      setPendingSwitchPath(rel);
      return;
    }
    setActivePath(rel);
  };

  const executeRestoreSnapshot = async (
    snap: ProjectRuleSnapshotRecord,
    confirmDelete: boolean,
  ) => {
    try {
      const res = await restoreSnapshotMutation.mutateAsync({
        projectId,
        snapshotId: snap.id,
        expectedCurrentRevision: activeFile.revisionHash ?? null,
        confirmDelete,
      });
      setPendingDeleteSnapshot(null);
      setDirty(false);
      toast.success(
        res.deletedFile
          ? `已按快照删除 ${activePath}（当时不存在该文件）`
          : `已恢复 ${activePath} 到历史快照`,
      );
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleRestoreSnapshotClick = (snap: ProjectRuleSnapshotRecord) => {
    if (!snap.fileExisted) {
      setPendingDeleteSnapshot(snap);
      return;
    }
    void executeRestoreSnapshot(snap, false);
  };

  const claudeMain = ruleFiles.find((f) => f.relativePath === "CLAUDE.md");
  const busy =
    saveMutation.isPending ||
    applyPromptMutation.isPending ||
    insertRefMutation.isPending ||
    restoreSnapshotMutation.isPending;

  return (
    <div className="grid h-full min-h-[460px] grid-cols-1 gap-4 lg:grid-cols-12">
      <div className="flex min-w-0 flex-col gap-3 lg:col-span-8">
        <div className="flex flex-wrap items-center gap-1.5">
          {RULE_FILES.map((rel) => {
            const file = ruleFiles.find((f) => f.relativePath === rel);
            const active = rel === activePath;
            return (
              <Button
                key={rel}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                onClick={() => handleSelectRuleFile(rel)}
                className="h-8 text-xs font-mono"
              >
                <FileText className="mr-1.5 h-3.5 w-3.5" />
                {rel}
                {file?.exists ? (
                  <span className="ml-1.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                ) : (
                  <span className="ml-1.5 text-[10px] opacity-60">
                    (未创建)
                  </span>
                )}
              </Button>
            );
          })}
        </div>

        {activeFile.isSymlinkBlocked && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              检测到该路径为符号链接或穿过符号链接，出于安全保护拒绝读取或写入。
            </span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            {claudeMain?.hasAgentsReference ? (
              <Badge
                variant="outline"
                className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              >
                <CheckCircle2 className="mr-1 h-3 w-3" />
                {t("projects.rules.agentsRefPresent")}
              </Badge>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {t("projects.rules.agentsRefMissing")}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  disabled={busy || Boolean(claudeMain?.isSymlinkBlocked)}
                  onClick={handleInsertAgentsRefClick}
                >
                  <Link2 className="mr-1 h-3 w-3" />
                  {t("projects.rules.insertAgentsRef")}
                </Button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            <Select
              value={selectedPromptId}
              onValueChange={setSelectedPromptId}
            >
              <SelectTrigger className="h-7 w-40 text-xs">
                <SelectValue placeholder="选择全局 Prompt" />
              </SelectTrigger>
              <SelectContent>
                {allPrompts.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={applyMode}
              onValueChange={(v) =>
                setApplyMode(v as "managed_block" | "append" | "overwrite")
              }
            >
              <SelectTrigger className="h-7 w-28 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="managed_block">托管块更新</SelectItem>
                <SelectItem value="append">末尾追加</SelectItem>
                <SelectItem value="overwrite">整文件覆盖</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="h-7 text-xs"
              disabled={
                busy || !selectedPromptId || activeFile.isSymlinkBlocked
              }
              onClick={() => void handleApplyPrompt()}
            >
              <Sparkles className="mr-1 h-3 w-3" />
              {t("projects.rules.applyPrompt")}
            </Button>
          </div>
        </div>

        <Textarea
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setDirty(true);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              if (dirty && !busy && !activeFile.isSymlinkBlocked) {
                void handleSave();
              }
            }
          }}
          disabled={activeFile.isSymlinkBlocked}
          placeholder={
            activeFile.exists
              ? ""
              : `${activePath} ${t("projects.rules.createHint")}`
          }
          className="min-h-[340px] flex-1 resize-none font-mono text-xs leading-relaxed"
        />

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="tabular-nums">
            {activeFile.exists
              ? `${activeFile.sizeBytes} bytes`
              : "文件尚未存在，保存时将自动创建"}
            {dirty && (
              <span className="ml-1.5 font-medium text-amber-700 dark:text-amber-300">
                · 未保存修改
              </span>
            )}
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void refetchRules()}
            >
              刷新
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy || !dirty || activeFile.isSymlinkBlocked}
              onClick={() => void handleSave()}
            >
              <Save className="mr-1.5 h-3.5 w-3.5" />
              {t("projects.rules.save")}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border bg-muted/20 lg:col-span-4">
        <div className="flex items-center justify-between border-b px-3 py-2 text-xs font-medium">
          <span className="flex items-center gap-1.5">
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            {t("projects.rules.snapshots")}
          </span>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {snapshots.length} / 20
          </span>
        </div>

        <ScrollArea className="flex-1 p-2">
          {snapshots.length === 0 ? (
            <div className="py-12 text-center text-xs text-muted-foreground">
              暂无历史快照；每次保存、应用模板或恢复时会自动记录修改前版本。
            </div>
          ) : (
            <div className="space-y-2">
              {snapshots.map((snap) => {
                const actionMeta = getSnapshotActionBadge(snap.action, t);
                return (
                  <div
                    key={snap.id}
                    className="space-y-1.5 rounded-md border bg-background p-2.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${actionMeta.className}`}
                      >
                        {actionMeta.label}
                      </Badge>
                      <span className="text-[11px] tabular-nums text-muted-foreground">
                        {new Date(snap.createdAt * 1000).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-[11px] tabular-nums text-muted-foreground">
                      {snap.fileExisted
                        ? `${t("projects.rules.fileExisted")} · ${t("projects.rules.charCount", { count: snap.content.length })}`
                        : t("projects.rules.fileWasMissing")}
                    </div>
                    <div className="flex items-center gap-1.5 pt-0.5">
                      {snap.fileExisted && (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 px-2 text-xs"
                          disabled={busy || activeFile.isSymlinkBlocked}
                          onClick={() => setDiffSnapshot(snap)}
                        >
                          <FileDiff className="mr-1 h-3 w-3" />
                          {t("projects.rules.diffSnapshot")}
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 flex-1 justify-start px-2 text-xs"
                        disabled={busy || activeFile.isSymlinkBlocked}
                        onClick={() => handleRestoreSnapshotClick(snap)}
                      >
                        <RotateCcw className="mr-1.5 h-3 w-3" />
                        {t("projects.rules.restoreSnapshot")}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </div>

      <ConfirmDialog
        isOpen={Boolean(pendingDeleteSnapshot)}
        title="恢复“文件不存在”的历史快照"
        message={t("projects.rules.confirmDeleteOnRestore", {
          file: activePath,
        })}
        confirmText="确认删除当前文件"
        variant="destructive"
        pending={restoreSnapshotMutation.isPending}
        onConfirm={() => {
          if (pendingDeleteSnapshot) {
            void executeRestoreSnapshot(pendingDeleteSnapshot, true);
          }
        }}
        onCancel={() => setPendingDeleteSnapshot(null)}
      />

      {/* 未保存改动切换拦截弹窗 */}
      <Dialog
        open={Boolean(pendingSwitchPath)}
        onOpenChange={(open) => {
          if (!open) setPendingSwitchPath(null);
        }}
      >
        <DialogContent className="max-w-md" zIndex="nested">
          <DialogHeader>
            <DialogTitle>{t("projects.rules.unsavedTitle")}</DialogTitle>
            <DialogDescription>
              {t("projects.rules.unsavedDescription", { file: activePath })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingSwitchPath(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="border-rose-500/35 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
              onClick={() => {
                if (!pendingSwitchPath) return;
                const next = pendingSwitchPath;
                setPendingSwitchPath(null);
                setDirty(false);
                setActivePath(next);
              }}
            >
              {t("projects.rules.discardAndSwitch")}
            </Button>
            <Button
              type="button"
              disabled={saveMutation.isPending}
              onClick={async () => {
                if (!pendingSwitchPath) return;
                const next = pendingSwitchPath;
                const ok = await handleSave();
                if (ok) {
                  setPendingSwitchPath(null);
                  setActivePath(next);
                }
              }}
            >
              {t("projects.rules.saveAndSwitch")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 覆写 / 插入引用前内容预览弹窗 */}
      <Dialog
        open={Boolean(pendingPreviewAction)}
        onOpenChange={(open) => {
          if (!open) setPendingPreviewAction(null);
        }}
      >
        <DialogContent className="max-w-3xl" zIndex="nested">
          <DialogHeader>
            <DialogTitle>
              {pendingPreviewAction?.kind === "overwrite"
                ? t("projects.rules.overwritePreviewTitle")
                : t("projects.rules.insertAgentsPreviewTitle")}
            </DialogTitle>
            <DialogDescription>
              {pendingPreviewAction?.kind === "overwrite"
                ? t("projects.rules.overwritePreviewDescription", {
                    name: pendingPreviewAction.prompt.name,
                    file: activePath,
                  })
                : t("projects.rules.insertAgentsPreviewDescription")}
            </DialogDescription>
          </DialogHeader>

          {pendingPreviewAction && (
            <div className="grid grid-cols-1 gap-3 px-6 py-2 md:grid-cols-2">
              <div className="flex min-w-0 flex-col rounded-md border">
                <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  {t("projects.rules.currentPreviewLabel")}
                </div>
                <ScrollArea className="h-64 p-3">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                    {(pendingPreviewAction.kind === "overwrite"
                      ? draft
                      : pendingPreviewAction.currentContent) || "(空文件)"}
                  </pre>
                </ScrollArea>
              </div>
              <div className="flex min-w-0 flex-col rounded-md border border-sky-500/30">
                <div className="border-b border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-700 dark:text-sky-300">
                  {t("projects.rules.incomingPreviewLabel")}
                </div>
                <ScrollArea className="h-64 p-3">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                    {pendingPreviewAction.kind === "overwrite"
                      ? pendingPreviewAction.prompt.content
                      : pendingPreviewAction.nextContent}
                  </pre>
                </ScrollArea>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setPendingPreviewAction(null)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                if (pendingPreviewAction?.kind === "overwrite") {
                  void executeApplyPrompt();
                } else {
                  void executeInsertAgentsRef();
                }
              }}
            >
              {t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 快照与当前内容对比弹窗 */}
      <Dialog
        open={Boolean(diffSnapshot)}
        onOpenChange={(open) => {
          if (!open) setDiffSnapshot(null);
        }}
      >
        <DialogContent className="max-w-3xl" zIndex="nested">
          <DialogHeader>
            <DialogTitle>
              {t("projects.rules.snapshotDiffTitle", { file: activePath })}
            </DialogTitle>
            <DialogDescription>
              {diffSnapshot
                ? `${getSnapshotActionBadge(diffSnapshot.action, t).label} · ${new Date(
                    diffSnapshot.createdAt * 1000,
                  ).toLocaleString()}`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {diffSnapshot && (
            <div className="grid grid-cols-1 gap-3 px-6 py-2 md:grid-cols-2">
              <div className="flex min-w-0 flex-col rounded-md border">
                <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  {t("projects.rules.snapshotContentLabel")}
                </div>
                <ScrollArea className="h-72 p-3">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                    {diffSnapshot.content || "(空)"}
                  </pre>
                </ScrollArea>
              </div>
              <div className="flex min-w-0 flex-col rounded-md border">
                <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                  {t("projects.rules.currentDiskLabel")}
                </div>
                <ScrollArea className="h-72 p-3">
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                    {draft || "(空)"}
                  </pre>
                </ScrollArea>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDiffSnapshot(null)}
            >
              {t("common.close")}
            </Button>
            {diffSnapshot && (
              <Button
                type="button"
                variant="outline"
                className="border-amber-500/35 bg-amber-500/10 text-amber-800 hover:bg-amber-500/20 dark:text-amber-300"
                disabled={busy}
                onClick={() => {
                  const target = diffSnapshot;
                  setDiffSnapshot(null);
                  handleRestoreSnapshotClick(target);
                }}
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                {t("projects.rules.restoreSnapshot")}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
