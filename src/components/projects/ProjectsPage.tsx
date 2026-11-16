import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Download,
  FileDiff,
  FolderGit2,
  FolderPlus,
  GitBranch,
  Layers,
  Link2,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ClaudeIcon } from "@/components/BrandIcons";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  type ProjectDeployMode,
  type ProjectListItem,
  type ProjectSkillStatus,
  type ProjectSkillTarget,
  type ScannedProjectSkill,
} from "@/lib/api/projects";
import type { InstalledSkill } from "@/lib/api/skills";
import type { SkillGroup } from "@/lib/api/skillGroups";
import { useInstalledSkills } from "@/hooks/useSkills";
import { useSkillGroupsQuery } from "@/lib/query/skillGroups";
import {
  useBatchUndeployProjectSkillsMutation,
  useDeploySkillGroupToProjectMutation,
  useDeploySkillsToProjectMutation,
  useImportProjectSkillsMutation,
  useProjectsQuery,
  useProjectScanQuery,
  usePromoteClaudeDeploymentMutation,
  usePushSkillToGlobalMutation,
  useRebindProjectDeploymentMutation,
  useSettleMissingProjectLinkMutation,
  useUndeployProjectSkillMutation,
  useUpdateProjectDeploymentsMutation,
  useUpdateProjectMutation,
} from "@/hooks/useProjects";
import { ProjectSkillDiffDialog } from "./ProjectSkillDiffDialog";
import { ProjectRulesPanel } from "./ProjectRulesPanel";
import {
  AddProjectDialog,
  AdoptOrRebindDialog,
  ProjectSettingsDialog,
  RelocateProjectDialog,
  RemoveProjectDialog,
} from "./ProjectModals";

type StatusFilter = "all" | "deployed" | "attention" | "unmanaged";
type DetailTab = "skills" | "rules";

interface UnifiedProjectSkillRow {
  key: string;
  directory: string;
  displayName: string;
  description?: string;
  skill?: InstalledSkill;
  agentsEntry?: ScannedProjectSkill;
  claudeEntry?: ScannedProjectSkill;
}

function getProjectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "PJ";
  const segments = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (segments.length >= 2) {
    return `${segments[0][0] ?? ""}${segments[1][0] ?? ""}`.toUpperCase();
  }
  return Array.from(trimmed).slice(0, 2).join("").toUpperCase();
}

