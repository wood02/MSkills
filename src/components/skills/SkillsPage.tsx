import {
  useState,
  useMemo,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Filter,
  Loader2,
  RefreshCw,
  Search,
  Settings,
  TrendingUp,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { SkillCard } from "./SkillCard";
import { RepoManagerPanel } from "./RepoManagerPanel";
import {
  useDiscoverableSkills,
  useInstalledSkills,
  useInstallSkill,
  useSkillRepos,
  useAddSkillRepo,
  useRemoveSkillRepo,
  useSearchSkillsSh,
  useSkillsShLeaderboard,
  useBestSkillsDates,
  useBestSkillsRanking,
} from "@/hooks/useSkills";
import { BEST_SKILLS_RANKINGS, type BestSkillsRanking } from "@/lib/bestSkills";
import type { AppId } from "@/lib/api/types";
import type {
  DiscoverableSkill,
  SkillRepo,
  SkillsShDiscoverableSkill,
  SkillsShLeaderboardView,
} from "@/lib/api/skills";
import { formatSkillError } from "@/lib/errors/skillErrorParser";

export type SkillsPageSource = "repos" | "skillssh" | "custom";

interface SkillsPageProps {
  initialApp?: AppId;
  onSourceChange?: (source: SkillsPageSource) => void;
}

export interface SkillsPageHandle {
  refresh: () => void;
  openRepoManager: () => void;
}

type SkillsPageHeaderAction = {
  key: string;
  sources: readonly SkillsPageSource[];
  labelKey: string;
  Icon: LucideIcon;
  execute: (page: SkillsPageHandle | null) => void;
};

const SKILLS_PAGE_HEADER_ACTIONS: readonly SkillsPageHeaderAction[] = [
  {
    key: "refresh-repos",
    sources: ["repos"],
    labelKey: "skills.refresh",
    Icon: RefreshCw,
    execute: (page) => page?.refresh(),
  },
  {
    key: "manage-repos",
    sources: ["repos", "skillssh", "custom"],
    labelKey: "skills.repoManager",
    Icon: Settings,
    execute: (page) => page?.openRepoManager(),
  },
];

export const getSkillsPageHeaderActions = (source: SkillsPageSource) =>
  SKILLS_PAGE_HEADER_ACTIONS.filter((action) =>
    action.sources.includes(source),
  );

const SKILLSSH_PAGE_SIZE = 20;

function SkillGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div
      className="grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-3"
      aria-busy="true"
    >
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="flex animate-pulse flex-col justify-between rounded-xl border border-border-default bg-card p-4 shadow-sm"
        >
          <div className="flex items-start gap-3">
            <div className="h-9 w-9 shrink-0 rounded-lg bg-muted" />
            <div className="min-w-0 flex-1 space-y-2 pt-0.5">
              <div className="h-4 w-1/2 rounded bg-muted" />
              <div className="h-3 w-2/3 rounded bg-muted/70" />
            </div>
          </div>
          <div className="mt-4 flex items-center justify-between border-t border-border/50 pt-2.5">
            <div className="h-4 w-12 rounded bg-muted/70" />
            <div className="h-[30px] w-16 rounded-lg bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Skills 发现面板
 * 用于浏览和安装来自仓库或 skills.sh 的 Skills
 */
export const SkillsPage = forwardRef<SkillsPageHandle, SkillsPageProps>(
  ({ initialApp = "claude", onSourceChange }, ref) => {
    const { t } = useTranslation();
    const [repoManagerOpen, setRepoManagerOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [filterRepo, setFilterRepo] = useState<string>("all");
    const [filterStatus, setFilterStatus] = useState<
      "all" | "installed" | "uninstalled"
    >("all");

    // skills.sh 搜索状态
    const [searchSource, setSearchSource] =
      useState<SkillsPageSource>("skillssh");
    const [leaderboardView, setLeaderboardView] =
      useState<SkillsShLeaderboardView>("trending");
    const [ranking, setRanking] = useState<BestSkillsRanking>("best-100");
    const [dataDate, setDataDate] = useState("latest");
    const [skillsShInput, setSkillsShInput] = useState("");
    const [skillsShQuery, setSkillsShQuery] = useState("");
    const [skillsShOffset, setSkillsShOffset] = useState(0);
    const [accumulatedResults, setAccumulatedResults] = useState<
      SkillsShDiscoverableSkill[]
    >([]);

    // currentApp 用于安装时的默认应用
    const currentApp = initialApp;

    // Queries
    const {
      data: discoverableSkills,
      isLoading: loadingDiscoverable,
      isFetching: fetchingDiscoverable,
      refetch: refetchDiscoverable,
    } = useDiscoverableSkills();
    const { data: installedSkills } = useInstalledSkills();
    const { data: repos = [], refetch: refetchRepos } = useSkillRepos();

    const loading =
      searchSource === "repos" && (loadingDiscoverable || fetchingDiscoverable);
    const effectiveSource =
      searchSource === "repos" && repos.length === 0 && !loading
        ? "skillssh"
        : searchSource;
    const isCustom = effectiveSource === "custom";
    const history = useBestSkillsDates(isCustom);
    const customRanking = useBestSkillsRanking(ranking, dataDate, isCustom);
    const customRows = useMemo(() => {
      const rows = customRanking.isError ? [] : (customRanking.data ?? []);
      const query = searchQuery.trim().toLowerCase();
      return query
        ? rows.filter((row) =>
            `${row.name} ${row.description} ${row.skill?.repoOwner ?? ""}/${row.skill?.repoName ?? ""}`
              .toLowerCase()
              .includes(query),
          )
        : rows;
    }, [customRanking.data, customRanking.isError, searchQuery]);
    const reloadCustom = () => {
      void customRanking.refetch();
      void history.refetch();
    };
    const browsingLeaderboard = skillsShQuery.length === 0;
    const leaderboard = useSkillsShLeaderboard(
      leaderboardView,
      effectiveSource === "skillssh" && browsingLeaderboard,
    );

    // skills.sh 搜索
    const {
      data: skillsShResult,
      isLoading: loadingSkillsSh,
      isFetching: fetchingSkillsShSearch,
      isPlaceholderData: placeholderSkillsSh,
      error: skillsShSearchError,
      refetch: refetchSkillsShSearch,
    } = useSearchSkillsSh(
      skillsShQuery,
      SKILLSSH_PAGE_SIZE,
      skillsShOffset,
      effectiveSource === "skillssh" && !browsingLeaderboard,
    );

    const skillsShItems = useMemo(() => {
      const items = browsingLeaderboard
        ? (leaderboard.data?.pages.flatMap((page) => page.skills) ?? [])
        : accumulatedResults;
      return [...new Map(items.map((skill) => [skill.key, skill])).values()];
    }, [browsingLeaderboard, leaderboard.data, accumulatedResults]);
    const fetchingSkillsSh = browsingLeaderboard
      ? leaderboard.isFetching
      : fetchingSkillsShSearch;
    const skillsShError = browsingLeaderboard
      ? leaderboard.error
      : skillsShSearchError;
    const retrySkillsSh = () =>
      browsingLeaderboard
        ? leaderboard.isFetchNextPageError
          ? leaderboard.fetchNextPage()
          : leaderboard.refetch()
        : refetchSkillsShSearch();

    // 当搜索结果返回时累积
    useEffect(() => {
      if (skillsShResult && !placeholderSkillsSh) {
        if (skillsShOffset === 0) {
          setAccumulatedResults(skillsShResult.skills);
        } else {
          setAccumulatedResults((prev) => [...prev, ...skillsShResult.skills]);
        }
      }
    }, [skillsShResult, skillsShOffset, placeholderSkillsSh]);

    // 手动提交搜索
    const handleSkillsShSearch = () => {
      const trimmed = skillsShInput.trim();
      if (trimmed.length < 2) return;
      if (trimmed === skillsShQuery && skillsShOffset === 0) return;
      setSkillsShOffset(0);
      setAccumulatedResults([]);
      setSkillsShQuery(trimmed);
    };

    // Mutations
    const installMutation = useInstallSkill();
    const addRepoMutation = useAddSkillRepo();
    const removeRepoMutation = useRemoveSkillRepo();

    // 已安装的 skill key 集合（使用 directory + repoOwner + repoName 组合判断）
    const installedKeys = useMemo(() => {
      if (!installedSkills) return new Set<string>();
      return new Set(
        installedSkills.map((s) => {
          // 构建唯一 key：directory + repoOwner + repoName
          const owner = s.repoOwner?.toLowerCase() || "";
          const name = s.repoName?.toLowerCase() || "";
          return `${s.directory.toLowerCase()}:${owner}:${name}`;
        }),
      );
    }, [installedSkills]);

    type DiscoverableSkillItem = DiscoverableSkill & { installed: boolean };

    // 从可发现技能中提取所有仓库选项
    const repoOptions = useMemo(() => {
      if (!discoverableSkills) return [];
      const repoSet = new Set<string>();
      discoverableSkills.forEach((s) => {
        if (s.repoOwner && s.repoName) {
          repoSet.add(`${s.repoOwner}/${s.repoName}`);
        }
      });
      return Array.from(repoSet).sort();
    }, [discoverableSkills]);

    // 为发现列表补齐 installed 状态，供 SkillCard 使用
    const skills: DiscoverableSkillItem[] = useMemo(() => {
      if (!discoverableSkills) return [];
      return discoverableSkills.map((d) => {
        // 同时处理 / 和 \ 路径分隔符（兼容 Windows 和 Unix）
        const installName =
          d.directory.split(/[/\\]/).pop()?.toLowerCase() ||
          d.directory.toLowerCase();
        // 使用 directory + repoOwner + repoName 组合判断是否已安装
        const key = `${installName}:${d.repoOwner.toLowerCase()}:${d.repoName.toLowerCase()}`;
        return {
          ...d,
          installed: installedKeys.has(key),
        };
      });
    }, [discoverableSkills, installedKeys]);

    // 检查 skills.sh 结果的安装状态
    const isSkillsShInstalled = (
      skill: Pick<DiscoverableSkill, "directory" | "repoOwner" | "repoName">,
    ): boolean => {
      const key = `${skill.directory.toLowerCase()}:${skill.repoOwner.toLowerCase()}:${skill.repoName.toLowerCase()}`;
      return installedKeys.has(key);
    };

    useImperativeHandle(ref, () => ({
      refresh: () => {
        refetchDiscoverable();
        refetchRepos();
      },
      openRepoManager: () => setRepoManagerOpen(true),
    }));

    // skills.sh 结果转为 DiscoverableSkill（复用现有安装流程）
    const toDiscoverableSkill = (
      s: SkillsShDiscoverableSkill,
    ): DiscoverableSkill => ({
      key: s.key,
      name: s.name,
      description: "",
      directory: s.directory,
      repoOwner: s.repoOwner,
      repoName: s.repoName,
      repoBranch: s.repoBranch,
      readmeUrl: s.readmeUrl,
    });

    const handleInstall = async (key: string) => {
      let skill: DiscoverableSkill | undefined;

      if (isCustom) {
        skill = customRows.find((row) => row.key === key)?.skill;
      } else if (effectiveSource === "skillssh") {
        const found = skillsShItems.find((s) => s.key === key);
        if (found) {
          skill = toDiscoverableSkill(found);
        }
      } else {
        skill = discoverableSkills?.find((s) => s.key === key);
      }

      if (!skill) {
        toast.error(t("skills.notFound"));
        return;
      }

      try {
        await installMutation.mutateAsync({
          skill,
          currentApp,
        });
        toast.success(t("skills.installSuccess", { name: skill.name }), {
          closeButton: true,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        const { title, description } = formatSkillError(
          errorMessage,
          t,
          "skills.installFailed",
        );
        toast.error(title, {
          description,
          duration: 10000,
        });
        console.error("Install skill failed:", error);
      }
    };

    const handleAddRepo = async (repo: SkillRepo) => {
      try {
        await addRepoMutation.mutateAsync(repo);
        // Await discovery so we can report the real count
        const { data: freshSkills } = await refetchDiscoverable();
        const count =
          freshSkills?.filter(
            (s) =>
              s.repoOwner === repo.owner &&
              s.repoName === repo.name &&
              (s.repoBranch || "main") === (repo.branch || "main"),
          ).length ?? 0;
        toast.success(
          t("skills.repo.addSuccess", {
            owner: repo.owner,
            name: repo.name,
            count,
          }),
          { closeButton: true },
        );
      } catch (error) {
        toast.error(t("common.error"), {
          description: String(error),
        });
      }
    };

    const handleRemoveRepo = async (owner: string, name: string) => {
      try {
        await removeRepoMutation.mutateAsync({ owner, name });
        toast.success(t("skills.repo.removeSuccess", { owner, name }), {
          closeButton: true,
        });
      } catch (error) {
        toast.error(t("common.error"), {
          description: String(error),
        });
      }
    };

    // 过滤技能列表（仓库模式）
    const filteredSkills = useMemo(() => {
      // 按仓库筛选
      const byRepo = skills.filter((skill) => {
        if (filterRepo === "all") return true;
        const skillRepo = `${skill.repoOwner}/${skill.repoName}`;
        return skillRepo === filterRepo;
      });

      // 按安装状态筛选
      const byStatus = byRepo.filter((skill) => {
        if (filterStatus === "installed") return skill.installed;
        if (filterStatus === "uninstalled") return !skill.installed;
        return true;
      });

      // 按搜索关键词筛选
      if (!searchQuery.trim()) return byStatus;

      const query = searchQuery.toLowerCase();
      return byStatus.filter((skill) => {
        const name = skill.name?.toLowerCase() || "";
        const repo =
          skill.repoOwner && skill.repoName
            ? `${skill.repoOwner}/${skill.repoName}`.toLowerCase()
            : "";

        return name.includes(query) || repo.includes(query);
      });
    }, [skills, searchQuery, filterRepo, filterStatus]);

    // 是否有更多 skills.sh 结果
    const hasMoreSkillsSh = browsingLeaderboard
      ? leaderboard.hasNextPage
      : skillsShResult && skillsShItems.length < skillsShResult.totalCount;
    const searchingSkillsSh =
      (loadingSkillsSh || fetchingSkillsSh) && skillsShItems.length === 0;

    useEffect(() => {
      onSourceChange?.(effectiveSource);
    }, [effectiveSource, onSourceChange]);

    return (
      <div className="px-6 flex flex-col flex-1 min-h-0 overflow-hidden bg-background/50">
        {/* 技能网格（可滚动详情区域） */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden animate-fade-in">
          <div className="py-4">
            {/* 搜索来源切换 + 搜索框 */}
            <div className="mb-4 flex flex-col gap-2.5 md:flex-row md:items-center">
              {/* 来源切换 */}
              <div
                className="inline-flex h-9 shrink-0 items-center gap-0.5 rounded-lg border border-border-default bg-muted/55 p-0.5"
                role="group"
              >
                <button
                  type="button"
                  aria-pressed={effectiveSource === "repos"}
                  className={cn(
                    "h-full min-w-[60px] rounded-md px-3 text-xs transition-all",
                    effectiveSource === "repos"
                      ? "bg-background font-semibold text-foreground shadow-sm"
                      : "font-medium text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setSearchSource("repos")}
                >
                  {t("skills.searchSource.repos")}
                </button>
                <button
                  type="button"
                  aria-pressed={effectiveSource === "skillssh"}
                  className={cn(
                    "h-full min-w-[74px] rounded-md px-3 text-xs transition-all",
                    effectiveSource === "skillssh"
                      ? "bg-background font-semibold text-foreground shadow-sm"
                      : "font-medium text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setSearchSource("skillssh")}
                >
                  skills.sh
                </button>
                <button
                  type="button"
                  aria-pressed={isCustom}
                  className={cn(
                    "h-full min-w-[66px] rounded-md px-3 text-xs transition-all",
                    isCustom
                      ? "bg-background font-semibold text-foreground shadow-sm"
                      : "font-medium text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setSearchSource("custom")}
                >
                  Custom
                </button>
              </div>

              {effectiveSource === "repos" ? (
                <>
                  {/* 仓库模式搜索框 */}
                  <div className="relative min-w-0 flex-1">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      type="text"
                      placeholder={t("skills.searchPlaceholder")}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && searchQuery) {
                          e.stopPropagation();
                          setSearchQuery("");
                        }
                      }}
                      className="h-9 rounded-lg pl-9 pr-8 text-[13px]"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery("")}
                        aria-label={t("common.clear")}
                        title={t("common.clear")}
                        className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  {/* 仓库筛选 */}
                  <Select value={filterRepo} onValueChange={setFilterRepo}>
                    <SelectTrigger className="h-9 w-full shrink-0 gap-2 rounded-lg border bg-background px-2.5 text-[12.5px] font-medium text-foreground shadow-sm md:w-auto md:min-w-[148px] md:max-w-[230px]">
                      <span className="inline-flex min-w-0 items-center gap-1.5">
                        <Filter
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75"
                        />
                        <span className="truncate">
                          <SelectValue
                            placeholder={t("skills.filter.repo")}
                            className="text-left"
                          />
                        </span>
                      </span>
                    </SelectTrigger>
                    <SelectContent className="bg-card text-foreground shadow-lg max-h-64 min-w-[var(--radix-select-trigger-width)]">
                      <SelectItem
                        value="all"
                        className="text-left pr-3 [&[data-state=checked]>span:first-child]:hidden"
                      >
                        {t("skills.filter.allRepos")}
                      </SelectItem>
                      {repoOptions.map((repo) => (
                        <SelectItem
                          key={repo}
                          value={repo}
                          className="text-left pr-3 [&[data-state=checked]>span:first-child]:hidden"
                          title={repo}
                        >
                          <span className="truncate block max-w-[200px]">
                            {repo}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {/* 安装状态筛选 */}
                  <Select
                    value={filterStatus}
                    onValueChange={(val) =>
                      setFilterStatus(
                        val as "all" | "installed" | "uninstalled",
                      )
                    }
                  >
                    <SelectTrigger className="h-9 w-full shrink-0 gap-2 rounded-lg border bg-background px-2.5 text-[12.5px] font-medium text-foreground shadow-sm md:w-auto md:min-w-[108px]">
                      <SelectValue
                        placeholder={t("skills.filter.placeholder")}
                        className="text-left"
                      />
                    </SelectTrigger>
                    <SelectContent className="bg-card text-foreground shadow-lg">
                      <SelectItem
                        value="all"
                        className="text-left pr-3 [&[data-state=checked]>span:first-child]:hidden"
                      >
                        {t("skills.filter.all")}
                      </SelectItem>
                      <SelectItem
                        value="installed"
                        className="text-left pr-3 [&[data-state=checked]>span:first-child]:hidden"
                      >
                        {t("skills.filter.installed")}
                      </SelectItem>
                      <SelectItem
                        value="uninstalled"
                        className="text-left pr-3 [&[data-state=checked]>span:first-child]:hidden"
                      >
                        {t("skills.filter.uninstalled")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </>
              ) : isCustom ? (
                <>
                  <Select
                    value={ranking}
                    onValueChange={(value) =>
                      setRanking(value as BestSkillsRanking)
                    }
                  >
                    <SelectTrigger
                      aria-label={t("skills.custom.ranking", "榜单")}
                      className="h-9 w-full shrink-0 gap-2 rounded-lg bg-background px-2.5 text-[12.5px] font-medium shadow-sm md:w-auto md:min-w-[136px]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BEST_SKILLS_RANKINGS.map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {t(`skills.custom.rankings.${value}`, label)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={dataDate} onValueChange={setDataDate}>
                    <SelectTrigger
                      aria-label={t("skills.custom.date", "数据日期")}
                      className="h-9 w-full shrink-0 gap-2 rounded-lg bg-background px-2.5 text-[12.5px] font-medium tabular-nums shadow-sm md:w-auto md:min-w-[120px]"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="latest">
                        {t("skills.custom.latest", "最新")}
                      </SelectItem>
                      {(history.data ?? []).map((date) => (
                        <SelectItem key={date} value={date}>
                          {date}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="relative min-w-0 flex-1">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      type="text"
                      placeholder={t("skills.searchPlaceholder")}
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape" && searchQuery) {
                          e.stopPropagation();
                          setSearchQuery("");
                        }
                      }}
                      className="h-9 rounded-lg pl-9 pr-8 text-[13px]"
                    />
                    {searchQuery && (
                      <button
                        type="button"
                        onClick={() => setSearchQuery("")}
                        aria-label={t("common.clear")}
                        title={t("common.clear")}
                        className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-lg"
                    aria-label={t("skills.custom.refresh", "刷新榜单")}
                    disabled={customRanking.isFetching || history.isFetching}
                    onClick={reloadCustom}
                  >
                    <RefreshCw
                      className={`h-4 w-4${customRanking.isFetching ? " animate-spin" : ""}`}
                    />
                  </Button>
                </>
              ) : (
                <>
                  <Select
                    value={leaderboardView}
                    onValueChange={(value) =>
                      setLeaderboardView(value as SkillsShLeaderboardView)
                    }
                    disabled={!browsingLeaderboard}
                  >
                    <SelectTrigger
                      aria-label={t("skills.skillssh.sortLabel")}
                      className="h-9 w-full shrink-0 gap-2 rounded-lg border bg-background px-2.5 text-[12.5px] font-medium text-foreground shadow-sm md:w-auto md:min-w-[136px]"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <TrendingUp
                          aria-hidden="true"
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/75"
                        />
                        <SelectValue />
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all-time">
                        {t("skills.skillssh.sortAllTime")}
                      </SelectItem>
                      <SelectItem value="trending">
                        {t("skills.skillssh.sortTrending")}
                      </SelectItem>
                      <SelectItem value="hot">
                        {t("skills.skillssh.sortHot")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {/* skills.sh 搜索框 */}
                  <div className="relative min-w-0 flex-1">
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      type="text"
                      placeholder={t("skills.skillssh.searchPlaceholder")}
                      value={skillsShInput}
                      onChange={(e) => {
                        setSkillsShInput(e.target.value);
                        if (!e.target.value.trim()) {
                          setSkillsShQuery("");
                          setSkillsShOffset(0);
                          setAccumulatedResults([]);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleSkillsShSearch();
                        if (e.key === "Escape" && skillsShInput) {
                          e.stopPropagation();
                          setSkillsShInput("");
                          setSkillsShQuery("");
                          setSkillsShOffset(0);
                          setAccumulatedResults([]);
                        }
                      }}
                      className="h-9 rounded-lg pl-9 pr-8 text-[13px]"
                    />
                    {skillsShInput && (
                      <button
                        type="button"
                        onClick={() => {
                          setSkillsShInput("");
                          setSkillsShQuery("");
                          setSkillsShOffset(0);
                          setAccumulatedResults([]);
                        }}
                        aria-label={t("common.clear")}
                        title={t("common.clear")}
                        className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <X aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleSkillsShSearch}
                    disabled={
                      skillsShInput.trim().length < 2 || fetchingSkillsSh
                    }
                    className={cn(
                      "h-9 shrink-0 rounded-lg px-3.5 text-xs font-medium transition-colors",
                      skillsShInput.trim().length >= 2 && !fetchingSkillsSh
                        ? "border-sky-500/35 bg-sky-500/10 text-sky-700 hover:bg-sky-500/20 dark:text-sky-300"
                        : "text-muted-foreground",
                    )}
                  >
                    {fetchingSkillsSh ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Search className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {t("skills.search")}
                  </Button>
                </>
              )}
            </div>

            {effectiveSource === "repos" && searchQuery && (
              <p className="mb-3 text-xs tabular-nums text-muted-foreground">
                {t("skills.count", { count: filteredSkills.length })}
              </p>
            )}

            {/* 内容区域 */}
            {isCustom ? (
              <>
                {history.isError && (
                  <div
                    role="alert"
                    className="mb-4 flex items-center gap-3 text-sm text-muted-foreground"
                  >
                    {t(
                      "skills.custom.historyFailed",
                      "历史日期读取失败，仍可查看最新榜单",
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void history.refetch()}
                    >
                      {t("skills.skillssh.retry")}
                    </Button>
                  </div>
                )}
                {customRanking.isLoading ? (
                  <SkillGridSkeleton />
                ) : customRanking.isError ? (
                  <div
                    role="alert"
                    className="flex h-48 flex-col items-center justify-center gap-3 text-sm text-muted-foreground"
                  >
                    <p>{t("skills.custom.loadFailed", "榜单读取失败")}</p>
                    <Button variant="outline" size="sm" onClick={reloadCustom}>
                      {t("skills.skillssh.retry")}
                    </Button>
                  </div>
                ) : customRanking.data === null ? (
                  <div className="flex h-48 flex-col items-center justify-center gap-3 text-muted-foreground">
                    <p>{t("skills.custom.missing", "该日期暂无此榜单")}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={
                        dataDate === "latest"
                          ? reloadCustom
                          : () => setDataDate("latest")
                      }
                    >
                      {dataDate === "latest"
                        ? t("skills.skillssh.retry")
                        : t("skills.custom.backToLatest", "切回最新")}
                    </Button>
                  </div>
                ) : customRows.length === 0 ? (
                  <div className="flex h-48 items-center justify-center text-muted-foreground">
                    {searchQuery.trim()
                      ? t("skills.noResults")
                      : t("skills.custom.empty", "此榜单暂无数据")}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                    {customRows.map((row) => (
                      <SkillCard
                        key={row.key}
                        skill={{
                          ...(row.skill ?? {
                            key: row.key,
                            name: row.name,
                            description: row.description,
                            directory: "",
                            repoOwner: "",
                            repoName: "",
                            repoBranch: "main",
                            readmeUrl: row.url,
                          }),
                          key: row.key,
                          installed: Boolean(
                            row.skill && isSkillsShInstalled(row.skill),
                          ),
                        }}
                        ranking={{
                          rank: row.rank,
                          platform: row.platform,
                          metric: row.metric,
                        }}
                        viewOnly={!row.skill}
                        onInstall={handleInstall}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : effectiveSource === "repos" ? (
              /* ===== 仓库模式 ===== */
              loading ? (
                <SkillGridSkeleton />
              ) : skills.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-center">
                  <p className="text-lg font-medium text-foreground">
                    {t("skills.empty")}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t("skills.emptyDescription")}
                  </p>
                  <Button
                    variant="link"
                    onClick={() => setRepoManagerOpen(true)}
                    className="mt-3 text-sm font-normal"
                  >
                    {t("skills.addRepo")}
                  </Button>
                </div>
              ) : filteredSkills.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-center">
                  <p className="text-lg font-medium text-foreground">
                    {t("skills.noResults")}
                  </p>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t("skills.emptyDescription")}
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                  {filteredSkills.map((skill) => (
                    <SkillCard
                      key={skill.key}
                      skill={skill}
                      onInstall={handleInstall}
                    />
                  ))}
                </div>
              )
            ) : (
              /* ===== skills.sh 模式 ===== */
              <>
                {skillsShError && (
                  <div
                    role="alert"
                    className="mb-4 flex items-center justify-center gap-3 text-sm text-muted-foreground"
                  >
                    {t(
                      browsingLeaderboard
                        ? "skills.skillssh.leaderboardError"
                        : "skills.skillssh.error",
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={fetchingSkillsSh}
                      onClick={retrySkillsSh}
                    >
                      {t("skills.skillssh.retry")}
                    </Button>
                  </div>
                )}
                {!browsingLeaderboard && (
                  <p className="mb-4 text-xs text-muted-foreground">
                    {t("skills.skillssh.searchSortHint")}
                  </p>
                )}
                {searchingSkillsSh ? (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>
                        {t(
                          browsingLeaderboard
                            ? "skills.skillssh.leaderboardLoading"
                            : "skills.skillssh.loading",
                        )}
                      </span>
                    </div>
                    <SkillGridSkeleton />
                  </div>
                ) : skillsShItems.length === 0 && !skillsShError ? (
                  <div className="flex flex-col items-center justify-center h-48 text-center">
                    <p className="text-lg font-medium text-foreground">
                      {t(
                        browsingLeaderboard
                          ? "skills.skillssh.leaderboardEmpty"
                          : "skills.skillssh.noResults",
                        {
                          query: skillsShQuery,
                        },
                      )}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
                      {skillsShItems.map((skill) => {
                        const installed = isSkillsShInstalled(skill);
                        return (
                          <SkillCard
                            key={skill.key}
                            skill={{
                              ...toDiscoverableSkill(skill),
                              installed,
                            }}
                            installs={skill.installs}
                            onInstall={handleInstall}
                          />
                        );
                      })}
                    </div>
                  </>
                )}
                {!searchingSkillsSh && (
                  <div className="mt-6 flex flex-col items-center gap-2">
                    {hasMoreSkillsSh && !skillsShError && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={fetchingSkillsSh}
                        onClick={() =>
                          browsingLeaderboard
                            ? leaderboard.fetchNextPage()
                            : setSkillsShOffset(
                                (prev) => prev + SKILLSSH_PAGE_SIZE,
                              )
                        }
                      >
                        {fetchingSkillsSh && (
                          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                        )}
                        {t("skills.skillssh.loadMore")}
                      </Button>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t("skills.skillssh.poweredBy")}
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* 仓库管理面板 */}
        {repoManagerOpen && (
          <RepoManagerPanel
            repos={repos}
            skills={skills}
            onAdd={handleAddRepo}
            onRemove={handleRemoveRepo}
            onClose={() => setRepoManagerOpen(false)}
          />
        )}
      </div>
    );
  },
);

SkillsPage.displayName = "SkillsPage";
