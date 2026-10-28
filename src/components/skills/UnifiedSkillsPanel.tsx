import React, { useMemo, useState } from "react";
import { useIsMutating } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Sparkles,
  Trash2,
  ExternalLink,
  RefreshCw,
  Loader2,
  Search,
  Eye,
  Download,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  type ImportSkillSelection,
  type SkillBackupEntry,
  useDeleteSkillBackup,
  useInstalledSkills,
  useSkillUsage,
  usePluginStates,
  useTogglePlugin,
  useSkillBackups,
  useRestoreSkillBackup,
  useBulkToggleSkillApp,
  useToggleSkillApp,
  useUninstallSkill,
  useScanUnmanagedSkills,
  useImportSkillsFromApps,
  useCreateLocalSkill,
  useInstallSkillsFromZip,
  useCheckSkillUpdates,
  useUpdateSkill,
  type InstalledSkill,
  type SkillUpdateInfo,
} from "@/hooks/useSkills";
import { useViewState } from "@/hooks/useViewState";
import type { AppId } from "@/lib/api/types";
import type { VisibleApps } from "@/types";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { settingsApi, skillsApi } from "@/lib/api";
import { toast } from "sonner";
import { APP_ICON_MAP, SKILLS_APP_IDS } from "@/config/appConfig";
import { AppCountBar } from "@/components/common/AppCountBar";
import { AppToggleGroup } from "@/components/common/AppToggleGroup";
import { ListItemRow } from "@/components/common/ListItemRow";
import { ManagementListSearch } from "@/components/common/ManagementListSearch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SkillDocumentPanel } from "./SkillDocumentPanel";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ImeSafeInput } from "@/components/ui/ime-safe-input";
import type {
  SkillUsageRange,
  SkillUsageSnapshot,
  SkillUsageSummary,
} from "@/lib/api/skills";
import { SkillUsageTrend } from "./SkillUsageTrend";
import { skillUsageColor, skillUsageTotals } from "@/lib/skillUsage";

const IMPORT_SKILLS_APP_IDS = SKILLS_APP_IDS.filter((app) => app !== "pi");

const getSkillSource = (skill: InstalledSkill) =>
  skill.repoOwner && skill.repoName
    ? `${skill.repoOwner}/${skill.repoName}`
    : "local";

interface UnifiedSkillsPanelProps {
  onOpenDiscovery: () => void;
  currentApp: AppId;
  visibleApps?: VisibleApps;
  onInteractionBlockedChange?: (blocked: boolean) => void;
  onNavigationBlockedChange?: (blocked: boolean) => void;
  onCheckUpdatesStateChange?: (state: SkillsCheckUpdatesState) => void;
}

export interface SkillsCheckUpdatesState {
  isChecking: boolean;
  hasSkills: boolean;
}

export interface UnifiedSkillsPanelHandle {
  openDiscovery: () => void;
  openImport: () => void;
  openCreate: () => void;
  openInstallFromZip: () => void;
  openRestoreFromBackup: () => void;
  checkUpdates: () => void;
}

/** Most recent use in the selected range as relative time, or "" when unused. */
function formatLastUsed(rows: { lastUsed: number }[], locale: string): string {
  const last = Math.max(0, ...rows.map((row) => row.lastUsed));
  if (!last) return "";
  const diff = last - Date.now() / 1000;
  const [unit, size] = (
    [
      ["day", 86400],
      ["hour", 3600],
      ["minute", 60],
    ] as const
  ).find(([, size]) => -diff >= size) ?? ["minute", 60];
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(diff / size),
    unit,
  );
}

function formatSkillBackupDate(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return Number.isNaN(date.getTime())
    ? String(unixSeconds)
    : date.toLocaleString();
}

const UnifiedSkillsPanel = React.forwardRef<
  UnifiedSkillsPanelHandle,
  UnifiedSkillsPanelProps
