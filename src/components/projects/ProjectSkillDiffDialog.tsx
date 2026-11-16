import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, ArrowRight, FileDiff, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  projectsApi,
  type ProjectSkillDiffResult,
  type ScannedProjectSkill,
} from "@/lib/api/projects";
import {
  usePushSkillToGlobalMutation,
  useUpdateProjectDeploymentsMutation,
} from "@/hooks/useProjects";

interface ProjectSkillDiffDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  skill: ScannedProjectSkill | null;
}

const CHANGE_BADGE_MAP: Record<string, string> = {
  added:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  removed: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
  modified:
    "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  unchanged: "border-border text-muted-foreground",
};

export const ProjectSkillDiffDialog: React.FC<ProjectSkillDiffDialogProps> = ({
  open,
  onOpenChange,
  projectId,
  skill,
}) => {
  const { t } = useTranslation();
  const [diff, setDiff] = useState<ProjectSkillDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string>("");

  const updateMutation = useUpdateProjectDeploymentsMutation();
  const pushMutation = usePushSkillToGlobalMutation();

  useEffect(() => {
    if (!open || !skill) return;
    let active = true;
    setLoading(true);
    setDiff(null);
    projectsApi
      .diffSkill({
        projectId,
        target: skill.target,
        directory: skill.directory,
      })
      .then((res) => {
        if (!active) return;
        setDiff(res);
        const firstChanged =
          res.files.find((f) => f.changeType !== "unchanged") ?? res.files[0];
        setSelectedFile(firstChanged?.relativePath ?? "");
      })
      .catch((error) => {
        if (!active) return;
        toast.error(t("common.error"), { description: String(error) });
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [open, projectId, skill, t]);

  const activeFileDiff = diff?.files.find(
    (f) => f.relativePath === selectedFile,
  );

  const handleUseGlobal = async () => {
    if (!skill) return;
    try {
      await updateMutation.mutateAsync({
        projectId,
        items: [{ target: skill.target, directory: skill.directory }],
        allowOverwriteModified: true,
      });
      toast.success("已用全局版本覆盖项目副本");
      onOpenChange(false);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleUseProject = async () => {
    if (!skill) return;
    try {
      await pushMutation.mutateAsync({
        projectId,
        target: skill.target,
        directory: skill.directory,
        overwriteExisting: true,
      });
      toast.success("已用项目版本覆盖全局 SSOT");
      onOpenChange(false);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const resolving = updateMutation.isPending || pushMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl overflow-hidden" zIndex="nested">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2">
            <FileDiff className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">
              差异对比：{skill?.target}/{skill?.directory}
            </span>
          </DialogTitle>
          <DialogDescription>
            左侧为项目本地目录，右侧为全局 SSOT
            主库。可查看逐文件差异并选择保留哪一侧。
          </DialogDescription>
          {skill?.unknownBaseline && (
            <div className="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300">
              {t("projects.diffDialog.unknownBaselineHint")}
            </div>
          )}
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              正在生成差异对比...
            </div>
          ) : diff ? (
            <div className="grid h-[420px] grid-cols-12 gap-3">
              <ScrollArea className="col-span-4 rounded-md border p-2">
                <div className="space-y-1">
                  {diff.files.map((f) => (
                    <button
                      key={f.relativePath}
                      type="button"
                      onClick={() => setSelectedFile(f.relativePath)}
                      className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs ${
                        selectedFile === f.relativePath
                          ? "bg-accent font-medium text-accent-foreground"
                          : "hover:bg-muted/60"
                      }`}
                    >
                      <span className="truncate font-mono">
                        {f.relativePath}
                      </span>
                      <Badge
                        variant="outline"
                        className={`shrink-0 px-1.5 py-0 text-[10px] ${
                          CHANGE_BADGE_MAP[f.changeType] ?? ""
                        }`}
                      >
                        {f.changeType}
                      </Badge>
                    </button>
                  ))}
                </div>
              </ScrollArea>

              <div className="col-span-8 flex flex-col overflow-hidden rounded-md border">
                {!activeFileDiff ? (
                  <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                    选择左侧文件以查看内容
                  </div>
                ) : activeFileDiff.isBinary ? (
                  <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                    二进制文件（{activeFileDiff.changeType}），不支持文本预览
                  </div>
                ) : (
                  <div className="grid flex-1 grid-cols-2 divide-x overflow-hidden">
                    <div className="flex flex-col overflow-hidden">
                      <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium">
                        项目目录（Project）
                      </div>
                      <ScrollArea className="flex-1 p-3">
                        <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
                          {activeFileDiff.projectContent ?? "（不存在）"}
                        </pre>
                      </ScrollArea>
                    </div>
                    <div className="flex flex-col overflow-hidden">
                      <div className="border-b bg-muted/40 px-3 py-1.5 text-xs font-medium">
                        全局 SSOT（Global）
                      </div>
                      <ScrollArea className="flex-1 p-3">
                        <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
                          {activeFileDiff.globalContent ?? "（不存在）"}
                        </pre>
                      </ScrollArea>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="py-12 text-center text-xs text-muted-foreground">
              暂无可比较的差异数据
            </div>
          )}
        </div>

        <DialogFooter className="flex-wrap justify-between gap-2 sm:justify-between">
          <div className="flex items-center gap-2">
            {skill && !skill.isSymlink && skill.skillId && (
              <>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="border-sky-500/30 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
                  disabled={resolving || skill.status === "source_missing"}
                  onClick={() => void handleUseGlobal()}
                >
                  <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                  {t("projects.actions.updateFromGlobal")}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="border-amber-500/30 bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
                  disabled={resolving || !skill.diskExists}
                  onClick={() => void handleUseProject()}
                >
                  {t("projects.actions.overwriteGlobal")}
                  <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