function getStatusBadgeStyle(status: ProjectSkillStatus): {
  labelKey: string;
  className: string;
} {
  switch (status) {
    case "synced":
      return {
        labelKey: "projects.status.synced",
        className:
          "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      };
    case "outdated":
      return {
        labelKey: "projects.status.outdated",
        className:
          "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
    case "modified":
      return {
        labelKey: "projects.status.modified",
        className:
          "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      };
    case "conflict":
      return {
        labelKey: "projects.status.conflict",
        className:
          "border-amber-500/45 bg-amber-500/15 text-amber-800 dark:text-amber-300",
      };
    case "broken":
      return {
        labelKey: "projects.status.broken",
        className:
          "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      };
    case "invalid_structure":
      return {
        labelKey: "projects.status.invalidStructure",
        className:
          "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      };
    case "source_missing":
      return {
        labelKey: "projects.status.sourceMissing",
        className:
          "border-rose-500/35 bg-rose-500/10 text-rose-700 dark:text-rose-300",
      };
    case "same_content_unmanaged":
      return {
        labelKey: "projects.status.sameContentUnmanaged",
        className:
          "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
      };
    case "unmanaged":
    default:
      return {
        labelKey: "projects.status.unmanaged",
        className:
          "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300",
      };
  }
}

function getTargetToggleClass({
  isEnabled,
  isDetached,
  hasError,
  hasWarning,
  isUnmanaged,
  isClaude,
}: {
  isEnabled: boolean;
  isDetached: boolean;
  hasError: boolean;
  hasWarning: boolean;
  isUnmanaged: boolean;
  isClaude: boolean;
}): string {
  if (!isEnabled) {
    return "border-border/80 bg-muted/25 text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground";
  }
  if (isDetached) {
    return "border-dashed border-border bg-muted/60 text-muted-foreground hover:bg-muted";
  }
  if (hasError) {
    return "border-rose-500/40 bg-rose-500/10 font-semibold text-rose-700 hover:bg-rose-500/20 dark:text-rose-300";
  }
  if (hasWarning) {
    return "border-amber-500/40 bg-amber-500/10 font-semibold text-amber-700 hover:bg-amber-500/20 dark:text-amber-300";
  }
  if (isUnmanaged) {
    return "border-violet-500/35 bg-violet-500/10 font-semibold text-violet-700 hover:bg-violet-500/20 dark:text-violet-300";
  }
  if (isClaude) {
    return "border-orange-500/35 bg-orange-500/10 font-semibold text-orange-700 hover:bg-orange-500/20 dark:text-orange-300";
  }
  return "border-sky-500/35 bg-sky-500/10 font-semibold text-sky-700 hover:bg-sky-500/20 dark:text-sky-300";
}

export const ProjectsPage: React.FC = () => {
  const { t } = useTranslation();

  const [includeArchived, setIncludeArchived] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  const [activeTab, setActiveTab] = useState<DetailTab>("skills");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [groupPopoverOpen, setGroupPopoverOpen] = useState(false);
  const [pendingToggleKey, setPendingToggleKey] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [relocateOpen, setRelocateOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [diffSkill, setDiffSkill] = useState<ScannedProjectSkill | null>(null);
  const [adoptOrRebind, setAdoptOrRebind] = useState<{
    mode: "adopt" | "rebind";
    skill: ScannedProjectSkill;
  } | null>(null);
  const [undeployConfirm, setUndeployConfirm] =
    useState<ScannedProjectSkill | null>(null);
  const [claudeWarningsExpanded, setClaudeWarningsExpanded] = useState(false);
  const [detachedDialog, setDetachedDialog] = useState<{
    row: UnifiedProjectSkillRow;
    target: ProjectSkillTarget;
    entry: ScannedProjectSkill;
  } | null>(null);
  const [aliasRemoveDialog, setAliasRemoveDialog] = useState<{
    row: UnifiedProjectSkillRow;
    agentsEntry: ScannedProjectSkill;
    claudeEntry: ScannedProjectSkill;
  } | null>(null);
  const [modeSwitchConfirm, setModeSwitchConfirm] = useState<{
    targetMode: ProjectDeployMode;
    convertibleGroups: Array<{
      targets: ProjectSkillTarget[];
      skillIds: string[];
    }>;
    convertibleCount: number;
    skippedModifiedCount: number;
  } | null>(null);
  const [convertingMode, setConvertingMode] = useState(false);

  useEffect(() => {
    setClaudeWarningsExpanded(false);
    setModeSwitchConfirm(null);
  }, [selectedProjectId]);

  const {
    data: projects = [],
    isLoading: loadingProjects,
    refetch: refetchProjects,
  } = useProjectsQuery(includeArchived);
  const { data: installedSkills = [] } = useInstalledSkills();
  const { data: skillGroups = [] } = useSkillGroupsQuery();

  useEffect(() => {
    if (projects.length === 0) {
      setSelectedProjectId(null);
      return;
    }
    const stillExists = projects.some(
      (item) => item.project.id === selectedProjectId,
    );
    if (!stillExists) {
      setSelectedProjectId(projects[0].project.id);
    }
  }, [projects, selectedProjectId]);

  const activeListItem: ProjectListItem | null = useMemo(
    () => projects.find((p) => p.project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const activeProject = activeListItem?.project ?? null;

  const {
    data: scanResult,
    isFetching: scanning,
    refetch: refetchScan,
  } = useProjectScanQuery(selectedProjectId);

  const deployMutation = useDeploySkillsToProjectMutation();
  const deployGroupMutation = useDeploySkillGroupToProjectMutation();
  const batchUndeployMutation = useBatchUndeployProjectSkillsMutation();
  const updateProjectMutation = useUpdateProjectMutation();
  const updateDeploymentsMutation = useUpdateProjectDeploymentsMutation();
  const promoteMutation = usePromoteClaudeDeploymentMutation();
  const undeployMutation = useUndeployProjectSkillMutation();
  const settleMissingMutation = useSettleMissingProjectLinkMutation();
  const pushGlobalMutation = usePushSkillToGlobalMutation();
  const importGlobalMutation = useImportProjectSkillsMutation();
  const rebindMutation = useRebindProjectDeploymentMutation();

  const entries = scanResult?.entries ?? [];

  const unifiedRows = useMemo<UnifiedProjectSkillRow[]>(() => {
    const byKey = new Map<string, UnifiedProjectSkillRow>();
    const dirToGlobalId = new Map<string, string>();

    for (const skill of installedSkills) {
      dirToGlobalId.set(skill.directory, skill.id);
      byKey.set(skill.id, {
        key: skill.id,
        directory: skill.directory,
        displayName: skill.name,
        description: skill.description,
        skill,
      });
    }

    for (const entry of entries) {
      const matchedId =
        (entry.skillId && byKey.has(entry.skillId)
          ? entry.skillId
          : undefined) ?? dirToGlobalId.get(entry.directory);
      const rowKey = matchedId ?? `local:${entry.directory}`;
      const existing: UnifiedProjectSkillRow = byKey.get(rowKey) ?? {
        key: rowKey,
        directory: entry.directory,
        displayName: entry.displayName || entry.directory,
        description: entry.description ?? undefined,
      };
      if (entry.target === "agents") {
        existing.agentsEntry = entry;
      } else if (entry.target === "claude") {
        existing.claudeEntry = entry;
      }
      if (!existing.description && entry.description) {
        existing.description = entry.description;
      }
      byKey.set(rowKey, existing);
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const aActive = Boolean(a.agentsEntry || a.claudeEntry);
      const bActive = Boolean(b.agentsEntry || b.claudeEntry);
      if (aActive !== bActive) return aActive ? -1 : 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [installedSkills, entries]);

  const rowHasAttention = (row: UnifiedProjectSkillRow) =>
    [row.agentsEntry, row.claudeEntry].some(
      (e) =>
        e &&
        (Boolean(e.detachedAt) ||
          e.status === "outdated" ||
          e.status === "modified" ||
          e.status === "conflict" ||
          e.status === "broken" ||
          e.status === "invalid_structure" ||
          e.status === "source_missing"),
    );

  const claudePrecedenceRows = useMemo(
    () =>
      unifiedRows.filter(
        (row) =>
          (row.claudeEntry?.diagnostics.precedenceWarnings.length ?? 0) > 0,
      ),
    [unifiedRows],
  );

  const rowHasUnmanaged = (row: UnifiedProjectSkillRow) =>
    [row.agentsEntry, row.claudeEntry].some(
      (e) =>
        e &&
        (e.status === "unmanaged" || e.status === "same_content_unmanaged"),
    );

  const rowIsDeployed = (row: UnifiedProjectSkillRow) =>
    Boolean(row.agentsEntry || row.claudeEntry);

  const { deployedRowCount, attentionRowCount, unmanagedRowCount } = useMemo(
    () => ({
      deployedRowCount: unifiedRows.filter(rowIsDeployed).length,
      attentionRowCount: unifiedRows.filter(rowHasAttention).length,
      unmanagedRowCount: unifiedRows.filter(rowHasUnmanaged).length,
    }),
    [unifiedRows],
  );

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return unifiedRows.filter((row) => {
      if (q) {
        const matches =
          row.displayName.toLowerCase().includes(q) ||
          row.directory.toLowerCase().includes(q) ||
          (row.description?.toLowerCase().includes(q) ?? false);
        if (!matches) return false;
      }
      if (statusFilter === "deployed") return rowIsDeployed(row);
      if (statusFilter === "attention") return rowHasAttention(row);
      if (statusFilter === "unmanaged") return rowHasUnmanaged(row);
      return true;
    });
  }, [unifiedRows, statusFilter, searchQuery]);

  const outdatedItems = useMemo(
    () => entries.filter((e) => e.status === "outdated" && e.mode === "copy"),
    [entries],
  );

  const importableUnmanaged = useMemo(
    () =>
      entries.filter(
        (e) =>
          (e.status === "unmanaged" || e.status === "same_content_unmanaged") &&
          e.diskExists &&
          !e.isSymlink,
      ),
    [entries],
  );

  const handleBatchUpdateOutdated = async () => {
    if (!activeProject || outdatedItems.length === 0) return;
    try {
      await updateDeploymentsMutation.mutateAsync({
        projectId: activeProject.id,
        items: outdatedItems.map((e) => ({
          target: e.target,
          directory: e.directory,
        })),
        allowOverwriteModified: false,
      });
      toast.success(`已同步更新 ${outdatedItems.length} 项过期 Skill`);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleBatchImportUnmanaged = async () => {
    if (!activeProject || importableUnmanaged.length === 0) return;
    try {
      const res = await importGlobalMutation.mutateAsync({
        projectId: activeProject.id,
        items: importableUnmanaged.map((e) => ({
          target: e.target,
          directory: e.directory,
          overwriteExisting: false,
        })),
      });
      toast.success(`已导入并纳管 ${res.length} 个项目 Skill 到全局库`);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleSingleUpdateFromGlobal = async (entry: ScannedProjectSkill) => {
    if (!activeProject) return;
    // 本地修改或双向冲突先进入差异对比弹窗，防止误覆写
    if (entry.status === "modified" || entry.status === "conflict") {
      setDiffSkill(entry);
      return;
    }
    try {
      await updateDeploymentsMutation.mutateAsync({
        projectId: activeProject.id,
        items: [{ target: entry.target, directory: entry.directory }],
        allowOverwriteModified: false,
      });
      toast.success(`已用全局最新更新 ${entry.target}/${entry.directory}`);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handlePushOrImport = async (
    entry: ScannedProjectSkill,
    overwriteExisting: boolean,
  ) => {
    if (!activeProject) return;
    try {
      await pushGlobalMutation.mutateAsync({
        projectId: activeProject.id,
        target: entry.target,
        directory: entry.directory,
        overwriteExisting,
      });
      toast.success(`已推送 ${entry.directory} 到全局 SSOT 主库`);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handlePromote = async (entry: ScannedProjectSkill) => {
    if (!activeProject) return;
    try {
      await promoteMutation.mutateAsync({
        projectId: activeProject.id,
        directory: entry.directory,
        overwriteAgents: false,
      });
      toast.success(
        `已将 ${entry.directory} 提升至 .agents/skills 并在 .claude/skills 建立相对别名`,
      );
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleSettleMissing = async (entry: ScannedProjectSkill) => {
    if (!activeProject) return;
    try {
      await settleMissingMutation.mutateAsync({
        projectId: activeProject.id,
        target: entry.target,
        directory: entry.directory,
      });
      toast.success(`已清理失效部署记录 ${entry.target}/${entry.directory}`);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleConfirmUndeploy = async (deleteLocalFiles: boolean) => {
    if (!activeProject || !undeployConfirm) return;
    const action =
      undeployConfirm.isSymlink ||
      undeployConfirm.mode === "symlink" ||
      undeployConfirm.mode === "relative_alias"
        ? deleteLocalFiles
          ? "delete_link"
          : "detach_only"
        : deleteLocalFiles
          ? "delete_copy"
          : "detach_only";

    try {
      await undeployMutation.mutateAsync({
        projectId: activeProject.id,
        target: undeployConfirm.target,
        directory: undeployConfirm.directory,
        action,
      });
      setUndeployConfirm(null);
      toast.success(
        deleteLocalFiles
          ? `已取消托管并移除 ${undeployConfirm.target}/${undeployConfirm.directory}`
          : `已取消托管（保留磁盘文件）`,
      );
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleSwitchDefaultMode = async (targetMode: ProjectDeployMode) => {
    if (
      !activeProject ||
      activeProject.defaultMode === targetMode ||
      convertingMode ||
      updateProjectMutation.isPending
    ) {
      return;
    }

    const isManagedEntry = (
      e?: ScannedProjectSkill,
    ): e is ScannedProjectSkill =>
      Boolean(
        e &&
          !e.detachedAt &&
          !e.missingOnDisk &&
          e.skillId &&
          e.status !== "unmanaged" &&
          e.status !== "same_content_unmanaged" &&
          e.status !== "source_missing",
      );

    const groupBuckets = new Map<
      string,
      { targets: ProjectSkillTarget[]; skillIds: string[] }
    >();
    let convertibleCount = 0;
    let skippedModifiedCount = 0;

    for (const row of unifiedRows) {
      const candidates = [row.agentsEntry, row.claudeEntry].filter(
        isManagedEntry,
      );
      if (candidates.length === 0) continue;

      const targetsToConvert: ProjectSkillTarget[] = [];
      for (const entry of candidates) {
        if (targetMode === "symlink") {
          if (entry.mode === "copy" || entry.mode === "relative_alias") {
            if (entry.status === "modified" || entry.status === "conflict") {
              skippedModifiedCount += 1;
            } else {
              targetsToConvert.push(entry.target);
            }
          }
        } else if (entry.mode === "symlink") {
          targetsToConvert.push(entry.target);
        }
      }

      if (targetsToConvert.length === 0) continue;
      const skillId = candidates[0]?.skillId ?? row.skill?.id;
      if (!skillId) continue;

      const sortedTargets = Array.from(
        new Set(targetsToConvert),
      ).sort() as ProjectSkillTarget[];
      const key = sortedTargets.join(",");
      const bucket = groupBuckets.get(key) ?? {
        targets: sortedTargets,
        skillIds: [],
      };
      bucket.skillIds.push(skillId);
      groupBuckets.set(key, bucket);
      convertibleCount += sortedTargets.length;
    }

    const convertibleGroups = Array.from(groupBuckets.values());

    // 没有任何已部署需转换条目，也没跳过项 -> 直接无感切换
    if (convertibleCount === 0 && skippedModifiedCount === 0) {
      try {
        await updateProjectMutation.mutateAsync({
          id: activeProject.id,
          defaultMode: targetMode,
        });
        toast.success(
          `项目部署模式已切换为「${targetMode === "symlink" ? t("projects.modeSymlinkShort") : t("projects.modeCopyShort")}」`,
        );
      } catch (error) {
        toast.error(t("common.error"), { description: String(error) });
      }
      return;
    }

    setModeSwitchConfirm({
      targetMode,
      convertibleGroups,
      convertibleCount,
      skippedModifiedCount,
    });
  };

  const executeModeSwitch = async (convertExisting: boolean) => {
    if (!activeProject || !modeSwitchConfirm || convertingMode) return;
    const {
      targetMode,
      convertibleGroups,
      convertibleCount,
      skippedModifiedCount,
    } = modeSwitchConfirm;

    setConvertingMode(true);
    try {
      await updateProjectMutation.mutateAsync({
        id: activeProject.id,
        defaultMode: targetMode,
      });

      if (convertExisting && convertibleGroups.length > 0) {
        for (const group of convertibleGroups) {
          await deployMutation.mutateAsync({
            projectId: activeProject.id,
            skillIds: group.skillIds,
            targets: group.targets,
            modeOverride: targetMode,
            overwriteConflicts: true,
          });
        }
      }

      setModeSwitchConfirm(null);
      const modeLabel =
        targetMode === "symlink"
          ? t("projects.modeSymlinkShort")
          : t("projects.modeCopyShort");

      if (convertExisting && convertibleCount > 0) {
        if (skippedModifiedCount > 0) {
          toast.warning(
            `已切换为「${modeLabel}」并转换 ${convertibleCount} 项部署`,
            {
              description: `另有 ${skippedModifiedCount} 项含本地修改或冲突的副本已保留未覆盖。`,
            },
          );
        } else {
          toast.success(`已将项目整体切换为「${modeLabel}」`, {
            description: `已转换 ${convertibleCount} 项受管部署。`,
          });
        }
      } else {
        toast.success(`后续新部署默认方式已设为「${modeLabel}」`, {
          description: "磁盘上已有部署保持不变。",
        });
      }
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      setConvertingMode(false);
    }
  };

  const groupBusy =
    deployGroupMutation.isPending || batchUndeployMutation.isPending;

  const groupDeployStates = useMemo(() => {
    const skillById = new Map(installedSkills.map((s) => [s.id, s]));
    const activeTargets = activeProject?.enabledTargets ?? ["agents"];
    const managedEntries = entries.filter(
      (entry) =>
        !entry.missingOnDisk &&
        !entry.detachedAt &&
        entry.status !== "unmanaged" &&
        entry.status !== "same_content_unmanaged",
    );

    return skillGroups.map((group) => {
      const validSkills = group.skills
        .map((id) => skillById.get(id))
        .filter((s): s is InstalledSkill => Boolean(s));
      const groupIdSet = new Set(validSkills.map((s) => s.id));
      const groupDirSet = new Set(validSkills.map((s) => s.directory));

      const matchedEntries = managedEntries.filter(
        (entry) =>
          (entry.skillId && groupIdSet.has(entry.skillId)) ||
          groupDirSet.has(entry.directory),
      );

      let coveredSkillsCount = 0;
      for (const skill of validSkills) {
        const hasAllEnabledTargets = activeTargets.every((target) =>
          matchedEntries.some(
            (entry) =>
              entry.target === target &&
              (entry.skillId === skill.id ||
                entry.directory === skill.directory),
          ),
        );
        if (hasAllEnabledTargets) {
          coveredSkillsCount += 1;
        }
      }

      const isFullyDeployed =
        validSkills.length > 0 && coveredSkillsCount === validSkills.length;

      return {
        group,
        totalCount: validSkills.length,
        coveredSkillsCount,
        isFullyDeployed,
        matchedEntries,
      };
    });
  }, [installedSkills, entries, skillGroups, activeProject]);

  const appliedGroups = useMemo(
    () => groupDeployStates.filter((item) => item.isFullyDeployed),
    [groupDeployStates],
  );

  const handleCancelSkillGroup = async (
    group: SkillGroup,
    matchedEntries: ScannedProjectSkill[],
  ) => {
    if (!activeProject || groupBusy) return;
    setGroupPopoverOpen(false);

    const safeItems: Array<{
      target: ProjectSkillTarget;
      directory: string;
      action: "delete_link" | "delete_copy";
    }> = [];
    let skippedModifiedCount = 0;

    for (const entry of matchedEntries) {
      const isLink =
        entry.isSymlink ||
        entry.mode === "symlink" ||
        entry.mode === "relative_alias";
      if (isLink) {
        safeItems.push({
          target: entry.target,
          directory: entry.directory,
          action: "delete_link",
        });
      } else if (
        entry.mode === "copy" &&
        entry.canAutoDeleteCleanCopy &&
        entry.status === "synced"
      ) {
        safeItems.push({
          target: entry.target,
          directory: entry.directory,
          action: "delete_copy",
        });
      } else {
        skippedModifiedCount += 1;
      }
    }

    if (safeItems.length === 0) {
      toast.warning(`技能组「${group.name}」无可安全自动取消的条目`, {
        description:
          skippedModifiedCount > 0
            ? `${skippedModifiedCount} 项有本地改动或冲突，已保留，请逐项确认处理。`
            : undefined,
      });
      return;
    }

    try {
      await batchUndeployMutation.mutateAsync({
        projectId: activeProject.id,
        items: safeItems,
      });
      if (skippedModifiedCount > 0) {
        toast.warning(`已取消技能组「${group.name}」的部署`, {
          description: `已移除 ${safeItems.length} 条记录；另有 ${skippedModifiedCount} 条本地修改/冲突副本已保留。`,
        });
      } else {
        toast.success(`已取消技能组「${group.name}」的部署`, {
          description: `共移除 ${safeItems.length} 条部署记录`,
        });
      }
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleApplySkillGroup = async (group: SkillGroup) => {
    if (!activeProject || groupBusy) return;
    setGroupPopoverOpen(false);
    try {
      const res = await deployGroupMutation.mutateAsync({
        projectId: activeProject.id,
        groupId: group.id,
        targets: activeProject.enabledTargets,
        modeOverride: activeProject.defaultMode,
        overwriteConflicts: false,
      });
      const detail = [
        res.deployed.length > 0 ? `新部署 ${res.deployed.length} 项` : "",
        res.missingFromLibrary.length > 0
          ? `全局已删除 ${res.missingFromLibrary.length} 项`
          : "",
        res.warnings.length > 0 ? res.warnings.join("；") : "",
      ]
        .filter(Boolean)
        .join(" · ");
      if (res.missingFromLibrary.length > 0 || res.warnings.length > 0) {
        toast.warning(`已应用技能组「${group.name}」`, { description: detail });
      } else {
        toast.success(`已应用技能组「${group.name}」`, {
          description: detail || "已全部就绪",
        });
      }
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleToggleTarget = async (
    row: UnifiedProjectSkillRow,
    target: ProjectSkillTarget,
  ) => {
    if (!activeProject) return;
    const entry = target === "agents" ? row.agentsEntry : row.claudeEntry;
    const lockKey = `${row.key}:${target}`;
    if (pendingToggleKey) return;

    // 1. 当前位置尚未部署 -> 直接启用部署
    if (!entry) {
      if (!row.skill) return;
      setPendingToggleKey(lockKey);
      try {
        const res = await deployMutation.mutateAsync({
          projectId: activeProject.id,
          skillIds: [row.skill.id],
          targets: [target],
          modeOverride: activeProject.defaultMode,
          overwriteConflicts: false,
        });
        const targetLabel =
          target === "claude" ? ".claude/skills" : ".agents/skills";
        if (res.warnings.length > 0) {
          toast.warning(`已部署 ${row.displayName} → ${targetLabel}`, {
            description: res.warnings.join("；"),
          });
        } else if (res.skipped.length > 0) {
          toast.info(res.skipped.join("；"));
        } else {
          toast.success(`已启用 ${row.displayName} (${targetLabel})`);
        }
      } catch (error) {
        toast.error(t("common.error"), { description: String(error) });
      } finally {
        setPendingToggleKey(null);
      }
      return;
    }

    // 2. 磁盘上缺失的失效记录 -> 清理记录
    if (entry.missingOnDisk) {
      await handleSettleMissing(entry);
      return;
    }

    // 2.5 已脱管（保留链接）-> 弹窗询问重新纳管还是彻底删除磁盘链接
    if (entry.detachedAt) {
      setDetachedDialog({ row, target, entry });
      return;
    }

    // 3. 外部自带（未托管）目录 -> 引导纳管确认，避免直接覆盖或误删
    if (
      entry.status === "unmanaged" ||
      entry.status === "same_content_unmanaged"
    ) {
      setAdoptOrRebind({ mode: "adopt", skill: entry });
      return;
    }

    // 3.5 移除 .agents 入口时若 .claude 为相对别名，需拦截防悬空
    if (
      target === "agents" &&
      row.claudeEntry?.mode === "relative_alias" &&
      !row.claudeEntry.missingOnDisk
    ) {
      setAliasRemoveDialog({
        row,
        agentsEntry: entry,
        claudeEntry: row.claudeEntry,
      });
      return;
    }

    // 4. 软链 / 引用 .agents / 未改动的受管副本 -> 点击直接关闭移除
    const isLink =
      entry.isSymlink ||
      entry.mode === "symlink" ||
      entry.mode === "relative_alias";
    if (
      isLink ||
      (entry.mode === "copy" &&
        entry.canAutoDeleteCleanCopy &&
        entry.status === "synced")
    ) {
      setPendingToggleKey(lockKey);
      try {
        await undeployMutation.mutateAsync({
          projectId: activeProject.id,
          target,
          directory: entry.directory,
          action: isLink ? "delete_link" : "delete_copy",
        });
        toast.success(
          `已移除 ${row.displayName} (${target === "claude" ? ".claude/skills" : ".agents/skills"})`,
        );
      } catch (error) {
        toast.error(t("common.error"), { description: String(error) });
      } finally {
        setPendingToggleKey(null);
      }
      return;
    }

    // 5. 本地已改写 / 冲突等敏感副本 -> 弹出确认框由用户决定是否删盘
    setUndeployConfirm(entry);
  };

  const handleRebindDetached = async () => {
    if (!activeProject || !detachedDialog) return;
    const { entry, row } = detachedDialog;
    const skillId = entry.skillId ?? row.skill?.id;
    if (!skillId) {
      setDetachedDialog(null);
      setAdoptOrRebind({ mode: "rebind", skill: entry });
      return;
    }
    try {
      await rebindMutation.mutateAsync({
        projectId: activeProject.id,
        target: entry.target,
        directory: entry.directory,
        skillId,
      });
      setDetachedDialog(null);
      toast.success(`已重新纳管 ${row.displayName}`);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleDeleteDetachedLink = async () => {
    if (!activeProject || !detachedDialog) return;
    const { entry, row } = detachedDialog;
    const isLink =
      entry.isSymlink ||
      entry.mode === "symlink" ||
      entry.mode === "relative_alias";
    try {
      await undeployMutation.mutateAsync({
        projectId: activeProject.id,
        target: entry.target,
        directory: entry.directory,
        action: isLink ? "delete_link" : "delete_copy",
      });
      setDetachedDialog(null);
      toast.success(`已删除脱管链接 ${row.displayName}`);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  const handleAliasRemoveChoice = async (
    choice: "both" | "keep_claude" | "detach_agents",
  ) => {
    if (!activeProject || !aliasRemoveDialog) return;
    const { row, agentsEntry } = aliasRemoveDialog;
    const agentsIsLink =
      agentsEntry.isSymlink || agentsEntry.mode === "symlink";

    try {
      if (choice === "both") {
        await batchUndeployMutation.mutateAsync({
          projectId: activeProject.id,
          items: [
            {
              target: "claude",
              directory: agentsEntry.directory,
              action: "delete_link",
            },
            {
              target: "agents",
              directory: agentsEntry.directory,
              action: agentsIsLink ? "delete_link" : "delete_copy",
            },
          ],
        });
        toast.success(`已整组移除 ${row.displayName} (.agents 与 .claude)`);
      } else if (choice === "keep_claude") {
        const skillId = agentsEntry.skillId ?? row.skill?.id;
        if (!skillId) return;
        await batchUndeployMutation.mutateAsync({
          projectId: activeProject.id,
          items: [
            {
              target: "claude",
              directory: agentsEntry.directory,
              action: "delete_link",
            },
            {
              target: "agents",
              directory: agentsEntry.directory,
              action: agentsIsLink ? "delete_link" : "delete_copy",
            },
          ],
        });
        await deployMutation.mutateAsync({
          projectId: activeProject.id,
          skillIds: [skillId],
          targets: ["claude"],
          modeOverride: agentsEntry.mode === "copy" ? "copy" : "symlink",
          overwriteConflicts: true,
        });
        toast.success(
          `已移除 .agents，并将 ${row.displayName} 转为 .claude 独立部署`,
        );
      } else {
        await undeployMutation.mutateAsync({
          projectId: activeProject.id,
          target: "agents",
          directory: agentsEntry.directory,
          action: "detach_only",
        });
        toast.success(
          `已解除 .agents/${agentsEntry.directory} 托管并保留磁盘文件`,
        );
      }
      setAliasRemoveDialog(null);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-full min-h-0 flex-1 overflow-hidden">
        {/* 左侧项目列表 */}
        <aside className="flex w-72 shrink-0 flex-col border-r border-border/80 bg-muted/35 dark:bg-muted/20">
          <div className="flex items-center justify-between border-b border-border/70 bg-background/50 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                {t("projects.title")}
              </h2>
              <p className="text-[11px] tabular-nums text-muted-foreground">
                {projects.length} 个项目
              </p>
            </div>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              {t("projects.addProject")}
            </Button>
          </div>

          <ScrollArea className="flex-1 p-2">
            {loadingProjects ? (
              <div className="space-y-2 p-1" aria-busy="true">
                {[0, 1, 2].map((idx) => (
                  <div
                    key={idx}
                    className="animate-pulse rounded-lg border bg-background/60 p-3 space-y-2"
                  >
                    <div className="h-4 w-2/3 rounded bg-muted" />
                    <div className="h-3 w-full rounded bg-muted/70" />
                    <div className="flex gap-1.5 pt-1">
                      <div className="h-4 w-10 rounded-full bg-muted" />
                      <div className="h-4 w-12 rounded-full bg-muted" />
                    </div>
                  </div>
                ))}
              </div>
            ) : projects.length === 0 ? (
              <div className="space-y-3 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                <FolderGit2 className="mx-auto h-7 w-7 opacity-40" />
                <div className="font-medium text-foreground">
                  {t("projects.noProjects")}
                </div>
                <p className="leading-relaxed">
                  {t("projects.noProjectsDesc")}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setAddOpen(true)}
                >
                  <FolderPlus className="mr-1.5 h-3.5 w-3.5" />
                  {t("projects.addProject")}
                </Button>
              </div>
            ) : (
              <div className="space-y-1.5">
                {projects.map((item) => {
                  const selected = item.project.id === selectedProjectId;
                  const issueCount =
                    item.outdatedCount +
                    item.modifiedCount +
                    item.conflictCount +
                    item.brokenCount;
                  const isSymlinkMode = item.project.defaultMode === "symlink";
                  return (
                    <button
                      key={item.project.id}
                      type="button"
                      onClick={() => setSelectedProjectId(item.project.id)}
                      className={`relative w-full overflow-hidden rounded-xl border px-3 py-2.5 text-left transition-all ${
                        selected
                          ? "border-sky-500/35 bg-gradient-to-br from-sky-500/[0.08] via-background to-background shadow-sm dark:from-sky-500/[0.12] dark:via-background dark:to-background"
                          : "border-transparent hover:border-border/80 hover:bg-background/80"
                      }`}
                    >
                      {selected && (
                        <span
                          aria-hidden
                          className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-sky-500"
                        />
                      )}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span
                            aria-hidden
                            className={`inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border text-[11px] font-bold tracking-tight ${
                              isSymlinkMode
                                ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                                : "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                            }`}
                          >
                            {getProjectInitials(item.project.name)}
                          </span>
                          <span className="truncate text-sm font-semibold text-foreground">
                            {item.project.name}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {item.deployedCount > 0 && (
                            <Badge
                              variant="outline"
                              className="border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 text-[10px] font-medium tabular-nums text-emerald-700 dark:text-emerald-300"
                            >
                              {item.deployedCount} 已启用
                            </Badge>
                          )}
                          {(!item.rootExists || !item.identityMatched) && (
                            <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                          )}
                          {item.project.archivedAt && (
                            <Badge variant="outline" className="text-[10px]">
                              <Archive className="mr-0.5 h-2.5 w-2.5" />
                              {t("projects.archived")}
                            </Badge>
                          )}
                        </div>
                      </div>
                      <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                        {item.project.rootPath}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                        <Badge
                          variant="outline"
                          className={`px-1.5 py-0 font-medium ${
                            isSymlinkMode
                              ? "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                              : "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                          }`}
                        >
                          {isSymlinkMode && (
                            <Link2 className="mr-0.5 h-2.5 w-2.5" />
                          )}
                          {isSymlinkMode
                            ? t("projects.modeSymlinkShort")
                            : t("projects.modeCopyShort")}
                        </Badge>
                        {item.isGitRepo && (
                          <Badge
                            variant="outline"
                            className="border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0 font-medium text-emerald-700 dark:text-emerald-300"
                          >
                            <GitBranch className="mr-0.5 h-2.5 w-2.5" />
                            {item.isWorktree ? "Worktree" : "Git"}
                          </Badge>
                        )}
                        {issueCount > 0 && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/35 bg-amber-500/10 px-1.5 py-0 font-medium tabular-nums text-amber-700 dark:text-amber-300"
                          >
                            {issueCount} 待处理
                          </Badge>
                        )}
                        {item.unmanagedCount > 0 && (
                          <Badge
                            variant="outline"
                            className="border-violet-500/30 bg-violet-500/10 px-1.5 py-0 font-medium tabular-nums text-violet-700 dark:text-violet-300"
                          >
                            +{item.unmanagedCount} 未纳管
                          </Badge>
                        )}
                        {item.deployedCount === 0 &&
                          issueCount === 0 &&
                          item.unmanagedCount === 0 &&
                          installedSkills.length > 0 && (
                            <Badge
                              variant="outline"
                              className="border-border/70 bg-muted/60 px-1.5 py-0 tabular-nums text-muted-foreground"
                            >
                              0/{installedSkills.length} 启用
                            </Badge>
                          )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </ScrollArea>

          <div className="flex items-center justify-between border-t border-border/70 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
            <label className="flex items-center gap-2 cursor-pointer">
              <Checkbox
                checked={includeArchived}
                onCheckedChange={(v) => setIncludeArchived(Boolean(v))}
              />
              <span>{t("projects.includeArchived")}</span>
            </label>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => void refetchProjects()}
              title={t("projects.rescan")}
              aria-label={t("projects.rescan")}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </aside>

        {/* 右侧详情主区 */}
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
          {!activeProject ? (
            <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground">
              <FolderGit2 className="mb-3 h-10 w-10 opacity-30" />
              <p className="text-sm">{t("projects.selectProjectHint")}</p>
            </div>
          ) : (
            <>
              {/* 顶部项目信息与动作栏 */}
              <header className="border-b border-border/80 bg-gradient-to-b from-muted/30 to-background px-6 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                        {activeProject.name}
                      </h1>
                      {activeListItem?.isGitRepo && (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/30 bg-emerald-500/10 text-xs font-medium text-emerald-700 dark:text-emerald-300"
                        >
                          <GitBranch className="mr-1 h-3 w-3" />
                          {activeListItem.isWorktree
                            ? t("projects.gitWorktree")
                            : t("projects.gitRepo")}
                        </Badge>
                      )}
                      {appliedGroups.length > 0 && (
                        <Badge
                          variant="outline"
                          className="border-sky-500/30 bg-sky-500/10 text-xs font-medium text-sky-700 dark:text-sky-300"
                        >
                          已套用 · {appliedGroups[0].group.name}
                          {appliedGroups.length > 1
                            ? ` +${appliedGroups.length - 1}`
                            : ""}
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                      {activeProject.rootPath}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 border border-transparent p-0 text-muted-foreground hover:border-border/70 hover:bg-muted/60 hover:text-foreground"
                      onClick={() => setRelocateOpen(true)}
                      title={t("projects.relocateProject")}
                      aria-label={t("projects.relocateProject")}
                    >
                      <MapPin className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 border border-transparent p-0 text-muted-foreground hover:border-border/70 hover:bg-muted/60 hover:text-foreground"
                      onClick={() => setSettingsOpen(true)}
                      title={t("projects.projectSettings")}
                      aria-label={t("projects.projectSettings")}
                    >
                      <Settings className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 w-8 border border-transparent p-0 text-muted-foreground hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setRemoveOpen(true)}
                      title={t("projects.removeProject")}
                      aria-label={t("projects.removeProject")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Popover
                    open={groupPopoverOpen}
                    onOpenChange={setGroupPopoverOpen}
                  >
                    <PopoverTrigger asChild>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={`h-8 px-2.5 text-xs font-medium ${
                          appliedGroups.length > 0
                            ? "border-violet-500/45 bg-violet-500/15 text-violet-700 ring-1 ring-violet-500/20 hover:bg-violet-500/20 dark:text-violet-300"
                            : "border-violet-500/30 bg-violet-500/10 text-violet-700 hover:bg-violet-500/15 dark:text-violet-300"
                        }`}
                        disabled={groupBusy}
                        title="按技能组一键部署或取消部署"
                      >
                        {groupBusy ? (
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin opacity-75" />
                        ) : (
                          <Layers className="mr-1.5 h-3.5 w-3.5 opacity-85" />
                        )}
                        <span className="max-w-[7.5rem] truncate tabular-nums">
                          {groupBusy
                            ? "处理中..."
                            : appliedGroups.length === 1
                              ? appliedGroups[0].group.name
                              : appliedGroups.length > 1
                                ? `技能组 (${appliedGroups.length})`
                                : "技能组"}
                        </span>
                        <ChevronsUpDown className="ml-1 h-3 w-3 opacity-55" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="z-[100] w-72 p-0" align="start">
                      <Command label="搜索技能组">
                        <CommandInput placeholder="搜索技能组（点击部署 / 再点取消）..." />
                        <CommandList>
                          <CommandEmpty>暂无全局技能组</CommandEmpty>
                          {groupDeployStates.length > 0 && (
                            <CommandGroup>
                              {groupDeployStates.map(
                                ({
                                  group,
                                  totalCount,
                                  coveredSkillsCount,
                                  isFullyDeployed,
                                  matchedEntries,
                                }) => (
                                  <CommandItem
                                    key={group.id}
                                    value={group.id}
                                    keywords={[group.name]}
                                    onSelect={() => {
                                      if (isFullyDeployed) {
                                        void handleCancelSkillGroup(
                                          group,
                                          matchedEntries,
                                        );
                                      } else {
                                        void handleApplySkillGroup(group);
                                      }
                                    }}
                                    className="gap-2"
                                  >
                                    {isFullyDeployed ? (
                                      <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                                    ) : (
                                      <Layers className="h-3.5 w-3.5 shrink-0 opacity-60" />
                                    )}
                                    <span
                                      className={`truncate ${isFullyDeployed ? "font-medium text-foreground" : ""}`}
                                    >
                                      {group.name}
                                    </span>
                                    <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-[11px] tabular-nums text-muted-foreground">
                                      <span>
                                        {coveredSkillsCount > 0
                                          ? `${coveredSkillsCount}/${totalCount}`
                                          : `${totalCount} Skills`}
                                      </span>
                                      {matchedEntries.length > 0 && (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            void handleCancelSkillGroup(
                                              group,
                                              matchedEntries,
                                            );
                                          }}
                                          onKeyDown={(e) => {
                                            if (
                                              e.key === "Enter" ||
                                              e.key === " "
                                            ) {
                                              e.preventDefault();
                                              e.stopPropagation();
                                              void handleCancelSkillGroup(
                                                group,
                                                matchedEntries,
                                              );
                                            }
                                          }}
                                          aria-label={`取消技能组「${group.name}」的部署`}
                                          className="rounded px-1.5 py-0.5 text-[10px] font-medium text-rose-600 transition-colors hover:bg-rose-500/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-500 dark:text-rose-400"
                                          title={`取消技能组「${group.name}」的部署`}
                                        >
                                          取消
                                        </button>
                                      )}
                                    </span>
                                  </CommandItem>
                                ),
                              )}
                            </CommandGroup>
                          )}
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>

                  <div
                    className="inline-flex h-8 items-center rounded-lg border border-border/80 bg-muted/60 p-0.5 text-xs"
                    title="切换项目部署模式（将提示是否转换现有已部署 Skill 的磁盘方式）"
                  >
                    <button
                      type="button"
                      disabled={
                        updateProjectMutation.isPending || convertingMode
                      }
                      onClick={() => void handleSwitchDefaultMode("symlink")}
                      className={`inline-flex h-full items-center gap-1 rounded-md px-2.5 transition-all ${
                        activeProject.defaultMode === "symlink"
                          ? "bg-background font-semibold text-sky-700 shadow-sm ring-1 ring-sky-500/25 dark:text-sky-300"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      <Link2 className="h-3 w-3" />
                      {t("projects.modeSymlinkShort")}
                    </button>
                    <button
                      type="button"
                      disabled={
                        updateProjectMutation.isPending || convertingMode
                      }
                      onClick={() => void handleSwitchDefaultMode("copy")}
                      className={`inline-flex h-full items-center rounded-md px-2.5 transition-all ${
                        activeProject.defaultMode === "copy"
                          ? "bg-background font-semibold text-violet-700 shadow-sm ring-1 ring-violet-500/25 dark:text-violet-300"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {t("projects.modeCopyShort")}
                    </button>
                  </div>

                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 bg-background/80 text-xs"
                    onClick={() => void refetchScan()}
                    disabled={scanning}
                  >
                    <RefreshCw
                      className={`mr-1.5 h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`}
                    />
                    {t("projects.rescan")}
                  </Button>
                </div>
              </header>

              {/* 目录缺失 / identity mismatch 高危告警栏 */}
              {scanResult &&
                (!scanResult.rootExists || !scanResult.identityMatched) && (
                  <div className="mx-6 mt-4 flex items-center justify-between gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-xs text-destructive">
                    <div className="flex items-center gap-2">
                      <ShieldAlert className="h-4 w-4 shrink-0" />
                      <span>
                        {!scanResult.rootExists
                          ? t("projects.missingRoot")
                          : t("projects.identityMismatch")}
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setRelocateOpen(true)}
                    >
                      {t("projects.relocateProject")}
                    </Button>
                  </div>
                )}

              {/* 页签切换：Skills vs Rules */}
              <div className="flex items-center justify-between border-b border-border/80 px-6 pt-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTab("skills")}
                    className={`inline-flex items-center gap-2 border-b-2 px-3 pb-2.5 text-sm transition-colors ${
                      activeTab === "skills"
                        ? "border-sky-500 font-semibold text-foreground"
                        : "border-transparent font-medium text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <span>{t("projects.tabSkills")}</span>
                    <span
                      className={`inline-flex h-[18px] items-center rounded-full border px-1.5 text-[11px] font-semibold tabular-nums ${
                        deployedRowCount > 0
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                          : "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                      }`}
                    >
                      {deployedRowCount} / {unifiedRows.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab("rules")}
                    className={`border-b-2 px-3 pb-2.5 text-sm transition-colors ${
                      activeTab === "rules"
                        ? "border-sky-500 font-semibold text-foreground"
                        : "border-transparent font-medium text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {t("projects.tabRules")}
                  </button>
                </div>

                {activeTab === "skills" && (
                  <div className="flex items-center gap-2 pb-2">
                    {outdatedItems.length > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 border-sky-500/35 bg-sky-500/10 text-xs tabular-nums text-sky-700 hover:bg-sky-500/15 dark:text-sky-300"
                        disabled={updateDeploymentsMutation.isPending}
                        onClick={() => void handleBatchUpdateOutdated()}
                      >
                        <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                        {t("projects.batchUpdate")} ({outdatedItems.length})
                      </Button>
                    )}
                    {importableUnmanaged.length > 0 && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 border-violet-500/35 bg-violet-500/10 text-xs tabular-nums text-violet-700 hover:bg-violet-500/15 dark:text-violet-300"
                        disabled={importGlobalMutation.isPending}
                        onClick={() => void handleBatchImportUnmanaged()}
                      >
                        <Download className="mr-1.5 h-3.5 w-3.5" />
                        {t("projects.importAllUnmanaged")} (
                        {importableUnmanaged.length})
                      </Button>
                    )}
                  </div>
                )}
              </div>

              {activeTab === "rules" ? (
                <div className="flex-1 overflow-y-auto p-6">
                  <ProjectRulesPanel projectId={activeProject.id} />
                </div>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
                  {/* 筛选与搜索栏 */}
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1 rounded-lg border border-border/80 bg-muted/50 p-1 text-xs">
                      {(
                        [
                          {
                            key: "all",
                            label: `${t("projects.filterAll")} (${unifiedRows.length})`,
                            dotClass: "",
                          },
                          {
                            key: "deployed",
                            label: `已启用 (${deployedRowCount})`,
                            dotClass: "bg-emerald-500",
                          },
                          {
                            key: "attention",
                            label: `${t("projects.filterUpdatesOrConflicts")}${attentionRowCount > 0 ? ` (${attentionRowCount})` : ""}`,
                            dotClass: "bg-amber-500",
                          },
                          {
                            key: "unmanaged",
                            label: `${t("projects.filterUnmanaged")}${unmanagedRowCount > 0 ? ` (${unmanagedRowCount})` : ""}`,
                            dotClass: "bg-violet-500",
                          },
                        ] as const
                      ).map(({ key, label, dotClass }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setStatusFilter(key)}
                          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 tabular-nums transition-colors ${
                            statusFilter === key
                              ? "bg-background font-semibold text-foreground shadow-sm ring-1 ring-border/50"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {dotClass && (
                            <span
                              aria-hidden
                              className={`h-1.5 w-1.5 rounded-full ${dotClass}`}
                            />
                          )}
                          {label}
                        </button>
                      ))}
                    </div>

                    <div className="relative w-56">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="搜索 Skill 名称..."
                        className="h-8 border-border/80 bg-muted/25 pl-8 text-xs focus-visible:bg-background"
                      />
                    </div>
                  </div>

                  {/* 项目级折叠 Claude 同名覆盖提示条（去重折叠） */}
                  {claudePrecedenceRows.length > 0 && (
                    <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                          <span className="truncate tabular-nums">
                            {t("projects.claudePrecedence.summaryTitle", {
                              count: claudePrecedenceRows.length,
                            })}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setClaudeWarningsExpanded((prev) => !prev)
                          }
                          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium hover:bg-amber-500/15"
                        >
                          {claudeWarningsExpanded ? (
                            <>
                              <ChevronDown className="h-3 w-3" />
                              {t("projects.claudePrecedence.hideNames")}
                            </>
                          ) : (
                            <>
                              <ChevronRight className="h-3 w-3" />
                              {t("projects.claudePrecedence.showNames")}
                            </>
                          )}
                        </button>
                      </div>
                      {claudeWarningsExpanded && (
                        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-amber-500/20 pt-2">
                          {claudePrecedenceRows.map((r) => (
                            <span
                              key={r.key}
                              className="rounded border border-amber-500/25 bg-background/70 px-1.5 py-0.5 font-mono text-[11px]"
                            >
                              {r.directory}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* 项目 Skills 列表（仿全局视图：一行一 Skill + 右侧点亮式目标胶囊开关） */}
                  <ScrollArea className="flex-1 pr-2">
                    {scanning && !scanResult ? (
                      <div
                        className="mb-6 divide-y divide-border/70 rounded-xl border border-border/80 bg-card shadow-sm"
                        aria-busy="true"
                      >
                        {[0, 1, 2, 3].map((idx) => (
                          <div
                            key={idx}
                            className="flex animate-pulse items-center justify-between gap-4 px-4 py-3"
                          >
                            <div className="min-w-0 flex-1 space-y-2">
                              <div className="h-4 w-44 rounded bg-muted" />
                              <div className="h-3 w-80 max-w-full rounded bg-muted/70" />
                            </div>
                            <div className="flex items-center gap-1.5">
                              <div className="h-7 w-[72px] rounded-lg bg-muted" />
                              <div className="h-7 w-[72px] rounded-lg bg-muted" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : filteredRows.length === 0 ? (
                      <div className="rounded-xl border border-dashed py-14 text-center text-xs text-muted-foreground">
                        当前筛选条件下没有匹配的 Skills
                      </div>
                    ) : (
                      <div className="mb-6 divide-y divide-border/70 rounded-xl border border-border/80 bg-card shadow-sm">
                        {filteredRows.map((row) => {
                          const slotEntries = [
                            row.agentsEntry,
                            row.claudeEntry,
                          ].filter(Boolean) as ScannedProjectSkill[];

                          const structureWarn = slotEntries.find(
                            (e) => e.structureError,
                          )?.structureError;

                          // 同 Skill 同时启用 .agents 与 .claude 属于正常双端部署，不刷噪音提示
                          const extraConflictTargets = Array.from(
                            new Set(
                              slotEntries.flatMap((e) =>
                                e.diagnostics.duplicateNameConflicts.filter(
                                  (w) =>
                                    w !== `agents/${row.directory}` &&
                                    w !== `claude/${row.directory}`,
                                ),
                              ),
                            ),
                          );

                          const hasSlotActions = slotEntries.some(
                            (entry) =>
                              Boolean(entry.detachedAt) ||
                              (entry.diskExists &&
                                !entry.isSymlink &&
                                Boolean(entry.skillId)) ||
                              (entry.status === "outdated" &&
                                entry.mode === "copy") ||
                              ((entry.status === "unmanaged" ||
                                entry.status === "same_content_unmanaged") &&
                                entry.diskExists &&
                                !entry.isSymlink) ||
                              entry.status === "source_missing" ||
                              (entry.target === "claude" &&
                                !entry.isSymlink &&
                                entry.diskExists &&
                                entry.status !== "invalid_structure") ||
                              entry.missingOnDisk,
                          );

                          const renderTargetToggle = (
                            target: ProjectSkillTarget,
                            entry?: ScannedProjectSkill,
                          ) => {
                            const isBusy =
                              pendingToggleKey === `${row.key}:${target}`;
                            const isEnabled = Boolean(entry);
                            const isDetached = Boolean(entry?.detachedAt);
                            const isClaude = target === "claude";
                            const isHealthyLink =
                              entry &&
                              !isDetached &&
                              (entry.mode === "symlink" ||
                                entry.mode === "relative_alias") &&
                              entry.diskExists &&
                              entry.status !== "broken" &&
                              entry.status !== "invalid_structure" &&
                              entry.status !== "source_missing";
                            const hasError = Boolean(
                              entry &&
                                (entry.status === "broken" ||
                                  entry.status === "invalid_structure" ||
                                  entry.status === "source_missing" ||
                                  entry.missingOnDisk),
                            );
                            const isUnmanaged = Boolean(
                              entry &&
                                !isDetached &&
                                (entry.status === "unmanaged" ||
                                  entry.status === "same_content_unmanaged"),
                            );
                            const hasWarning = Boolean(
                              entry &&
                                !isDetached &&
                                (entry.status === "outdated" ||
                                  entry.status === "modified" ||
                                  entry.status === "conflict"),
                            );

                            const btnClass = getTargetToggleClass({
                              isEnabled,
                              isDetached,
                              hasError,
                              hasWarning,
                              isUnmanaged,
                              isClaude,
                            });

                            const targetName = isClaude
                              ? "Claude (.claude/skills)"
                              : "通用 (.agents/skills)";
                            const modeText = entry
                              ? isDetached
                                ? t("projects.status.detached")
                                : entry.mode === "relative_alias"
                                  ? t("projects.relativeAlias")
                                  : entry.mode === "symlink" || entry.isSymlink
                                    ? t("projects.modeSymlinkShort")
                                    : entry.mode === "copy"
                                      ? t("projects.modeCopyShort")
                                      : t("projects.filterUnmanaged")
                              : `未启用（点击按${activeProject.defaultMode === "symlink" ? t("projects.modeSymlinkShort") : t("projects.modeCopyShort")}部署）`;

                            return (
                              <Tooltip key={target}>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                    disabled={
                                      Boolean(pendingToggleKey) ||
                                      (!entry && !row.skill)
                                    }
                                    onClick={() =>
                                      void handleToggleTarget(row, target)
                                    }
                                    aria-label={targetName}
                                    aria-pressed={isEnabled && !isDetached}
                                    className={`relative inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 ${btnClass}`}
                                  >
                                    <span className="pointer-events-none inline-flex shrink-0 items-center">
                                      {isBusy ? (
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                      ) : isClaude ? (
                                        <ClaudeIcon size={12} />
                                      ) : (
                                        <Bot className="h-3.5 w-3.5" />
                                      )}
                                    </span>
                                    <span>
                                      {isClaude ? "Claude" : ".agents"}
                                    </span>
                                    {isHealthyLink && !isBusy && (
                                      <span
                                        aria-hidden
                                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500"
                                      />
                                    )}
                                    {isDetached && !isBusy && (
                                      <span
                                        aria-hidden
                                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/70"
                                      />
                                    )}
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">
                                  <p className="font-medium">
                                    {targetName}
                                    {isEnabled ? " ✓" : ""}
                                  </p>
                                  <p className="text-[11px] opacity-80">
                                    {modeText}
                                    {isHealthyLink && entry?.actualLinkTarget
                                      ? ` → ${entry.actualLinkTarget}`
                                      : ""}
                                  </p>
                                </TooltipContent>
                              </Tooltip>
                            );
                          };

                          return (
                            <div
                              key={row.key}
                              className="flex flex-col gap-1.5 px-4 py-3 text-sm transition-colors hover:bg-muted/25"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <div className="flex min-h-6 flex-wrap items-center gap-2">
                                    <span className="font-medium leading-6 text-foreground">
                                      {row.displayName}
                                    </span>
                                    {row.directory !== row.displayName && (
                                      <span className="font-mono text-[11px] text-muted-foreground">
                                        {row.directory}
                                      </span>
                                    )}
                                    {(() => {
                                      const managedSlots = slotEntries.filter(
                                        (entry) =>
                                          entry.detachedAt == null &&
                                          entry.status !== "unmanaged" &&
                                          entry.status !==
                                            "same_content_unmanaged",
                                      );
                                      if (managedSlots.length === 0)
                                        return null;

                                      const renderModeBadge = (
                                        key: string,
                                        mode: ScannedProjectSkill["mode"],
                                        prefix = "",
                                      ) => {
                                        const isCopyLike = mode === "copy";
                                        const label =
                                          mode === "symlink"
                                            ? t("projects.modeSymlinkShort")
                                            : mode === "relative_alias"
                                              ? t("projects.relativeAlias")
                                              : t("projects.modeCopyShort");
                                        return (
                                          <Badge
                                            key={key}
                                            variant="outline"
                                            className={`h-5 px-1.5 py-0 text-[10px] leading-none font-medium ${
                                              isCopyLike
                                                ? "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                                                : "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                                            }`}
                                          >
                                            {!isCopyLike && (
                                              <Link2 className="mr-1 h-2.5 w-2.5" />
                                            )}
                                            {`${prefix}${label}`}
                                          </Badge>
                                        );
                                      };

                                      if (managedSlots.length === 1) {
                                        return renderModeBadge(
                                          `mode-${managedSlots[0].target}`,
                                          managedSlots[0].mode,
                                        );
                                      }

                                      const agentsMode = row.agentsEntry?.mode;
                                      const claudeMode = row.claudeEntry?.mode;
                                      if (
                                        agentsMode === "symlink" &&
                                        claudeMode === "symlink"
                                      ) {
                                        return renderModeBadge(
                                          "mode-unified",
                                          "symlink",
                                        );
                                      }
                                      if (
                                        agentsMode === "copy" &&
                                        (claudeMode === "copy" ||
                                          claudeMode === "relative_alias")
                                      ) {
                                        return renderModeBadge(
                                          "mode-unified",
                                          "copy",
                                        );
                                      }

                                      return managedSlots.map((entry) =>
                                        renderModeBadge(
                                          `mode-${entry.target}`,
                                          entry.mode,
                                          entry.target === "claude"
                                            ? "Claude: "
                                            : ".agents: ",
                                        ),
                                      );
                                    })()}
                                    {slotEntries
                                      .filter(
                                        (entry) =>
                                          entry.detachedAt != null ||
                                          entry.status !== "synced",
                                      )
                                      .map((entry) => {
                                        const isDetached = Boolean(
                                          entry.detachedAt,
                                        );
                                        const badge = isDetached
                                          ? {
                                              labelKey:
                                                "projects.status.detached",
                                              className:
                                                "border-dashed border-border bg-muted/60 text-muted-foreground",
                                            }
                                          : getStatusBadgeStyle(entry.status);
                                        const statusLabel =
                                          !isDetached &&
                                          entry.status === "conflict" &&
                                          entry.unknownBaseline
                                            ? t(
                                                "projects.status.conflictUnknownBaseline",
                                              )
                                            : t(badge.labelKey);
                                        const prefix =
                                          slotEntries.length > 1
                                            ? entry.target === "claude"
                                              ? "Claude: "
                                              : ".agents: "
                                            : "";

                                        return (
                                          <Badge
                                            key={entry.target}
                                            variant="outline"
                                            className={`h-5 px-1.5 py-0 text-[10px] leading-none ${badge.className}`}
                                          >
                                            {isDetached && (
                                              <Link2 className="mr-1 h-2.5 w-2.5" />
                                            )}
                                            {`${prefix}${statusLabel}`}
                                          </Badge>
                                        );
                                      })}
                                  </div>

                                  {row.description && (
                                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                      {row.description}
                                    </p>
                                  )}
                                </div>

                                <div className="flex shrink-0 items-center gap-2">
                                  {/* 异常 / 同步快捷操作（仅需要时出现） */}
                                  {slotEntries.map((entry) => {
                                    const isDetached = Boolean(
                                      entry.detachedAt,
                                    );
                                    const needsDiffReview =
                                      entry.status === "modified" ||
                                      entry.status === "conflict";
                                    const canPromote =
                                      !isDetached &&
                                      entry.target === "claude" &&
                                      !entry.isSymlink &&
                                      entry.diskExists &&
                                      entry.status !== "invalid_structure";

                                    return (
                                      <React.Fragment key={entry.target}>
                                        {isDetached && (
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            className="h-7 border-sky-500/30 bg-sky-500/10 text-xs text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
                                            onClick={() =>
                                              setDetachedDialog({
                                                row,
                                                target: entry.target,
                                                entry,
                                              })
                                            }
                                          >
                                            {t("projects.actions.rebindShort")}
                                          </Button>
                                        )}
                                        {!isDetached &&
                                          needsDiffReview &&
                                          entry.diskExists &&
                                          !entry.isSymlink &&
                                          entry.skillId && (
                                            <Button
                                              type="button"
                                              size="sm"
                                              variant="outline"
                                              className="h-7 border-amber-500/35 bg-amber-500/10 text-xs text-amber-800 hover:bg-amber-500/20 dark:text-amber-300"
                                              onClick={() =>
                                                setDiffSkill(entry)
                                              }
                                            >
                                              <FileDiff className="mr-1 h-3 w-3" />
                                              {t("projects.actions.reviewDiff")}
                                            </Button>
                                          )}
                                        {!isDetached &&
                                          !needsDiffReview &&
                                          entry.diskExists &&
                                          !entry.isSymlink &&
                                          entry.skillId && (
                                            <Button
                                              type="button"
                                              size="sm"
                                              variant="outline"
                                              className="h-7 text-xs"
                                              onClick={() =>
                                                setDiffSkill(entry)
                                              }
                                            >
                                              <FileDiff className="mr-1 h-3 w-3" />
                                              {t("projects.actions.diff")}
                                            </Button>
                                          )}
                                        {!isDetached &&
                                          entry.status === "outdated" &&
                                          entry.mode === "copy" && (
                                            <Button
                                              type="button"
                                              size="sm"
                                              variant="outline"
                                              className="h-7 border-sky-500/30 bg-sky-500/10 text-xs text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
                                              onClick={() =>
                                                void handleSingleUpdateFromGlobal(
                                                  entry,
                                                )
                                              }
                                            >
                                              <RefreshCw className="mr-1 h-3 w-3" />
                                              {t(
                                                "projects.actions.updateShort",
                                              )}
                                            </Button>
                                          )}
                                        {!isDetached &&
                                          (entry.status === "unmanaged" ||
                                            entry.status ===
                                              "same_content_unmanaged") &&
                                          entry.diskExists &&
                                          !entry.isSymlink && (
                                            <Button
                                              type="button"
                                              size="sm"
                                              variant="outline"
                                              className="h-7 border-violet-500/35 bg-violet-500/10 text-xs text-violet-700 hover:bg-violet-500/20 dark:text-violet-300"
                                              onClick={() =>
                                                void handlePushOrImport(
                                                  entry,
                                                  false,
                                                )
                                              }
                                            >
                                              <Download className="mr-1 h-3 w-3" />
                                              {t(
                                                "projects.actions.importToGlobal",
                                              )}
                                            </Button>
                                          )}
                                        {!isDetached &&
                                          entry.status === "source_missing" && (
                                            <Button
                                              type="button"
                                              size="sm"
                                              variant="outline"
                                              className="h-7 border-sky-500/30 bg-sky-500/10 text-xs text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
                                              onClick={() =>
                                                setAdoptOrRebind({
                                                  mode: "rebind",
                                                  skill: entry,
                                                })
                                              }
                                            >
                                              {t("projects.actions.rebind")}
                                            </Button>
                                          )}
                                        {canPromote && (
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            className="h-7 text-xs"
                                            onClick={() =>
                                              void handlePromote(entry)
                                            }
                                          >
                                            <ArrowUpRight className="mr-1 h-3 w-3" />
                                            {t("projects.actions.promote")}
                                          </Button>
                                        )}
                                        {entry.missingOnDisk && (
                                          <Button
                                            type="button"
                                            size="sm"
                                            variant="outline"
                                            className="h-7 border-rose-500/35 bg-rose-500/10 text-xs text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
                                            onClick={() =>
                                              void handleSettleMissing(entry)
                                            }
                                          >
                                            {t(
                                              "projects.actions.settleMissing",
                                            )}
                                          </Button>
                                        )}
                                      </React.Fragment>
                                    );
                                  })}

                                  {/* 右侧点亮式目标目录开关（通用 .agents + Claude） */}
                                  <div
                                    className={`flex items-center gap-1.5 ${
                                      hasSlotActions ? "border-l pl-2" : ""
                                    }`}
                                  >
                                    {renderTargetToggle(
                                      "agents",
                                      row.agentsEntry,
                                    )}
                                    {renderTargetToggle(
                                      "claude",
                                      row.claudeEntry,
                                    )}
                                  </div>
                                </div>
                              </div>

                              {(structureWarn ||
                                extraConflictTargets.length > 0) && (
                                <div className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                                  {structureWarn && (
                                    <div>⚠ 结构错误：{structureWarn}</div>
                                  )}
                                  {extraConflictTargets.length > 0 && (
                                    <div>
                                      ⚠ 存在与{" "}
                                      {extraConflictTargets.join("、")}{" "}
                                      同名冲突的 Skill
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </ScrollArea>
                </div>
              )}
            </>
          )}
        </main>

        {/* 对话框集合 */}
        <AddProjectDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          onAdded={(p) => setSelectedProjectId(p.id)}
        />
        <ProjectSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          project={activeProject}
        />
        <RelocateProjectDialog
          open={relocateOpen}
          onOpenChange={setRelocateOpen}
          project={activeProject}
        />
        <RemoveProjectDialog
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          project={activeProject}
          onRemoved={() => setSelectedProjectId(null)}
        />
        {activeProject && (
          <ProjectSkillDiffDialog
            open={Boolean(diffSkill)}
            onOpenChange={(open) => {
              if (!open) setDiffSkill(null);
            }}
            projectId={activeProject.id}
            skill={diffSkill}
          />
        )}
        {activeProject && adoptOrRebind && (
          <AdoptOrRebindDialog
            open={Boolean(adoptOrRebind)}
            onOpenChange={(open) => {
              if (!open) setAdoptOrRebind(null);
            }}
            projectId={activeProject.id}
            mode={adoptOrRebind.mode}
            skill={adoptOrRebind.skill}
          />
        )}
        <ConfirmDialog
          isOpen={Boolean(undeployConfirm)}
          title={t("projects.actions.undeploy")}
          message={`确认移除或取消托管 ${undeployConfirm?.target}/${undeployConfirm?.directory}？`}
          checkboxLabel={
            undeployConfirm?.isSymlink
              ? "同时拆除磁盘符号链接并清理托管的 .git/info/exclude 条目"
              : "同时删除项目磁盘上的该 Copy 目录（未修改的受管副本可安全删除）"
          }
          checkboxDefaultChecked={Boolean(undeployConfirm?.isSymlink)}
          pending={undeployMutation.isPending}
          onConfirm={(checked) => void handleConfirmUndeploy(checked)}
          onCancel={() => setUndeployConfirm(null)}
        />

        {/* 顶部全局切换「软链 / 副本」确认弹窗 */}
        <Dialog
          open={Boolean(modeSwitchConfirm)}
          onOpenChange={(open) => {
            if (!open && !convertingMode) setModeSwitchConfirm(null);
          }}
        >
          <DialogContent className="max-w-md" zIndex="nested">
            <DialogHeader>
              <DialogTitle>
                {modeSwitchConfirm?.targetMode === "symlink"
                  ? t("projects.modeSwitchDialog.titleToSymlink")
                  : t("projects.modeSwitchDialog.titleToCopy")}
              </DialogTitle>
              <DialogDescription>
                {modeSwitchConfirm
                  ? modeSwitchConfirm.convertibleCount === 0
                    ? t(
                        "projects.modeSwitchDialog.descriptionNoConvertOnlySkipped",
                      )
                    : modeSwitchConfirm.targetMode === "symlink"
                      ? t("projects.modeSwitchDialog.descriptionToSymlink", {
                          convertCount: modeSwitchConfirm.convertibleCount,
                        })
                      : t("projects.modeSwitchDialog.descriptionToCopy", {
                          convertCount: modeSwitchConfirm.convertibleCount,
                        })
                  : ""}
              </DialogDescription>
            </DialogHeader>

            {modeSwitchConfirm &&
              modeSwitchConfirm.skippedModifiedCount > 0 && (
                <div className="mx-6 rounded-md border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
                  {t("projects.modeSwitchDialog.skippedModifiedNotice", {
                    count: modeSwitchConfirm.skippedModifiedCount,
                  })}
                </div>
              )}

            <DialogFooter className="flex-col gap-2 sm:flex-col">
              {modeSwitchConfirm && modeSwitchConfirm.convertibleCount > 0 && (
                <Button
                  type="button"
                  className="w-full"
                  disabled={convertingMode || updateProjectMutation.isPending}
                  onClick={() => void executeModeSwitch(true)}
                >
                  {convertingMode && (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  )}
                  {t("projects.modeSwitchDialog.confirmConvert")}
                </Button>
              )}
              <Button
                type="button"
                variant={
                  modeSwitchConfirm && modeSwitchConfirm.convertibleCount > 0
                    ? "outline"
                    : "default"
                }
                className="w-full"
                disabled={convertingMode || updateProjectMutation.isPending}
                onClick={() => void executeModeSwitch(false)}
              >
                {t("projects.modeSwitchDialog.onlyChangeDefault")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                disabled={convertingMode}
                onClick={() => setModeSwitchConfirm(null)}
              >
                {t("common.cancel")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 已脱管（保留链接）处理弹窗 */}
        <Dialog
          open={Boolean(detachedDialog)}
          onOpenChange={(open) => {
            if (!open) setDetachedDialog(null);
          }}
        >
          <DialogContent className="max-w-md" zIndex="nested">
            <DialogHeader>
              <DialogTitle>{t("projects.detachedDialog.title")}</DialogTitle>
              <DialogDescription>
                {detachedDialog
                  ? t("projects.detachedDialog.description", {
                      directory: detachedDialog.entry.directory,
                      target:
                        detachedDialog.target === "claude"
                          ? ".claude/skills"
                          : ".agents/skills",
                    })
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col gap-2 sm:flex-col">
              <Button
                type="button"
                className="w-full"
                disabled={
                  rebindMutation.isPending || undeployMutation.isPending
                }
                onClick={() => void handleRebindDetached()}
              >
                {t("projects.detachedDialog.rebindGlobal")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full border-rose-500/35 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
                disabled={
                  rebindMutation.isPending || undeployMutation.isPending
                }
                onClick={() => void handleDeleteDetachedLink()}
              >
                {t("projects.detachedDialog.removeLink")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setDetachedDialog(null)}
              >
                {t("common.cancel")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* 移除 .agents 入口防 .claude relative_alias 悬空弹窗 */}
        <Dialog
          open={Boolean(aliasRemoveDialog)}
          onOpenChange={(open) => {
            if (!open) setAliasRemoveDialog(null);
          }}
        >
          <DialogContent className="max-w-md" zIndex="nested">
            <DialogHeader>
              <DialogTitle>{t("projects.aliasRemoveDialog.title")}</DialogTitle>
              <DialogDescription>
                {aliasRemoveDialog
                  ? t("projects.aliasRemoveDialog.description", {
                      directory: aliasRemoveDialog.agentsEntry.directory,
                    })
                  : ""}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="flex-col gap-2 sm:flex-col">
              <Button
                type="button"
                variant="outline"
                className="w-full border-rose-500/35 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
                disabled={
                  batchUndeployMutation.isPending ||
                  deployMutation.isPending ||
                  undeployMutation.isPending
                }
                onClick={() => void handleAliasRemoveChoice("both")}
              >
                {t("projects.aliasRemoveDialog.removeBoth")}
              </Button>
              {aliasRemoveDialog &&
                (aliasRemoveDialog.agentsEntry.skillId ||
                  aliasRemoveDialog.row.skill?.id) &&
                aliasRemoveDialog.agentsEntry.status !== "modified" &&
                aliasRemoveDialog.agentsEntry.status !== "conflict" && (
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full border-sky-500/30 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
                    disabled={
                      batchUndeployMutation.isPending ||
                      deployMutation.isPending ||
                      undeployMutation.isPending
                    }
                    onClick={() => void handleAliasRemoveChoice("keep_claude")}
                  >
                    {t("projects.aliasRemoveDialog.promoteClaude")}
                  </Button>
                )}
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={
                  batchUndeployMutation.isPending ||
                  deployMutation.isPending ||
                  undeployMutation.isPending
                }
                onClick={() => void handleAliasRemoveChoice("detach_agents")}
              >
                {t("projects.aliasRemoveDialog.detachAgents")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setAliasRemoveDialog(null)}
              >
                {t("common.cancel")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
};
