import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ExternalLink,
  Download,
  Check,
  Loader2,
  Award,
  TrendingUp,
  MessageCircle,
  Clock,
  Star,
  CalendarPlus,
  type LucideIcon,
} from "lucide-react";
import { settingsApi } from "@/lib/api";
import type { DiscoverableSkill } from "@/lib/api/skills";
import { cn } from "@/lib/utils";
import {
  bestSkillsPlatformName,
  type BestSkillsMetric,
  type BestSkillsMetricIcon,
} from "@/lib/bestSkills";
import { RepoAvatar } from "./RepoAvatar";
import { SkillDescription } from "./SkillDescription";

type SkillCardSkill = DiscoverableSkill & { installed: boolean };

export interface SkillCardRanking {
  rank: number;
  platform?: string;
  metric: BestSkillsMetric;
}

const METRIC_ICONS: Record<BestSkillsMetricIcon, LucideIcon> = {
  award: Award,
  download: Download,
  trending: TrendingUp,
  message: MessageCircle,
  clock: Clock,
  star: Star,
  calendar: CalendarPlus,
};

/** Gold, silver, bronze: rosette metal gradient, ribbons, stroke, and high-contrast ink. */
const ROSETTE_MEDALS = [
  {
    stop1: "#fef08a",
    stop2: "#fbbf24",
    stop3: "#d97706",
    stroke: "#b45309",
    ribbonLeft: "#dc2626",
    ribbonRight: "#b91c1c",
    text: "#451a03",
  },
  {
    stop1: "#ffffff",
    stop2: "#e2e8f0",
    stop3: "#94a3b8",
    stroke: "#64748b",
    ribbonLeft: "#2563eb",
    ribbonRight: "#1d4ed8",
    text: "#0f172a",
  },
  {
    stop1: "#ffedd5",
    stop2: "#fdba74",
    stop3: "#d97742",
    stroke: "#9a3412",
    ribbonLeft: "#059669",
    ribbonRight: "#047857",
    text: "#431407",
  },
];

const TOP_CARD_BORDER: Record<number, string> = {
  1: "border-amber-500/45 hover:border-amber-500/65",
  2: "border-slate-400/50 hover:border-slate-400/75 dark:border-slate-400/40 dark:hover:border-slate-400/60",
  3: "border-amber-700/35 hover:border-amber-700/55 dark:border-amber-600/40 dark:hover:border-amber-600/60",
};

function RankingMetric({ metric }: { metric: BestSkillsMetric }) {
  const Icon = METRIC_ICONS[metric.icon];
  const title = [`${metric.label} ${metric.value}`, metric.detail]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      title={title}
      aria-label={title}
      className="inline-flex max-w-full shrink-0 items-center gap-1 rounded-md border border-border/60 bg-muted/75 px-2 py-0.5 text-[11px] leading-tight"
    >
      <Icon aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground" />
      <span className="truncate text-muted-foreground">{metric.label}</span>
      <span className="shrink-0 font-semibold tabular-nums text-foreground">
        {metric.value}
      </span>
    </span>
  );
}

function RankMedal({ rank }: { rank: number }) {
  const gradientId = useId();
  const medal = ROSETTE_MEDALS[rank - 1];
  if (!medal) {
    return (
      <div
        aria-label={`#${rank}`}
        className="flex h-10 min-w-[38px] shrink-0 items-center justify-center"
      >
        <span className="flex h-8 min-w-[34px] items-center justify-center rounded-lg border border-border/60 bg-muted/80 px-1.5 text-xs font-bold tabular-nums text-muted-foreground">
          #{rank}
        </span>
      </div>
    );
  }
  return (
    <div
      aria-label={`#${rank}`}
      className="flex h-10 min-w-[38px] shrink-0 items-center justify-center"
    >
      <svg
        width="36"
        height="40"
        viewBox="0 0 36 40"
        fill="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient
            id={gradientId}
            x1="7"
            y1="5"
            x2="29"
            y2="29"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor={medal.stop1} />
            <stop offset="0.52" stopColor={medal.stop2} />
            <stop offset="1" stopColor={medal.stop3} />
          </linearGradient>
        </defs>
        <path
          d="M11 26L8 38l5-2.5L16 38l1-11H11Z"
          fill={medal.ribbonLeft}
          opacity="0.92"
        />
        <path d="M25 26l3 12-5-2.5L20 38l-1-11h6Z" fill={medal.ribbonRight} />
        <path
          d="M18 3l2.6 2.1 3.3-.4 1.3 3 3.1 1-.3 3.3 2.2 2.4-1.7 2.8.8 3.2-2.7 1.8-.6 3.3-3.2.5-1.9 2.7-3.1-.9-3.1.9-1.9-2.7-3.2-.5-.6-3.3-2.7-1.8.8-3.2-1.7-2.8 2.2-2.4-.3-3.3 3.1-1 1.3-3 3.3.4L18 3Z"
          fill={`url(#${gradientId})`}
          stroke={medal.stroke}
          strokeWidth="1"
        />
        <circle
          cx="18"
          cy="17.5"
          r="9.2"
          stroke="rgba(255,255,255,0.55)"
          strokeWidth="1"
        />
        <text
          x="18"
          y="21.5"
          textAnchor="middle"
          fontSize="11.5"
          fontWeight="800"
          fill={medal.text}
        >
          {rank}
        </text>
      </svg>
    </div>
  );
}