>((props, ref) => {
  const {
    onOpenDiscovery,
    currentApp,
    visibleApps,
    onInteractionBlockedChange,
    onNavigationBlockedChange,
    onCheckUpdatesStateChange,
  } = props;
  const { t, i18n } = useTranslation();
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    confirmText?: string;
    variant?: "destructive" | "info";
    onConfirm: () => void;
  } | null>(null);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [previewSkill, setPreviewSkill] = useState<InstalledSkill | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editPreview, setEditPreview] = useState(false);
  const [searchQuery, setSearchQuery] = useViewState("skills.search", "");
  const [expandedPlugins, setExpandedPlugins] = useState<Set<string>>(
    () => new Set(),
  );
  // "all" | "local" | "owner/repo"
  const [sourceFilter, setSourceFilter] = useViewState("skills.source", "all");
  const [sortOrder, setSortOrder] = useViewState("skills.sort", "name");
  const [usageRange, setUsageRange] = useViewState<SkillUsageRange>(
    "skills.usageRange",
    "day",
  );
  const usage = useSkillUsage();
  const pluginStates = usePluginStates();
  const togglePlugin = useTogglePlugin();
  const usageSnapshot = usage.data?.snapshots?.[usageRange];
  const usageError = usage.isError || !!usage.data?.status.error;
  const [writePending, setWritePending] = useState(false);
  const writeLockRef = React.useRef(false);
  const checkUpdatesLockRef = React.useRef(false);

  const { data: skills, isLoading } = useInstalledSkills();
  const {
    data: skillBackups = [],
    refetch: refetchSkillBackups,
    isFetching: isFetchingSkillBackups,
  } = useSkillBackups();
  const deleteBackupMutation = useDeleteSkillBackup();
  const toggleAppMutation = useToggleSkillApp();
  const bulkToggleAppMutation = useBulkToggleSkillApp();
  const uninstallMutation = useUninstallSkill();
  const restoreBackupMutation = useRestoreSkillBackup();
  // enabled: true —— 进入 Skill 页面时自动静默扫描一次（绿点提示来源）
  const { data: unmanagedSkills, refetch: scanUnmanaged } =
    useScanUnmanagedSkills({ enabled: true });
  const importMutation = useImportSkillsFromApps();
  const createMutation = useCreateLocalSkill();
  const installFromZipMutation = useInstallSkillsFromZip();
  const { data: skillUpdates, refetch: checkUpdates } = useCheckSkillUpdates();
  // 只有手动检查才锁界面；App 启动/定时的后台检查共用同一查询，不能拿 isFetching 判断
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const updateSkillMutation = useUpdateSkill();
  const [isUpdatingAll, setIsUpdatingAll] = useState(false);
  const visibleSkillAppIds = visibleApps
    ? SKILLS_APP_IDS.filter((app) =>
        app === "claude"
          ? visibleApps.claude || visibleApps["claude-desktop"]
          : visibleApps[app],
      )
    : currentApp === "pi"
      ? SKILLS_APP_IDS
      : IMPORT_SKILLS_APP_IDS;

  const skillsWritePending =
    useIsMutating({ mutationKey: ["skills", "write"] }) > 0;
  const mutationPending =
    skillsWritePending ||
    deleteBackupMutation.isPending ||
    toggleAppMutation.isPending ||
    bulkToggleAppMutation.isPending ||
    uninstallMutation.isPending ||
    restoreBackupMutation.isPending ||
    importMutation.isPending ||
    createMutation.isPending ||
    installFromZipMutation.isPending ||
    updateSkillMutation.isPending ||
    isUpdatingAll;
  const dialogOpen =
    importDialogOpen ||
    createDialogOpen ||
    restoreDialogOpen ||
    confirmDialog !== null ||
    previewSkill !== null;
  const navigationBlocked = writePending || mutationPending || dialogOpen;
  const interactionBlocked = navigationBlocked || isCheckingUpdates;

  React.useEffect(() => {
    onInteractionBlockedChange?.(interactionBlocked);
  }, [interactionBlocked, onInteractionBlockedChange]);

  React.useEffect(() => {
    onNavigationBlockedChange?.(navigationBlocked);
  }, [navigationBlocked, onNavigationBlockedChange]);

  React.useEffect(
    () => () => {
      onInteractionBlockedChange?.(false);
      onNavigationBlockedChange?.(false);
    },
    [onInteractionBlockedChange, onNavigationBlockedChange],
  );

  const hasSkills = (skills?.length ?? 0) > 0;

  React.useEffect(() => {
    onCheckUpdatesStateChange?.({
      isChecking: isCheckingUpdates,
      hasSkills,
    });
  }, [hasSkills, isCheckingUpdates, onCheckUpdatesStateChange]);

  React.useEffect(
    () => () =>
      onCheckUpdatesStateChange?.({ isChecking: false, hasSkills: false }),
    [onCheckUpdatesStateChange],
  );

  const beginWrite = (allowOpenDialog = false) => {
    if (
      checkUpdatesLockRef.current ||
      isCheckingUpdates ||
      writeLockRef.current ||
      mutationPending ||
      (!allowOpenDialog && dialogOpen)
    ) {
      return false;
    }
    writeLockRef.current = true;
    setWritePending(true);
    return true;
  };

  const endWrite = () => {
    writeLockRef.current = false;
    setWritePending(false);
  };

  const applicableSkillUpdates = useMemo(() => {
    const installedIds = new Set((skills ?? []).map((skill) => skill.id));
    return (skillUpdates ?? []).filter((update) => installedIds.has(update.id));
  }, [skillUpdates, skills]);

  const updatesMap = useMemo(() => {
    const map: Record<string, SkillUpdateInfo> = {};
    for (const update of applicableSkillUpdates) {
      map[update.id] = update;
    }
    return map;
  }, [applicableSkillUpdates]);

  const repoSources = useMemo(
    () =>
      [
        ...new Set(
          (skills ?? []).map(getSkillSource).filter((s) => s !== "local"),
        ),
      ].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })),
    [skills],
  );
  const hasLocalSkills = (skills ?? []).some(
    (skill) => getSkillSource(skill) === "local",
  );
  // Plugin Skills come back from the backend as `plugin:skill`; they have no group.
  const allPluginSkillNames = useMemo(() => {
    const names = new Set<string>();
    for (const snapshot of Object.values(usage.data?.snapshots ?? {})) {
      for (const name of [
        ...Object.keys(snapshot.pluginSkills ?? {}),
        ...snapshot.records.map((record) => record.skillName),
      ]) {
        if (name.includes(":")) names.add(name);
      }
    }
    return names;
  }, [usage.data?.snapshots]);
  // 选中的仓库被卸载干净后回落到全部，避免列表莫名为空
  const activeSourceFilter =
    sourceFilter === "plugins"
      ? allPluginSkillNames.size
        ? "plugins"
        : "all"
      : sourceFilter === "local"
        ? hasLocalSkills
          ? "local"
          : "all"
        : repoSources.includes(sourceFilter)
          ? sourceFilter
          : "all";

  const filteredSkills = useMemo(() => {
    if (!skills || activeSourceFilter === "plugins") return [];

    const sourceSkills =
      activeSourceFilter === "all"
        ? skills
        : skills.filter(
            (skill) => getSkillSource(skill) === activeSourceFilter,
          );
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return sourceSkills;

    return sourceSkills.filter((skill) => {
      const searchableValues = [
        skill.name,
        skill.id,
        skill.description,
        skill.directory,
        skill.repoOwner,
        skill.repoName,
        skill.repoOwner && skill.repoName
          ? `${skill.repoOwner}/${skill.repoName}`
          : undefined,
      ];

      return searchableValues.some((value) =>
        value?.toLocaleLowerCase().includes(query),
      );
    });
  }, [activeSourceFilter, searchQuery, skills]);

  // 计数和批量开关都只作用于当前筛选结果
  const enabledCounts = useMemo(() => {
    const counts = {
      claude: 0,
      "claude-desktop": 0,
      codex: 0,
      gemini: 0,
      grokbuild: 0,
      opencode: 0,
      openclaw: 0,
      hermes: 0,
      pi: 0,
      mcode: 0,
    };
    filteredSkills.forEach((skill) => {
      for (const app of SKILLS_APP_IDS) {
        if (skill.apps[app]) {
          counts[app]++;
        }
      }
    });
    return counts;
  }, [filteredSkills]);

  const usageRecords = useMemo(() => {
    const grouped = new Map<string, SkillUsageSummary[]>();
    for (const record of usageSnapshot?.records ?? []) {
      const rows = grouped.get(record.skillName) ?? [];
      rows.push(record);
      rows.sort((a, b) => a.app.localeCompare(b.app));
      grouped.set(record.skillName, rows);
    }
    return grouped;
  }, [usageSnapshot]);

  const sortedSkills = useMemo(() => {
    const counts = new Map(
      [...usageRecords].map(([name, rows]) => [
        name,
        rows.reduce((sum, row) => sum + row.count, 0),
      ]),
    );
    return [...filteredSkills].sort((a, b) => {
      if (sortOrder === "usage") {
        const countDifference =
          (counts.get(b.directory.split(/[\\/]/).pop() ?? "") ?? 0) -
          (counts.get(a.directory.split(/[\\/]/).pop() ?? "") ?? 0);
        if (countDifference) return countDifference;
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }, [filteredSkills, sortOrder, usageRecords]);

  // Descriptions keyed by `plugin` and `plugin:skill`.
  const { pluginDescriptions, pluginSources } = useMemo(() => {
    const descriptions: Record<string, string> = {};
    const sources: NonNullable<SkillUsageSnapshot["pluginSources"]> = {};
    for (const snapshot of Object.values(usage.data?.snapshots ?? {})) {
      Object.assign(
        descriptions,
        snapshot.pluginDescriptions,
        snapshot.pluginSkills,
      );
      Object.assign(sources, snapshot.pluginSources);
    }
    return { pluginDescriptions: descriptions, pluginSources: sources };
  }, [usage.data?.snapshots]);
  const pluginSkillNames = useMemo(() => {
    if (activeSourceFilter !== "all" && activeSourceFilter !== "plugins")
      return new Set<string>();
    const query = searchQuery.trim().toLocaleLowerCase();
    return new Set(
      [...allPluginSkillNames].filter((name) =>
        [name, pluginDescriptions[name]].some((value) =>
          value?.toLocaleLowerCase().includes(query),
        ),
      ),
    );
  }, [
    activeSourceFilter,
    allPluginSkillNames,
    pluginDescriptions,
    searchQuery,
  ]);
  // One group per plugin; unused Skills stay listed with 0.
  const pluginUsageGroups = useMemo(() => {
    const groups = new Map<
      string,
      { name: string; rows: SkillUsageSummary[]; count: number }[]
    >();
    for (const name of pluginSkillNames) {
      const rows = usageRecords.get(name) ?? [];
      const plugin = name.split(":")[0];
      const skills = groups.get(plugin) ?? [];
      skills.push({
        name,
        rows,
        count: rows.reduce((sum, row) => sum + row.count, 0),
      });
      groups.set(plugin, skills);
    }
    return [...groups]
      .map(([plugin, skills]) => ({
        plugin,
        skills: skills.sort(
          (a, b) => b.count - a.count || a.name.localeCompare(b.name),
        ),
        rows: skills.flatMap((skill) => skill.rows),
        count: skills.reduce((sum, skill) => sum + skill.count, 0),
      }))
      .sort((a, b) => b.count - a.count || a.plugin.localeCompare(b.plugin));
  }, [pluginSkillNames, usageRecords]);

  const usageSkillNames = useMemo(
    () =>
      new Set([
        ...filteredSkills.map(
          (skill) => skill.directory.split(/[\\/]/).pop() ?? "",
        ),
        ...pluginSkillNames,
      ]),
    [filteredSkills, pluginSkillNames],
  );
  const usageTotal = (snapshot?: SkillUsageSnapshot) => {
    const totals = skillUsageTotals(snapshot, usageSkillNames);
    return totals
      ? Object.values(totals).reduce((sum, count) => sum + count, 0)
      : undefined;
  };
  const agentUsageTotals = skillUsageTotals(usageSnapshot, usageSkillNames);
  const agentUsageLabel = (app: AppId) => {
    if (!(app in skillUsageColor)) return "—";
    return agentUsageTotals
      ? t("skills.usage.callCount", { count: agentUsageTotals[app] ?? 0 })
      : "…";
  };

  const pendingApp = bulkToggleAppMutation.isPending
    ? bulkToggleAppMutation.variables?.app
    : toggleAppMutation.isPending
      ? toggleAppMutation.variables?.app
      : null;

  const handleToggleApp = async (id: string, app: AppId, enabled: boolean) => {
    if (!beginWrite()) return;

    try {
      await toggleAppMutation.mutateAsync({ id, app, enabled });
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  const handleToggleAll = async (app: AppId, enabled: boolean) => {
    if (!skills || !beginWrite()) return;

    const ids = filteredSkills
      .filter((skill) => Boolean(skill.apps[app]) !== enabled)
      .map((skill) => skill.id);
    if (ids.length === 0) {
      endWrite();
      return;
    }

    try {
      const result = await bulkToggleAppMutation.mutateAsync({
        ids,
        app,
        enabled,
      });
      if (result.failed.length > 0) {
        toast.error(
          t("common.bulkToggleFailed", { count: result.failed.length }),
          { description: String(result.failed[0].error) },
        );
      }
    } catch (error) {
      toast.error(t("common.bulkToggleFailed", { count: ids.length }), {
        description: String(error),
      });
    } finally {
      endWrite();
    }
  };

  const handleUninstall = (skill: InstalledSkill) => {
    if (
      checkUpdatesLockRef.current ||
      writeLockRef.current ||
      interactionBlocked
    ) {
      return;
    }
    setConfirmDialog({
      isOpen: true,
      title: t("skills.uninstall"),
      message: t("skills.uninstallConfirm", { name: skill.name }),
      onConfirm: async () => {
        if (!beginWrite(true)) return;
        try {
          const result = await uninstallMutation.mutateAsync(skill.id);
          setConfirmDialog(null);
          const piCleanupIncomplete =
            result.piCleanupIncomplete || Boolean(result.preservedPiPath);
          const toastOptions = {
            description: result.preservedPiPath
              ? t("skills.uninstallPiPreserved", {
                  path: result.preservedPiPath,
                })
              : result.piCleanupIncomplete
                ? t("skills.uninstallPiCleanupIncomplete")
                : result.backupPath
                  ? t("skills.backup.location", { path: result.backupPath })
                  : undefined,
            closeButton: true,
          };
          if (piCleanupIncomplete) {
            toast.warning(
              t("skills.uninstallSuccess", { name: skill.name }),
              toastOptions,
            );
          } else {
            toast.success(
              t("skills.uninstallSuccess", { name: skill.name }),
              toastOptions,
            );
          }
        } catch (error) {
          toast.error(t("common.error"), { description: String(error) });
        } finally {
          endWrite();
        }
      },
    });
  };

  const handleOpenImport = async () => {
    if (!beginWrite()) return;
    try {
      const result = await scanUnmanaged();
      if (!result.data || result.data.length === 0) {
        toast.success(t("skills.noUnmanagedFound"), { closeButton: true });
        return;
      }
      setImportDialogOpen(true);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  const handleImport = async (imports: ImportSkillSelection[]) => {
    if (!beginWrite(true)) return;
    try {
      const imported = await importMutation.mutateAsync(imports);
      setImportDialogOpen(false);
      toast.success(t("skills.importSuccess", { count: imported.length }), {
        closeButton: true,
      });
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  const handleInstallFromZip = async () => {
    if (!beginWrite()) return;
    try {
      const filePath = await skillsApi.openZipFileDialog();
      if (!filePath) return;

      const installed = await installFromZipMutation.mutateAsync({
        filePath,
        currentApp,
      });

      if (installed.length === 0) {
        toast.info(t("skills.installFromZip.noSkillsFound"), {
          closeButton: true,
        });
      } else if (installed.length === 1) {
        toast.success(
          t("skills.installFromZip.successSingle", {
            name: installed[0].name,
          }),
          { closeButton: true },
        );
      } else {
        toast.success(
          t("skills.installFromZip.successMultiple", {
            count: installed.length,
          }),
          { closeButton: true },
        );
      }
    } catch (error) {
      toast.error(t("skills.installFailed"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  const handleCheckUpdates = async () => {
    if (
      checkUpdatesLockRef.current ||
      writeLockRef.current ||
      interactionBlocked
    ) {
      return;
    }
    checkUpdatesLockRef.current = true;
    setIsCheckingUpdates(true);
    try {
      const result = await checkUpdates();
      const updates = result.data || [];
      if (updates.length === 0) {
        toast.success(t("skills.noUpdates"), { closeButton: true });
      } else {
        toast.info(t("skills.updatesFound", { count: updates.length }), {
          closeButton: true,
        });
      }
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      checkUpdatesLockRef.current = false;
      setIsCheckingUpdates(false);
    }
  };

  const handleUpdateSkill = async (skill: InstalledSkill) => {
    if (!beginWrite()) return;
    try {
      const updated = await updateSkillMutation.mutateAsync(skill.id);
      toast.success(t("skills.updateSuccess", { name: updated.name }), {
        closeButton: true,
      });
    } catch (error) {
      toast.error(t("skills.updateFailed"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  const handleUpdateAll = async () => {
    if (applicableSkillUpdates.length === 0 || !beginWrite()) {
      return;
    }
    setIsUpdatingAll(true);
    let successCount = 0;
    try {
      for (const update of applicableSkillUpdates) {
        try {
          await updateSkillMutation.mutateAsync(update.id);
          successCount++;
        } catch (error) {
          toast.error(t("skills.updateFailed"), {
            description: `${update.name}: ${String(error)}`,
          });
        }
      }
    } finally {
      setIsUpdatingAll(false);
      endWrite();
    }
    if (successCount > 0) {
      toast.success(t("skills.updateAllSuccess", { count: successCount }), {
        closeButton: true,
      });
    }
  };

  const handleCreate = async (directory: string, description: string) => {
    if (!beginWrite(true)) return;
    try {
      const skill = await createMutation.mutateAsync({
        directory,
        description,
      });
      setCreateDialogOpen(false);
      setEditPreview(true);
      setPreviewSkill(skill);
    } catch (error) {
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  const handleOpenRestoreFromBackup = async () => {
    if (!beginWrite()) return;
    setRestoreDialogOpen(true);
    try {
      await refetchSkillBackups({ throwOnError: true });
    } catch (error) {
      setRestoreDialogOpen(false);
      toast.error(t("common.error"), { description: String(error) });
    } finally {
      endWrite();
    }
  };

  const handleRestoreFromBackup = async (backupId: string) => {
    if (!beginWrite(true)) return;
    try {
      const restored = await restoreBackupMutation.mutateAsync({
        backupId,
        currentApp,
      });
      setRestoreDialogOpen(false);
      toast.success(
        t("skills.restoreFromBackup.success", { name: restored.name }),
        {
          closeButton: true,
        },
      );
    } catch (error) {
      toast.error(t("skills.restoreFromBackup.failed"), {
        description: String(error),
      });
    } finally {
      endWrite();
    }
  };

  const handleDeleteBackup = (backup: SkillBackupEntry) => {
    if (checkUpdatesLockRef.current || writeLockRef.current) return;
    setConfirmDialog({
      isOpen: true,
      title: t("skills.restoreFromBackup.deleteConfirmTitle"),
      message: t("skills.restoreFromBackup.deleteConfirmMessage", {
        name: backup.skill.name,
      }),
      confirmText: t("skills.restoreFromBackup.delete"),
      variant: "destructive",
      onConfirm: async () => {
        if (!beginWrite(true)) return;
        try {
          let deleteSucceeded = false;
          let deleteError: unknown;
          try {
            await deleteBackupMutation.mutateAsync(backup.backupId);
            deleteSucceeded = true;
          } catch (error) {
            deleteError = error;
          }

          // The backups query is disabled by default, so invalidation alone
          // does not fetch authoritative data. Explicitly refresh after both
          // success and failure (remove_dir_all may have made partial progress).
          let refreshedBackups: SkillBackupEntry[] | undefined;
          try {
            const result = await refetchSkillBackups({ throwOnError: true });
            refreshedBackups = result.data;
          } catch (error) {
            // A refresh failure must not turn a completed deletion into a false
            // "delete failed" report, or replace the original deletion error.
            console.error(
              "Failed to refresh Skill backups after deletion:",
              error,
            );
          }

          if (!deleteSucceeded) {
            // remove_dir_all may finish removing the directory but still
            // report an error. If the authoritative refresh confirms that the
            // item is gone, close the now-stale confirmation dialog.
            if (
              refreshedBackups &&
              !refreshedBackups.some(
                (entry) => entry.backupId === backup.backupId,
              )
            ) {
              setConfirmDialog(null);
            }
            toast.error(t("skills.restoreFromBackup.deleteFailed"), {
              description: String(deleteError),
            });
          } else {
            setConfirmDialog(null);
            toast.success(
              t("skills.restoreFromBackup.deleteSuccess", {
                name: backup.skill.name,
              }),
              {
                closeButton: true,
              },
            );
          }
        } finally {
          endWrite();
        }
      },
    });
  };

  const handleOpenDiscovery = () => {
    if (
      !checkUpdatesLockRef.current &&
      !writeLockRef.current &&
      !interactionBlocked
    ) {
      onOpenDiscovery();
    }
  };

  React.useImperativeHandle(ref, () => ({
    openDiscovery: handleOpenDiscovery,
    openImport: handleOpenImport,
    openCreate: () => {
      if (beginWrite()) {
        setCreateDialogOpen(true);
        endWrite();
      }
    },
    openInstallFromZip: handleInstallFromZip,
    openRestoreFromBackup: handleOpenRestoreFromBackup,
    checkUpdates: handleCheckUpdates,
  }));

  return (
    <div className="px-6 flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <AppCountBar
            totalLabel=""
            leading={
              <div className="flex shrink-0 items-center gap-2">
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {t("skills.usage.title")}
                </span>
                <div
                  className="inline-flex gap-0.5 rounded-lg border border-border/50 bg-muted/50 p-1"
                  role="group"
                  aria-label={t("skills.usage.range")}
                >
                  {(["day", "week"] as const).map((range) => (
                    <button
                      key={range}
                      type="button"
                      aria-pressed={usageRange === range}
                      onClick={() => setUsageRange(range)}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs transition-colors",
                        usageRange === range
                          ? "bg-blue-50 font-medium text-blue-700 ring-1 ring-inset ring-blue-200 dark:bg-blue-500/15 dark:text-blue-300 dark:ring-blue-500/30"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t(
                        range === "day"
                          ? "skills.usage.today"
                          : "skills.usage.week",
                      )}{" "}
                      <span
                        className={cn(
                          "font-medium tabular-nums",
                          usageRange !== range && "text-foreground",
                        )}
                      >
                        {usageTotal(usage.data?.snapshots?.[range]) ?? "…"}
                      </span>{" "}
                      {t("skills.usage.times")}
                    </button>
                  ))}
                </div>
              </div>
            }
            countsLabel={
              <span className="flex flex-col items-start text-[11px]">
                <span>{t("skills.usage.enabledTitle")}</span>
                <span>/ {t("skills.usage.callsTitle")}</span>
              </span>
            }
            formatCount={(app, count) => (
              <>
                <span>{t("skills.usage.enabledCount", { count })}</span>
                <span className="font-normal text-muted-foreground/60">/</span>
                <span>{agentUsageLabel(app)}</span>
              </>
            )}
            getCountDescription={(app, count) =>
              [
                t("skills.usage.enabledForApp", {
                  app: APP_ICON_MAP[app].label,
                  count,
                }),
                t(
                  usageRange === "day"
                    ? "skills.usage.today"
                    : "skills.usage.week",
                ) +
                  ": " +
                  agentUsageLabel(app),
              ].join("\n")
            }
            counts={enabledCounts}
            appIds={visibleSkillAppIds}
            totalCount={filteredSkills.length}
            onToggleAll={handleToggleAll}
            pendingApp={pendingApp}
            disabled={interactionBlocked}
          />
        </div>
        <div
          className="mb-4 overflow-hidden transition-all duration-300 ease-out"
          style={{
            maxWidth: applicableSkillUpdates.length > 0 ? "200px" : "0px",
            opacity: applicableSkillUpdates.length > 0 ? 1 : 0,
          }}
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs gap-1 whitespace-nowrap disabled:opacity-100"
            onClick={handleUpdateAll}
            disabled={interactionBlocked}
          >
            {isUpdatingAll ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RefreshCw size={12} />
            )}
            {isUpdatingAll
              ? t("skills.updatingAll")
              : t("skills.updateAll", {
                  count: applicableSkillUpdates.length,
                })}
          </Button>
        </div>
      </div>

      <div className="mb-4 flex flex-shrink-0 flex-wrap items-center gap-2">
        <ManagementListSearch
          value={searchQuery}
          onValueChange={setSearchQuery}
          placeholder={t("skills.installedSearchPlaceholder")}
          ariaLabel={t("skills.installedSearchAriaLabel")}
          clearLabel={t("common.clear")}
          className="mb-0 min-w-48 flex-1"
        />
        <Select value={activeSourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger
            aria-label={t("skills.filter.repo")}
            className="w-44 shrink-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-64">
            <SelectItem value="all">
              {t("skills.usage.allSources", { count: skills?.length ?? 0 })}
            </SelectItem>
            {hasLocalSkills && (
              <SelectItem value="local">
                {t("skills.local")}（
                {
                  skills?.filter((skill) => getSkillSource(skill) === "local")
                    .length
                }
                ）
              </SelectItem>
            )}
            {allPluginSkillNames.size > 0 && (
              <SelectItem value="plugins">
                {t("skills.usage.pluginSkills")}（{allPluginSkillNames.size}）
              </SelectItem>
            )}
            {repoSources.map((source) => (
              <SelectItem key={source} value={source}>
                {source}（
                {
                  skills?.filter((skill) => getSkillSource(skill) === source)
                    .length
                }
                ）
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={sortOrder} onValueChange={setSortOrder}>
          <SelectTrigger
            aria-label={t("skills.usage.sort")}
            className="w-32 shrink-0"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name">{t("skills.usage.sortName")}</SelectItem>
            <SelectItem value="usage">{t("skills.usage.sortUsage")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {usageError && (
        <p
          role="alert"
          className="mb-2 shrink-0 text-xs text-amber-700 dark:text-amber-400"
        >
          {t("skills.usage.incomplete")}
        </p>
      )}

      <ScrollArea className="-mr-3 flex-1 min-h-0" type="auto">
        <div className="pb-24 pr-3">
          {isLoading ? (
            <div className="text-center py-12 text-muted-foreground">
              {t("skills.loading")}
            </div>
          ) : !skills || skills.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 bg-muted rounded-full flex items-center justify-center">
                <Sparkles size={24} className="text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium text-foreground mb-2">
                {t("skills.noInstalled")}
              </h3>
              <p className="text-muted-foreground text-sm">
                {t("skills.noInstalledDescription")}
              </p>
              {/* 导入已有收进了工具栏的添加菜单，空列表时直接给出首次使用的两个入口 */}
              <div className="mt-4 flex justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={interactionBlocked}
                  onClick={() => void handleOpenImport()}
                >
                  <Download className="w-4 h-4" />
                  {t("skills.import")}
                </Button>
                <Button
                  size="sm"
                  disabled={interactionBlocked}
                  onClick={handleOpenDiscovery}
                >
                  <Sparkles className="w-4 h-4" />
                  {t("skills.discover")}
                </Button>
              </div>
            </div>
          ) : filteredSkills.length === 0 ? (
            pluginUsageGroups.length > 0 ? null : (
              <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                <Search className="mb-4 h-10 w-10 opacity-40" />
                <p className="text-sm">
                  {t("skills.noInstalledSearchResults")}
                </p>
              </div>
            )
          ) : (
            <TooltipProvider delayDuration={300}>
              <div className="rounded-xl border border-border-default overflow-hidden">
                {sortedSkills.map((skill, index) => (
                  <InstalledSkillListItem
                    key={skill.id}
                    skill={skill}
                    hasUpdate={!!updatesMap[skill.id]}
                    isUpdating={
                      updateSkillMutation.isPending &&
                      updateSkillMutation.variables === skill.id
                    }
                    actionsDisabled={interactionBlocked}
                    appIds={visibleSkillAppIds}
                    usageRecords={
                      usageRecords.get(
                        skill.directory.split(/[\\/]/).pop() ?? "",
                      ) ?? []
                    }
                    usageRange={usageRange}
                    usageBoundaries={usage.boundaries[usageRange]}
                    usageStatus={
                      usageSnapshot ??
                      (usageError
                        ? { completed: false, error: "unavailable" }
                        : usage.data?.status)
                    }
                    onToggleApp={handleToggleApp}
                    onUninstall={() => handleUninstall(skill)}
                    onPreview={() => setPreviewSkill(skill)}
                    onUpdate={() => handleUpdateSkill(skill)}
                    isLast={index === sortedSkills.length - 1}
                  />
                ))}
              </div>
            </TooltipProvider>
          )}
          {pluginUsageGroups.length > 0 && (
            <div className={cn(filteredSkills.length > 0 && "mt-4")}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                {t("skills.usage.pluginSkills")}
              </h3>
              <div className="space-y-2">
                {pluginUsageGroups.map((group) => {
                  // A plugin with one Skill is a plain row; there is nothing to expand.
                  const single =
                    group.skills.length === 1 ? group.skills[0].name : null;
                  const shortName = single?.split(":").slice(1).join(":");
                  // Searching opens groups so matching Skills are visible.
                  const expanded =
                    !single &&
                    (!!searchQuery.trim() || expandedPlugins.has(group.plugin));
                  const sources = pluginSources[group.plugin] ?? [];
                  const tag = [
                    shortName !== undefined &&
                      shortName !== group.plugin &&
                      group.plugin,
                    ...new Set(sources.map((source) => source.marketplace)),
                    ...new Set(sources.map((source) => source.version)),
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  const commands = Math.max(
                    0,
                    ...sources.map((source) => source.commands),
                  );
                  const description =
                    (single && pluginDescriptions[single]) ||
                    pluginDescriptions[group.plugin];
                  const heading = (
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="font-medium text-sm text-foreground truncate">
                          {shortName ?? group.plugin}
                        </span>
                        <span className="text-xs text-muted-foreground/50 truncate">
                          {[
                            tag,
                            !single &&
                              t("skills.usage.pluginSkillCount", {
                                count: group.skills.length,
                              }),
                            commands > 0 &&
                              t("skills.usage.pluginCommandCount", {
                                count: commands,
                              }),
                            formatLastUsed(group.rows, i18n.language),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </span>
                      {description && (
                        <span
                          className="block text-xs text-muted-foreground truncate"
                          title={description}
                        >
                          {description}
                        </span>
                      )}
                    </span>
                  );
                  return (
                    <div
                      key={group.plugin}
                      className="rounded-xl border border-border-default overflow-hidden"
                    >
                      <ListItemRow isLast={!expanded}>
                        {single ? (
                          <div className="flex-1 min-w-0 flex items-center gap-1.5">
                            <span className="w-4 flex-shrink-0" />
                            {heading}
                          </div>
                        ) : (
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() =>
                              setExpandedPlugins((current) => {
                                const next = new Set(current);
                                if (!next.delete(group.plugin))
                                  next.add(group.plugin);
                                return next;
                              })
                            }
                            className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                          >
                            <ChevronRight
                              className={cn(
                                "h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform",
                                expanded && "rotate-90",
                              )}
                            />
                            {heading}
                          </button>
                        )}
                        <div className="flex flex-shrink-0 items-center gap-1">
                          {sources.map(({ app, marketplace }) => {
                            const id = `${group.plugin}@${marketplace}`;
                            const enabled = pluginStates.data?.[app]?.[id];
                            const label = APP_ICON_MAP[app]?.label ?? app;
                            return (
                              <button
                                key={`${app}:${marketplace}`}
                                type="button"
                                aria-pressed={!!enabled}
                                disabled={
                                  enabled === undefined ||
                                  togglePlugin.isPending
                                }
                                title={t(
                                  enabled === undefined
                                    ? "skills.usage.pluginNotInstalled"
                                    : enabled
                                      ? "skills.usage.pluginEnabledIn"
                                      : "skills.usage.pluginDisabledIn",
                                  { app: label },
                                )}
                                onClick={() =>
                                  togglePlugin.mutate(
                                    { app, id, enabled: !enabled },
                                    {
                                      onSuccess: () =>
                                        toast.success(
                                          t("skills.usage.pluginToggled", {
                                            app: label,
                                          }),
                                          { closeButton: true },
                                        ),
                                      onError: (error) =>
                                        toast.error(t("common.error"), {
                                          description: String(error),
                                        }),
                                    },
                                  )
                                }
                                className={cn(
                                  "rounded-md p-1 transition-opacity disabled:cursor-default",
                                  enabled
                                    ? "text-foreground"
                                    : "opacity-30 grayscale hover:opacity-60",
                                )}
                              >
                                {APP_ICON_MAP[app]?.icon}
                              </button>
                            );
                          })}
                        </div>
                        <SkillUsageTrend
                          records={group.rows}
                          boundaries={usage.boundaries[usageRange]}
                          range={usageRange}
                          hoveredApp={null}
                          status={usageSnapshot}
                        />
                      </ListItemRow>
                      {expanded && (
                        <div className="bg-muted/30">
                          {group.skills.map(({ name, rows }, index) => (
                            <ListItemRow
                              key={name}
                              isLast={index === group.skills.length - 1}
                            >
                              <div className="ml-6 flex-1 min-w-0 self-stretch flex items-center gap-2 border-l border-border-default pl-3">
                                <span className="text-sm text-foreground flex-shrink-0">
                                  {name.split(":").slice(1).join(":")}
                                </span>
                                {pluginDescriptions[name] && (
                                  <span
                                    className="min-w-0 truncate text-xs text-muted-foreground/70"
                                    title={pluginDescriptions[name]}
                                  >
                                    {pluginDescriptions[name]}
                                  </span>
                                )}
                                <span className="ml-auto text-xs text-muted-foreground/50 flex-shrink-0">
                                  {formatLastUsed(rows, i18n.language)}
                                </span>
                              </div>
                              <SkillUsageTrend
                                records={rows}
                                boundaries={usage.boundaries[usageRange]}
                                range={usageRange}
                                hoveredApp={null}
                                status={usageSnapshot}
                              />
                            </ListItemRow>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {confirmDialog && (
        <ConfirmDialog
          isOpen={confirmDialog.isOpen}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmText={confirmDialog.confirmText}
          variant={confirmDialog.variant}
          zIndex="top"
          pending={writePending}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {importDialogOpen && unmanagedSkills && (
        <ImportSkillsDialog
          skills={unmanagedSkills}
          appIds={visibleSkillAppIds.filter((app) => app !== "pi")}
          isImporting={importMutation.isPending}
          onImport={handleImport}
          onClose={() => setImportDialogOpen(false)}
        />
      )}

      {previewSkill && (
        <SkillDocumentPanel
          key={previewSkill.id}
          skill={previewSkill}
          startEditing={editPreview}
          onClose={() => {
            setPreviewSkill(null);
            setEditPreview(false);
          }}
        />
      )}

      {createDialogOpen && (
        <CreateSkillDialog
          isCreating={createMutation.isPending}
          onCreate={handleCreate}
          onClose={() => setCreateDialogOpen(false)}
        />
      )}

      <RestoreSkillsDialog
        backups={skillBackups}
        isDeleting={deleteBackupMutation.isPending}
        isLoading={isFetchingSkillBackups}
        onDelete={handleDeleteBackup}
        isRestoring={restoreBackupMutation.isPending}
        onRestore={handleRestoreFromBackup}
        onClose={() => setRestoreDialogOpen(false)}
        open={restoreDialogOpen}
      />
    </div>
  );
});

UnifiedSkillsPanel.displayName = "UnifiedSkillsPanel";

interface InstalledSkillListItemProps {
  skill: InstalledSkill;
  appIds: AppId[];
  usageRecords: SkillUsageSummary[];
  usageRange: SkillUsageRange;
  usageBoundaries: number[];
  usageStatus?: Pick<SkillUsageSnapshot, "completed" | "error">;
  hasUpdate?: boolean;
  isUpdating?: boolean;
  actionsDisabled?: boolean;
  onToggleApp: (id: string, app: AppId, enabled: boolean) => void;
  onUninstall: () => void;
  onPreview: () => void;
  onUpdate?: () => void;
  isLast?: boolean;
}

const InstalledSkillListItem: React.FC<InstalledSkillListItemProps> = ({
  skill,
  appIds,
  usageRecords,
  usageRange,
  usageBoundaries,
  usageStatus,
  hasUpdate,
  isUpdating,
  actionsDisabled,
  onToggleApp,
  onUninstall,
  onPreview,
  onUpdate,
  isLast,
}) => {
  const { t } = useTranslation();
  const [hoveredApp, setHoveredApp] = useState<AppId | null>(null);
  const usageByApp = Object.fromEntries(
    appIds.map((app) => {
      const record = usageRecords.find((record) => record.app === app);
      const supported = app === "claude" || app === "codex";
      return [
        app,
        {
          count: record?.count ?? 0,
          label: !supported
            ? t("skills.usage.unsupported")
            : [
                record
                  ? t("skills.usage.details", {
                      count: record.count,
                      sessions: record.sessions,
                      manual: record.manualCount,
                      agent: record.agentCount,
                    })
                  : usageStatus?.error
                    ? t("skills.usage.incomplete")
                    : !usageStatus?.completed
                      ? t("skills.usage.scanning")
                      : t(
                          usageRange === "day"
                            ? "skills.usage.unusedToday"
                            : "skills.usage.unusedWeek",
                        ),
                record
                  ? t("skills.usage.lastUsed", {
                      time: new Date(record.lastUsed * 1000).toLocaleString(),
                    })
                  : "",
                record && !skill.apps[app]
                  ? t("skills.usage.disabledWithUsage")
                  : "",
                app === "codex" ? t("skills.usage.estimated") : "",
              ]
                .filter(Boolean)
                .join("\n"),
        },
      ];
    }),
  );

  const openDocs = async () => {
    if (!skill.readmeUrl) return;
    try {
      await settingsApi.openExternal(skill.readmeUrl);
    } catch {
      // ignore
    }
  };

  const sourceLabel = useMemo(() => {
    if (skill.repoOwner && skill.repoName) {
      return `${skill.repoOwner}/${skill.repoName}`;
    }
    return t("skills.local");
  }, [skill.repoOwner, skill.repoName, t]);

  return (
    <ListItemRow isLast={isLast}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-sm text-foreground truncate">
            {skill.name}
          </span>
          {skill.readmeUrl && (
            <button
              type="button"
              onClick={openDocs}
              className="text-muted-foreground/60 hover:text-foreground flex-shrink-0"
            >
              <ExternalLink size={12} />
            </button>
          )}
          <span className="text-xs text-muted-foreground/50 flex-shrink-0">
            {sourceLabel}
          </span>
          {hasUpdate && (
            <Badge
              variant="outline"
              className="shrink-0 text-[10px] px-1.5 py-0 h-4 border-amber-500 text-amber-600 dark:text-amber-400"
            >
              {t("skills.updateAvailable")}
            </Badge>
          )}
        </div>
        {skill.description && (
          <p
            className="text-xs text-muted-foreground truncate"
            title={skill.description}
          >
            {skill.description}
          </p>
        )}
      </div>

      <SkillUsageTrend
        records={usageRecords}
        boundaries={usageBoundaries}
        range={usageRange}
        hoveredApp={hoveredApp}
        status={usageStatus}
      />

      <AppToggleGroup
        apps={skill.apps}
        onToggle={(app, enabled) => onToggleApp(skill.id, app, enabled)}
        appIds={appIds}
        disabled={actionsDisabled}
        usage={usageByApp}
        hoveredApp={hoveredApp}
        onAppHover={setHoveredApp}
      />

      <div
        className="flex-shrink-0 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
        style={hasUpdate ? { opacity: 1 } : undefined}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={actionsDisabled}
          onClick={onPreview}
          title={t("skills.document.open", { name: skill.name })}
          aria-label={t("skills.document.open", { name: skill.name })}
        >
          <Eye size={14} />
        </Button>
        {hasUpdate && onUpdate && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              "h-7 w-7 hover:text-blue-500 hover:bg-blue-100 dark:hover:text-blue-400 dark:hover:bg-blue-500/10",
              actionsDisabled && !isUpdating && "disabled:opacity-100",
            )}
            onClick={onUpdate}
            disabled={actionsDisabled || isUpdating}
            title={t("skills.update")}
          >
            {isUpdating ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 hover:text-red-500 hover:bg-red-100 disabled:opacity-100 dark:hover:text-red-400 dark:hover:bg-red-500/10"
          onClick={onUninstall}
          disabled={actionsDisabled}
          title={t("skills.uninstall")}
        >
          <Trash2 size={14} />
        </Button>
      </div>
    </ListItemRow>
  );
};

interface ImportSkillsDialogProps {
  appIds: AppId[];
  skills: Array<{
    directory: string;
    name: string;
    description?: string;
    foundIn: string[];
    path: string;
  }>;
  isImporting: boolean;
  onImport: (imports: ImportSkillSelection[]) => void;
  onClose: () => void;
}

const CreateSkillDialog: React.FC<{
  isCreating: boolean;
  onCreate: (directory: string, description: string) => void;
  onClose: () => void;
}> = ({ isCreating, onCreate, onClose }) => {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const valid = /^[a-z0-9-]{1,64}$/.test(name);

  return (
    <Dialog open onOpenChange={(open) => !open && !isCreating && onClose()}>
      <DialogContent className="max-w-md" zIndex="alert">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !isCreating) onCreate(name, description);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("skills.create.title")}</DialogTitle>
            <DialogDescription>
              {t("skills.create.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-6 py-4">
            <label className="block space-y-1 text-sm">
              <span>{t("skills.create.name")}</span>
              <Input
                autoFocus
                value={name}
                placeholder="my-skill"
                onChange={(event) => setName(event.target.value)}
              />
              <span className="block text-xs text-muted-foreground">
                {t("skills.create.nameHint")}
              </span>
            </label>
            <label className="block space-y-1 text-sm">
              <span>{t("skills.create.summary")}</span>
              <ImeSafeInput
                value={description}
                onValueChange={setDescription}
              />
            </label>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={isCreating}
              onClick={onClose}
            >
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!valid || isCreating}>
              {t("skills.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

interface RestoreSkillsDialogProps {
  backups: SkillBackupEntry[];
  isDeleting: boolean;
  isLoading: boolean;
  isRestoring: boolean;
  onDelete: (backup: SkillBackupEntry) => void;
  onRestore: (backupId: string) => void;
  onClose: () => void;
  open: boolean;
}

const RestoreSkillsDialog: React.FC<RestoreSkillsDialogProps> = ({
  backups,
  isDeleting,
  isLoading,
  isRestoring,
  onDelete,
  onRestore,
  onClose,
  open,
}) => {
  const { t } = useTranslation();
  const actionPending = isRestoring || isDeleting;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && !actionPending && onClose()}
    >
      <DialogContent
        className="max-w-2xl max-h-[85vh] flex flex-col"
        zIndex="alert"
      >
        <DialogHeader>
          <DialogTitle>{t("skills.restoreFromBackup.title")}</DialogTitle>
          <DialogDescription>
            {t("skills.restoreFromBackup.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {isLoading ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t("common.loading")}
            </div>
          ) : backups.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {t("skills.restoreFromBackup.empty")}
            </div>
          ) : (
            <div className="space-y-3">
              {backups.map((backup) => (
                <div
                  key={backup.backupId}
                  className="rounded-xl border border-border-default bg-background/70 p-4 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="font-medium text-sm text-foreground">
                          {backup.skill.name}
                        </div>
                        <div className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          {backup.skill.directory}
                        </div>
                      </div>
                      {backup.skill.description && (
                        <div className="mt-2 text-sm text-muted-foreground">
                          {backup.skill.description}
                        </div>
                      )}
                      <div className="mt-3 space-y-1.5 text-xs text-muted-foreground">
                        <div>
                          {t("skills.restoreFromBackup.createdAt")}:{" "}
                          {formatSkillBackupDate(backup.createdAt)}
                        </div>
                        <div className="break-all" title={backup.backupPath}>
                          {t("skills.restoreFromBackup.path")}:{" "}
                          {backup.backupPath}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 sm:min-w-28">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => onRestore(backup.backupId)}
                        disabled={isRestoring || isDeleting}
                      >
                        {isRestoring
                          ? t("skills.restoreFromBackup.restoring")
                          : t("skills.restoreFromBackup.restore")}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={() => onDelete(backup)}
                        disabled={isRestoring || isDeleting}
                      >
                        {isDeleting
                          ? t("skills.restoreFromBackup.deleting")
                          : t("skills.restoreFromBackup.delete")}
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={actionPending}
          >
            {t("common.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const ImportSkillsDialog: React.FC<ImportSkillsDialogProps> = ({
  appIds,
  skills,
  isImporting,
  onImport,
  onClose,
}) => {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(
    new Set(skills.map((s) => s.directory)),
  );
  const [selectedApps, setSelectedApps] = useState<
    Record<string, ImportSkillSelection["apps"]>
  >(() =>
    Object.fromEntries(
      skills.map((skill) => [
        skill.directory,
        {
          claude: skill.foundIn.includes("claude"),
          codex: skill.foundIn.includes("codex"),
          gemini: skill.foundIn.includes("gemini"),
          grokbuild: skill.foundIn.includes("grokbuild"),
          opencode: skill.foundIn.includes("opencode"),
          openclaw: false,
          hermes: skill.foundIn.includes("hermes"),
          pi: false,
          mcode: skill.foundIn.includes("mcode"),
        },
      ]),
    ),
  );

  const toggleSelect = (directory: string) => {
    const newSelected = new Set(selected);
    if (newSelected.has(directory)) {
      newSelected.delete(directory);
    } else {
      newSelected.add(directory);
    }
    setSelected(newSelected);
  };

  const handleImport = () => {
    onImport(
      Array.from(selected).map((directory) => ({
        directory,
        apps: selectedApps[directory] ?? {
          claude: false,
          codex: false,
          gemini: false,
          grokbuild: false,
          opencode: false,
          openclaw: false,
          hermes: false,
          pi: false,
          mcode: false,
        },
      })),
    );
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <div className="bg-background rounded-xl p-6 max-w-lg w-full mx-4 shadow-xl max-h-[80vh] flex flex-col">
          <h2 className="text-lg font-semibold mb-2">{t("skills.import")}</h2>
          <p className="text-sm text-muted-foreground mb-4">
            {t("skills.importDescription")}
          </p>

          <div className="flex-1 overflow-y-auto space-y-2 mb-4">
            {skills.map((skill) => (
              <div
                key={skill.directory}
                className="flex items-start gap-3 p-3 rounded-lg border hover:bg-muted"
              >
                <input
                  type="checkbox"
                  checked={selected.has(skill.directory)}
                  onChange={() => toggleSelect(skill.directory)}
                  aria-label={skill.name}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium">{skill.name}</div>
                  {skill.description && (
                    <div className="text-sm text-muted-foreground line-clamp-1">
                      {skill.description}
                    </div>
                  )}
                  <div className="mt-2">
                    <AppToggleGroup
                      apps={
                        selectedApps[skill.directory] ?? {
                          claude: false,
                          codex: false,
                          gemini: false,
                          grokbuild: false,
                          opencode: false,
                          openclaw: false,
                          hermes: false,
                        }
                      }
                      onToggle={(app, enabled) => {
                        setSelectedApps((prev) => ({
                          ...prev,
                          [skill.directory]: {
                            ...(prev[skill.directory] ?? {
                              claude: false,
                              codex: false,
                              gemini: false,
                              grokbuild: false,
                              opencode: false,
                              openclaw: false,
                              hermes: false,
                            }),
                            [app]: enabled,
                          },
                        }));
                      }}
                      appIds={appIds}
                    />
                  </div>
                  <div
                    className="text-xs text-muted-foreground/50 mt-1 truncate"
                    title={skill.path}
                  >
                    {skill.path}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={onClose} disabled={isImporting}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleImport}
              disabled={selected.size === 0 || isImporting}
            >
              {t("skills.importSelected", { count: selected.size })}
            </Button>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
};

export default UnifiedSkillsPanel;
