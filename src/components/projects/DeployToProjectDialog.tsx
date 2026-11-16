import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { FolderGit2, Layers, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { useInstalledSkills } from "@/hooks/useSkills";
import { useSkillGroupsQuery } from "@/lib/query/skillGroups";
import {
  useDeploySkillGroupToProjectMutation,
  useDeploySkillsToProjectMutation,
  useProjectsQuery,
} from "@/hooks/useProjects";
import type { ProjectDeployMode, ProjectSkillTarget } from "@/lib/api/projects";

interface DeployToProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 预设目标项目（从 ProjectsPage 打开时传入；从全局 Skills 页打开时可不传以选择项目） */
  initialProjectId?: string | null;
  /** 预设选中的全局 Skill ID 列表 */
  initialSkillIds?: string[];
  /** 是否默认切到“按技能组部署”页签 */
  initialTab?: "skills" | "group";
}

export const DeployToProjectDialog: React.FC<DeployToProjectDialogProps> = ({
  open,
  onOpenChange,
  initialProjectId,
  initialSkillIds,
  initialTab = "skills",
}) => {
  const { t } = useTranslation();
  const { data: projects = [] } = useProjectsQuery(false);
  const { data: installedSkills = [] } = useInstalledSkills();
  const { data: skillGroups = [] } = useSkillGroupsQuery();

  const deploySkillsMutation = useDeploySkillsToProjectMutation();
  const deployGroupMutation = useDeploySkillGroupToProjectMutation();

  const [sourceTab, setSourceTab] = useState<"skills" | "group">(initialTab);
  const [projectId, setProjectId] = useState<string>("");
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");
  const [targets, setTargets] = useState<ProjectSkillTarget[]>(["agents"]);
  const [mode, setMode] = useState<ProjectDeployMode>("copy");
  const [overwriteConflicts, setOverwriteConflicts] = useState(false);

  const selectedProject = useMemo(
    () => projects.find((p) => p.project.id === projectId)?.project ?? null,
    [projects, projectId],
  );

  useEffect(() => {
    if (!open) return;
    setSourceTab(initialTab);
    const resolvedProjId = initialProjectId || projects[0]?.project.id || "";
    setProjectId(resolvedProjId);
    const matched = projects.find(
      (p) => p.project.id === resolvedProjId,
    )?.project;
    if (matched) {
      setTargets(
        matched.enabledTargets.length > 0 ? matched.enabledTargets : ["agents"],
      );
      setMode(matched.defaultMode || "copy");
    }
    setSelectedSkillIds(new Set(initialSkillIds ?? []));
    setSelectedGroupId(skillGroups[0]?.id ?? "");
    setOverwriteConflicts(false);
  }, [
    open,
    initialProjectId,
    initialSkillIds,
    initialTab,
    projects,
    skillGroups,
  ]);

  const handleProjectChange = (nextId: string) => {
    setProjectId(nextId);
    const matched = projects.find((p) => p.project.id === nextId)?.project;
    if (matched) {
      setTargets(
        matched.enabledTargets.length > 0 ? matched.enabledTargets : ["agents"],
      );
      setMode(matched.defaultMode || "copy");
    }
  };

  const toggleTarget = (target: ProjectSkillTarget) => {
    setTargets((prev) =>
      prev.includes(target)
        ? prev.filter((item) => item !== target)
        : [...prev, target],
    );
  };

  const toggleSkill = (id: string) => {
    setSelectedSkillIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const isPending =
    deploySkillsMutation.isPending || deployGroupMutation.isPending;

  const handleSubmit = async () => {
    if (!projectId) {
      toast.error("请先选择一个项目");
      return;
    }
    if (targets.length === 0) {
      toast.error("至少选择一个部署目录（.agents/skills 或 .claude/skills）");
      return;
    }

    try {
      if (sourceTab === "skills") {
        const ids = Array.from(selectedSkillIds);
        if (ids.length === 0) {
          toast.error("请至少选择一个全局 Skill");
          return;
        }
        const res = await deploySkillsMutation.mutateAsync({
          projectId,
          skillIds: ids,
          targets,
          modeOverride: mode,
          overwriteConflicts,
        });
        const detailLines = [
          res.deployed.length > 0 ? `已部署 ${res.deployed.length} 项` : "",
          res.skipped.length > 0 ? `跳过: ${res.skipped.join("；")}` : "",
          res.warnings.length > 0 ? `警告: ${res.warnings.join("；")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        if (res.warnings.length > 0) {
          toast.warning("部署完成（含提示）", { description: detailLines });
        } else {
          toast.success("部署完成", {
            description: detailLines || "已写入项目目录",
          });
        }
      } else {
        if (!selectedGroupId) {
          toast.error("请先选择一个技能组");
          return;
        }
        const res = await deployGroupMutation.mutateAsync({
          projectId,
          groupId: selectedGroupId,
          targets,
          modeOverride: mode,
          overwriteConflicts,
        });
        const detailLines = [
          res.deployed.length > 0 ? `已部署 ${res.deployed.length} 项` : "",
          res.missingFromLibrary.length > 0
            ? `全局库已缺失 ${res.missingFromLibrary.length} 项: ${res.missingFromLibrary.join(", ")}`
            : "",
          res.skipped.length > 0 ? `跳过: ${res.skipped.join("；")}` : "",
          res.warnings.length > 0 ? `警告: ${res.warnings.join("；")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        if (res.missingFromLibrary.length > 0 || res.warnings.length > 0) {
          toast.warning("按技能组部署完成（含提醒）", {
            description: detailLines,
          });
        } else {
          toast.success("按技能组部署完成", {
            description: detailLines || "已写入项目目录",
          });
        }
      }
      onOpenChange(false);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-hidden" zIndex="nested">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderGit2 className="h-4 w-4 shrink-0 text-primary" />
            <span>{t("projects.deploySkill")}</span>
          </DialogTitle>
          <DialogDescription>
            把全局技能写入项目目录。仅使用 Claude Code 时只勾选 「Claude
            (.claude/skills)」即可；同时勾选两项并选「拷贝」时，Claude
            目录会自动引用 .agents，避免同一份文件维护两份。
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4 space-y-4">
          <div className="space-y-1.5">
            <Label>目标项目</Label>
            {projects.length === 0 ? (
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                暂无已添加的项目，请先在「项目」工作区中添加项目根目录。
              </div>
            ) : (
              <Select value={projectId} onValueChange={handleProjectChange}>
                <SelectTrigger className="w-full min-w-0 overflow-hidden [&>span]:truncate">
                  <SelectValue placeholder="选择目标项目" />
                </SelectTrigger>
                <SelectContent className="max-w-[calc(var(--radix-select-trigger-width,32rem))]">
                  {projects.map((item) => (
                    <SelectItem key={item.project.id} value={item.project.id}>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 font-medium">
                          {item.project.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {item.project.rootPath}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>部署目标目录</Label>
              <div className="space-y-1.5 rounded-md border p-2.5 text-xs">
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

            <div className="space-y-2">
              <Label>分发模式</Label>
              <Select
                value={mode}
                onValueChange={(v) => setMode(v as ProjectDeployMode)}
              >
                <SelectTrigger className="w-full min-w-0 overflow-hidden [&>span]:truncate">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="copy">拷贝（独立副本）</SelectItem>
                  <SelectItem value="symlink">软链（直连全局）</SelectItem>
                </SelectContent>
              </Select>
              {mode === "symlink" && selectedProject && (
                <p className="text-[11px] text-muted-foreground">
                  {selectedProject.autoGitExclude
                    ? "已开启自动维护 Git .git/info/exclude"
                    : "需项目 .gitignore 已忽略该路径"}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2 border-b pb-2">
              <Button
                type="button"
                size="sm"
                variant={sourceTab === "skills" ? "default" : "ghost"}
                onClick={() => setSourceTab("skills")}
              >
                自选 Skills ({selectedSkillIds.size})
              </Button>
              <Button
                type="button"
                size="sm"
                variant={sourceTab === "group" ? "default" : "ghost"}
                onClick={() => setSourceTab("group")}
              >
                <Layers className="mr-1 h-3.5 w-3.5" />
                {t("projects.deployGroup")}
              </Button>
            </div>

            {sourceTab === "skills" ? (
              <ScrollArea className="h-52 rounded-md border p-2">
                {installedSkills.length === 0 ? (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    全局库中暂无已安装 Skills
                  </p>
                ) : (
                  <div className="space-y-1">
                    {installedSkills.map((skill) => {
                      const checked = selectedSkillIds.has(skill.id);
                      return (
                        <button
                          key={skill.id}
                          type="button"
                          onClick={() => toggleSkill(skill.id)}
                          className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs hover:bg-muted/70"
                        >
                          <div className="min-w-0 pr-2">
                            <div className="truncate font-medium text-foreground">
                              {skill.name}
                            </div>
                            <div className="truncate text-[11px] text-muted-foreground">
                              {skill.directory}
                            </div>
                          </div>
                          <div
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                              checked
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-muted-foreground/40"
                            }`}
                          >
                            {checked && <Check className="h-3 w-3" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
            ) : (
              <div className="space-y-2 pt-1">
                {skillGroups.length === 0 ? (
                  <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                    暂无全局技能组，请先在 Skills 页面创建技能组
                  </p>
                ) : (
                  <Select
                    value={selectedGroupId}
                    onValueChange={setSelectedGroupId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="选择一个技能组" />
                    </SelectTrigger>
                    <SelectContent>
                      {skillGroups.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          <span>{g.name}</span>
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            {g.skills.length} Skills
                          </Badge>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox
              checked={overwriteConflicts}
              onCheckedChange={(v) => setOverwriteConflicts(Boolean(v))}
            />
            <span>若目标路径已存在同名 Skill，直接以全局最新版本覆盖替换</span>
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
            disabled={isPending || projects.length === 0}
            onClick={() => void handleSubmit()}
          >
            {isPending ? "部署中..." : "开始部署"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