const PLATFORM_STYLES: Record<string, string> = {
  // Neutral monochrome pill so skills.sh never collides visually with dark Vercel avatars.
  "skills.sh": "border-border/80 bg-muted/70 text-muted-foreground",
  // Tencent brand blue (TDesign #0052D9).
  "skillhub-cn":
    "border-[#0052D9]/25 bg-[#0052D9]/8 text-[#0052D9] dark:border-[#4f8cff]/35 dark:bg-[#0052D9]/20 dark:text-[#8eb5ff]",
  // ClawHub lobster red.
  clawhub:
    "border-[#E5483B]/25 bg-[#E5483B]/8 text-[#C7362B] dark:border-[#E5483B]/40 dark:bg-[#E5483B]/15 dark:text-[#ff857a]",
};

interface SkillCardProps {
  skill: SkillCardSkill;
  onInstall: (key: string) => Promise<void>;
  onUninstall?: (key: string) => Promise<void>;
  installs?: number;
  ranking?: SkillCardRanking;
  viewOnly?: boolean;
}

export function SkillCard({
  skill,
  onInstall,
  installs,
  ranking,
  viewOnly = false,
}: SkillCardProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);

  const handleInstall = async () => {
    setLoading(true);
    try {
      await onInstall(skill.key);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenGithub = async () => {
    if (skill.readmeUrl) {
      try {
        await settingsApi.openExternal(skill.readmeUrl);
      } catch (error) {
        console.error("Failed to open URL:", error);
      }
    }
  };

  const showDirectory =
    Boolean(skill.directory) &&
    skill.directory.trim().toLowerCase() !== skill.name.trim().toLowerCase();

  return (
    <Card
      className={cn(
        "glass-card flex h-full flex-col rounded-xl border bg-card shadow-sm transition-colors duration-150 group hover:shadow-md",
        ranking
          ? (TOP_CARD_BORDER[ranking.rank] ??
              "border-border-default hover:border-sky-500/40")
          : "border-border-default hover:border-sky-500/40",
      )}
    >
      <CardHeader
        className={cn("px-4 py-3.5", skill.description ? "pb-2" : "pb-3")}
      >
        <div className="flex items-center gap-2.5">
          {ranking && <RankMedal rank={ranking.rank} />}
          <RepoAvatar
            owner={skill.repoOwner}
            name={skill.name}
            className="h-9 w-9 shrink-0 rounded-lg group-hover:scale-100 group-hover:shadow-sm"
          />
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <CardTitle
                className="min-w-[6rem] max-w-full flex-1 truncate text-[14.5px] font-semibold leading-snug tracking-tight"
                title={skill.name}
              >
                {skill.name}
              </CardTitle>
              {ranking && <RankingMetric metric={ranking.metric} />}
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
              {showDirectory && (
                <CardDescription className="max-w-full truncate text-xs">
                  {skill.directory}
                </CardDescription>
              )}
              {ranking?.platform && (
                <Badge
                  variant="outline"
                  className={cn(
                    "inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-[5px] px-1.5 py-0 text-[10.5px] font-medium",
                    PLATFORM_STYLES[ranking.platform],
                  )}
                >
                  {ranking.platform === "skills.sh" && (
                    <span aria-hidden className="text-[8px] opacity-80">
                      ▲
                    </span>
                  )}
                  {bestSkillsPlatformName(ranking.platform)}
                </Badge>
              )}
              {skill.repoOwner && skill.repoName && (
                <span
                  className="min-w-0 max-w-full truncate font-mono text-[11px] text-muted-foreground"
                  title={`${skill.repoOwner}/${skill.repoName}`}
                >
                  {skill.repoOwner}/{skill.repoName}
                </span>
              )}
              {typeof installs === "number" && (
                <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium tabular-nums text-muted-foreground">
                  {skill.repoOwner && skill.repoName && (
                    <span aria-hidden className="opacity-50">
                      ·
                    </span>
                  )}
                  <Download className="h-3 w-3 opacity-80" aria-hidden />
                  {installs.toLocaleString()}
                </span>
              )}
            </div>
          </div>
        </div>
      </CardHeader>
      {skill.description ? (
        <CardContent className="flex-1 px-4 pt-0 pb-3">
          <SkillDescription
            name={skill.name}
            description={skill.description}
            source={`${skill.repoOwner}/${skill.repoName}`}
            side="top"
            className="text-[13px] line-clamp-4 leading-relaxed"
          />
        </CardContent>
      ) : (
        <div className="flex-1" />
      )}
      <CardFooter className="mt-auto flex items-center justify-between gap-2 border-t border-border/50 px-4 py-2.5">
        {skill.readmeUrl ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenGithub}
            disabled={loading}
            className="h-7 -ml-2 px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            {t("skills.view")}
          </Button>
        ) : (
          <span />
        )}
        {viewOnly ? (
          !skill.readmeUrl && (
            <Button
              variant="outline"
              size="sm"
              disabled
              className="ml-auto h-7 rounded-[7px] px-2.5 text-xs"
            >
              {t("skills.custom.unavailable", "暂无链接")}
            </Button>
          )
        ) : skill.installed ? (
          <span
            title={t("skills.uninstallInMainPanel")}
            className="ml-auto inline-flex h-7 items-center gap-1 rounded-[7px] border border-border-default bg-muted/70 px-2.5 text-[11.5px] font-medium text-muted-foreground"
          >
            <Check
              className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
            {t("skills.installed")}
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={handleInstall}
            disabled={loading || !skill.repoOwner}
            className="ml-auto h-7 rounded-[7px] border-emerald-500/35 bg-emerald-500/10 px-2.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
          >
            {loading ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            {loading ? t("skills.installing") : t("skills.install")}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
