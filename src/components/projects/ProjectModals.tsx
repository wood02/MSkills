import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderOpen, Sparkles, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  projectsApi,
  type ProjectDeployMode,
  type ProjectRecord,
  type ProjectSkillTarget,
  type RemoveProjectPreview,
  type ScannedProjectSkill,
  type SuggestedProject,
} from "@/lib/api/projects";
import {
  useAddProjectMutation,
  useAdoptProjectSkillMutation,
  useRebindProjectDeploymentMutation,
  useRelocateProjectMutation,
  useRemoveProjectMutation,
  useSuggestedProjectsQuery,
  useUpdateProjectMutation,
} from "@/hooks/useProjects";
import { useInstalledSkills } from "@/hooks/useSkills";

/* ─── Add Project Dialog ──────────────────────────────────────────────────── */

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: (project: ProjectRecord) => void;
}

export const AddProjectDialog: React.FC<AddProjectDialogProps> = ({
  open,
  onOpenChange,
  onAdded,
}) => {
  const { t } = useTranslation();
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [defaultMode, setDefaultMode] = useState<ProjectDeployMode>("copy");
  const [targets, setTargets] = useState<ProjectSkillTarget[]>([
    "agents",
    "claude",
  ]);
  const [autoGitExclude, setAutoGitExclude] = useState(true);
  const [reactivateIfArchived, setReactivateIfArchived] = useState(true);

  const addMutation = useAddProjectMutation();
  const { data: suggestions = [], isFetching: loadingSuggestions } =
    useSuggestedProjectsQuery(open);

  useEffect(() => {
    if (!open) return;
    setRootPath("");
    setName("");
    setDefaultMode("copy");
    setTargets(["agents", "claude"]);
    setAutoGitExclude(true);
    setReactivateIfArchived(true);
  }, [open]);

  const handlePickFolder = async () => {
    try {
      const picked = await projectsApi.pickDirectory(rootPath || undefined);
      if (picked) {
        setRootPath(picked);
        if (!name.trim()) {
          const base = picked.split(/[\\/]/).filter(Boolean).pop() ?? "";
          setName(base);
        }
      }
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const applySuggestion = (s: SuggestedProject) => {
    setRootPath(s.rootPath);
    if (!name.trim()) setName(s.name);
  };

  const toggleTarget = (target: ProjectSkillTarget) => {
    setTargets((prev) =>
      prev.includes(target)
        ? prev.filter((item) => item !== target)
        : [...prev, target],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!rootPath.trim()) {
      toast.error("请输入或选择项目根目录");
      return;
    }
    if (targets.length === 0) {
      toast.error("至少勾选一个目标部署目录");
      return;
    }
    try {
      const created = await addMutation.mutateAsync({
        rootPath: rootPath.trim(),
        name: name.trim() || undefined,
        defaultMode,
        enabledTargets: targets,
        autoGitExclude,
        reactivateIfArchived,
      });
      toast.success(`已添加项目「${created.name}」`);
      onAdded?.(created);
      onOpenChange(false);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("projects.addProject")}</DialogTitle>
          <DialogDescription>
            绑定本地代码仓库根目录。路径会自动规范化并与文件系统索引绑定。
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => void handleSubmit(e)}
          className="flex flex-1 min-h-0 flex-col overflow-hidden"
        >
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
            <div className="space-y-1.5">
              <Label>项目根目录</Label>
              <div className="flex min-w-0 gap-2">
                <Input
                  className="min-w-0 flex-1"
                  value={rootPath}
                  onChange={(e) => setRootPath(e.target.value)}
                  placeholder="/Users/you/workspace/my-app"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => void handlePickFolder()}
                >
                  <FolderOpen className="mr-1.5 h-4 w-4" />
                  {t("projects.browseDirectory")}
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>项目显示名称（可选）</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="默认取目录名"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>默认部署模式</Label>
                <Select
                  value={defaultMode}
                  onValueChange={(v) => setDefaultMode(v as ProjectDeployMode)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="copy">拷贝 (Copy)</SelectItem>
                    <SelectItem value="symlink">软链 (Symlink)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label>扫描与部署目标</Label>
                <div className="space-y-1 rounded-md border p-2 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={targets.includes("agents")}
                      onCheckedChange={() => toggleTarget("agents")}
                    />
                    <span>.agents/skills</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Checkbox
                      checked={targets.includes("claude")}
                      onCheckedChange={() => toggleTarget("claude")}
                    />
                    <span>.claude/skills</span>
                  </label>
                </div>
              </div>
            </div>

            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Checkbox
                checked={autoGitExclude}
                onCheckedChange={(v) => setAutoGitExclude(Boolean(v))}
              />
              <span>
                使用软链部署时，自动将软链路径写入本地 `.git/info/exclude`
              </span>
            </label>

            {suggestions.length > 0 && (
              <div className="space-y-1.5 rounded-md border bg-muted/30 p-2.5">
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                  <span>{t("projects.suggestFromSessions")}</span>
                  {loadingSuggestions && (
                    <span className="ml-auto">扫描中…</span>
                  )}
                </div>
                <div className="max-h-32 space-y-1 overflow-y-auto">
                  {suggestions.map((s) => (
                    <button
                      key={s.rootPath}
                      type="button"
                      onClick={() => applySuggestion(s)}
                      className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-muted"
                    >
                      <div className="min-w-0 pr-2">
                        <div className="truncate font-medium">{s.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {s.rootPath}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {s.hasExistingSkills && (
                          <Badge variant="secondary" className="text-[10px]">
                            含现有 Skills
                          </Badge>
                        )}
                        <Badge variant="outline" className="text-[10px]">
                          {s.sessionCount} 会话
                        </Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={addMutation.isPending}>
              {addMutation.isPending ? "添加中..." : t("projects.addProject")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

/* ─── Project Settings Dialog ─────────────────────────────────────────────── */

interface ProjectSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectRecord | null;
}

export const ProjectSettingsDialog: React.FC<ProjectSettingsDialogProps> = ({
  open,
  onOpenChange,
  project,
}) => {
  const { t } = useTranslation();
  const updateMutation = useUpdateProjectMutation();
  const [name, setName] = useState("");
  const [defaultMode, setDefaultMode] = useState<ProjectDeployMode>("copy");
  const [targets, setTargets] = useState<ProjectSkillTarget[]>(["agents"]);
  const [autoGitExclude, setAutoGitExclude] = useState(true);
  const [archived, setArchived] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    setName(project.name);
    setDefaultMode(project.defaultMode);
    setTargets(project.enabledTargets);
    setAutoGitExclude(project.autoGitExclude);
    setArchived(Boolean(project.archivedAt));
  }, [open, project]);

  const toggleTarget = (target: ProjectSkillTarget) => {
    setTargets((prev) =>
      prev.includes(target)
        ? prev.filter((item) => item !== target)
        : [...prev, target],
    );
  };

  const handleSave = async () => {
    if (!project) return;
    if (targets.length === 0) {
      toast.error("至少保留一个部署目标");
      return;
    }
    try {
      await updateMutation.mutateAsync({
        id: project.id,
        name: name.trim() || project.name,
        defaultMode,
        enabledTargets: targets,
        autoGitExclude,
        archived,
      });
      toast.success("项目设置已保存");
      onOpenChange(false);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("projects.projectSettings")}</DialogTitle>
          <DialogDescription className="break-all font-mono text-xs">
            {project?.rootPath}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          <div className="space-y-1.5">
            <Label>项目名称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="space-y-1.5">
            <Label>默认部署模式</Label>
            <Select
              value={defaultMode}
              onValueChange={(v) => setDefaultMode(v as ProjectDeployMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="copy">拷贝 (Copy)</SelectItem>
                <SelectItem value="symlink">软链 (Symlink)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>启用目录目标</Label>
            <div className="space-y-1 rounded-md border p-2.5 text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={targets.includes("agents")}
                  onCheckedChange={() => toggleTarget("agents")}
                />
                <span>{t("projects.targetAgents")}</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={targets.includes("claude")}
                  onCheckedChange={() => toggleTarget("claude")}
                />
                <span>{t("projects.targetClaude")}</span>
              </label>
            </div>
          </div>

          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <Checkbox
              checked={autoGitExclude}
              onCheckedChange={(v) => setAutoGitExclude(Boolean(v))}
            />
            <span>自动维护 Git `.git/info/exclude`</span>
          </label>

          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <Checkbox
              checked={archived}
              onCheckedChange={(v) => setArchived(Boolean(v))}
            />
            <span>归档项目（从活跃列表折叠隐藏）</span>
          </label>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={updateMutation.isPending}
            onClick={() => void handleSave()}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ─── Relocate Project Dialog ─────────────────────────────────────────────── */

interface RelocateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectRecord | null;
}

export const RelocateProjectDialog: React.FC<RelocateProjectDialogProps> = ({
  open,
  onOpenChange,
  project,
}) => {
  const { t } = useTranslation();
  const relocateMutation = useRelocateProjectMutation();
  const [newPath, setNewPath] = useState("");

  useEffect(() => {
    if (open && project) setNewPath(project.rootPath);
  }, [open, project]);

  const handleBrowse = async () => {
    const picked = await projectsApi.pickDirectory(newPath || undefined);
    if (picked) setNewPath(picked);
  };

  const handleSubmit = async () => {
    if (!project || !newPath.trim()) return;
    try {
      await relocateMutation.mutateAsync({
        projectId: project.id,
        newRootPath: newPath.trim(),
      });
      toast.success("已更新项目根目录并刷新文件系统索引");
      onOpenChange(false);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle>{t("projects.relocateProject")}</DialogTitle>
          <DialogDescription className="break-words">
            若项目目录被移动、重命名或重建，请重新指定目录。确定后将同步更新目录索引，绝不越过未确认目录写入文件。
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 py-4">
          <div className="flex min-w-0 gap-2">
            <Input
              className="min-w-0 flex-1"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder="/path/to/repo"
            />
            <Button
              type="button"
              variant="outline"
              className="shrink-0"
              onClick={() => void handleBrowse()}
            >
              浏览…
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={relocateMutation.isPending}
            onClick={() => void handleSubmit()}
          >
            确认重定位
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ─── Remove Project Dialog ───────────────────────────────────────────────── */

interface RemoveProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: ProjectRecord | null;
  onRemoved?: (projectId: string) => void;
}

export const RemoveProjectDialog: React.FC<RemoveProjectDialogProps> = ({
  open,
  onOpenChange,
  project,
  onRemoved,
}) => {
  const { t } = useTranslation();
  const removeMutation = useRemoveProjectMutation();
  const [preview, setPreview] = useState<RemoveProjectPreview | null>(null);
  const [cleanupLinks, setCleanupLinks] = useState(true);
  const [deleteCleanCopies, setDeleteCleanCopies] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    setPreview(null);
    setCleanupLinks(true);
    setDeleteCleanCopies(false);
    projectsApi
      .previewRemove(project.id)
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [open, project]);

  const handleConfirm = async () => {
    if (!project) return;
    try {
      const res = await removeMutation.mutateAsync({
        projectId: project.id,
        options: {
          cleanupLinks,
          deleteUnmodifiedCopies: deleteCleanCopies,
        },
      });
      toast.success(`已取消纳管「${project.name}」`, {
        description: `清理链接 ${res.removedLinksCount} 项；删除未修改副本 ${res.deletedCleanCopiesCount} 项；保留本地目录 ${res.preservedCopiesCount} 项`,
      });
      onRemoved?.(project.id);
      onOpenChange(false);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{t("projects.removeProject")}</span>
          </DialogTitle>
          <DialogDescription className="break-words">
            从 MSkills 移除对「{project?.name}
            」的管理与规则快照。默认不会删除项目中的手写 Copy 文件或
            CLAUDE.md/AGENTS.md。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          {preview && (
            <div className="space-y-2 rounded-md border bg-muted/40 p-3 text-xs">
              <div>托管软链 / 别名：{preview.managedLinksCount} 个</div>
              <div>未修改的可清理 Copy 副本：{preview.cleanCopiesCount} 个</div>
              <div>
                已本地修改或 Adopt 纳管的目录：
                {preview.modifiedOrAdoptedCopiesCount} 个（始终保留）
              </div>
              <div>
                Rules 历史快照：{preview.ruleSnapshotsCount} 条（将清空）
              </div>
            </div>
          )}

          <div className="space-y-2 text-xs">
            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox
                className="mt-0.5"
                checked={cleanupLinks}
                onCheckedChange={(v) => setCleanupLinks(Boolean(v))}
              />
              <span>
                拆除 MSkills 管理的软链/跨端别名并清理 `.git/info/exclude`
                托管块
              </span>
            </label>
            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox
                className="mt-0.5"
                checked={deleteCleanCopies}
                onCheckedChange={(v) => setDeleteCleanCopies(Boolean(v))}
              />
              <span>
                同时删除未修改且可验证由本工具写入的 Copy
                副本（已改写目录不受影响）
              </span>
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={removeMutation.isPending}
            onClick={() => void handleConfirm()}
          >
            确认取消纳管
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/* ─── Adopt or Rebind Dialog ──────────────────────────────────────────────── */

interface AdoptOrRebindDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  mode: "adopt" | "rebind";
  skill: ScannedProjectSkill | null;
}

export const AdoptOrRebindDialog: React.FC<AdoptOrRebindDialogProps> = ({
  open,
  onOpenChange,
  projectId,
  mode,
  skill,
}) => {
  const { t } = useTranslation();
  const { data: installedSkills = [] } = useInstalledSkills();
  const adoptMutation = useAdoptProjectSkillMutation();
  const rebindMutation = useRebindProjectDeploymentMutation();
  const [selectedSkillId, setSelectedSkillId] = useState("");

  useEffect(() => {
    if (!open || !skill) return;
    setSelectedSkillId(
      skill.canRebindSkillId || skill.skillId || installedSkills[0]?.id || "",
    );
  }, [open, skill, installedSkills]);

  const handleSubmit = async () => {
    if (!skill || !selectedSkillId) return;
    try {
      if (mode === "adopt") {
        await adoptMutation.mutateAsync({
          projectId,
          target: skill.target,
          directory: skill.directory,
          skillId: selectedSkillId,
        });
        toast.success("已纳管到项目部署记录（未修改磁盘文件）");
      } else {
        await rebindMutation.mutateAsync({
          projectId,
          target: skill.target,
          directory: skill.directory,
          skillId: selectedSkillId,
        });
        toast.success("已重新关联全局 Skill 源");
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden">
        <DialogHeader>
          <DialogTitle>
            {mode === "adopt" ? "纳管现有项目目录" : "重新关联全局源"}
          </DialogTitle>
          <DialogDescription className="break-words">
            {mode === "adopt"
              ? `仅将 ${skill?.target}/${skill?.directory} 绑定到指定全局 Skill 记录；若两者内容不同，绑定后将标记为“无基准差异”，不会覆盖磁盘文件。`
              : `为 ${skill?.target}/${skill?.directory} 选择新的全局 Skill 源以恢复版本追踪。`}
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 py-4">
          <Select value={selectedSkillId} onValueChange={setSelectedSkillId}>
            <SelectTrigger className="w-full min-w-0">
              <SelectValue placeholder="选择全局 Skill" />
            </SelectTrigger>
            <SelectContent>
              {installedSkills.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name} ({item.directory})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={
              !selectedSkillId ||
              adoptMutation.isPending ||
              rebindMutation.isPending
            }
            onClick={() => void handleSubmit()}
          >
            确认
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
