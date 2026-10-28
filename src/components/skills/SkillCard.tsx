import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Portal as TooltipPortal } from "@radix-ui/react-tooltip";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ExternalLink,
  Download,
  Trash2,
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

/** Gold, silver, bronze: metal face, rim, ribbon, and staggered shine delay. */
const MEDALS = [
  {
    face: "radial-gradient(circle at 32% 28%, #fff7d1 0%, #f8d468 28%, #d9a21b 62%, #9a6a08 100%)",
    rim: "#f3c63f",
    text: "text-amber-950",
    ribbon: ["bg-red-600", "bg-red-500"],
    delay: "0s",
  },
  {
    face: "radial-gradient(circle at 32% 28%, #ffffff 0%, #e4e8ee 30%, #a9b2bf 65%, #6b7380 100%)",
    rim: "#cfd5de",
    text: "text-slate-800",
    ribbon: ["bg-blue-700", "bg-blue-600"],
    delay: "1.3s",
  },
  {
    face: "radial-gradient(circle at 32% 28%, #ffe1c4 0%, #e9a066 30%, #b8662c 65%, #7a3d12 100%)",
    rim: "#d98b4f",
    text: "text-orange-950",
    ribbon: ["bg-emerald-700", "bg-emerald-600"],
    delay: "2.6s",
  },
];

function RankingMetric({ metric }: { metric: BestSkillsMetric }) {
  const Icon = METRIC_ICONS[metric.icon];
  const title = [`${metric.label} ${metric.value}`, metric.detail]
    .filter(Boolean)
    .join(" · ");
  return (
    <span
      title={title}
      aria-label={title}
      className="ml-auto flex shrink-0 items-center gap-1 text-xs"
    >
      <Icon aria-hidden className="h-3 w-3 text-muted-foreground" />
      <span className="font-semibold tabular-nums text-foreground">
        {metric.value}
      </span>
    </span>
  );
}

function RankMedal({ rank }: { rank: number }) {
  const medal = MEDALS[rank - 1];
  if (!medal) {
    return (
      <div
        aria-label={`#${rank}`}
        className="flex h-9 min-w-9 shrink-0 items-center justify-center rounded-lg bg-muted px-1.5 text-sm font-bold tabular-nums text-muted-foreground"
      >
        #{rank}
      </div>
    );
  }
  return (
    <div aria-label={`#${rank}`} className="relative h-[54px] w-10 shrink-0">
      {/* Ribbon tails meet behind the medal in a V. */}
      <span
        className={cn(
          "absolute left-[7px] top-0 h-6 w-[11px] -skew-x-[16deg] rounded-[1px]",
          medal.ribbon[0],
        )}
      />
      <span
        className={cn(
          "absolute right-[7px] top-0 h-6 w-[11px] skew-x-[16deg] rounded-[1px]",
          medal.ribbon[1],
        )}
      />
      <div
        className={cn(
          "absolute bottom-0 left-0 flex h-10 w-10 items-center justify-center overflow-hidden rounded-full text-base font-extrabold tabular-nums",
          medal.text,
        )}
        style={{
          background: medal.face,
          boxShadow: `0 0 0 1.5px ${medal.rim}, inset 0 0 0 3px rgba(255,255,255,0.35), inset 0 -3px 5px rgba(0,0,0,0.28), 0 3px 6px rgba(0,0,0,0.3)`,
          textShadow:
            "0 1px 0 rgba(255,255,255,0.65), 0 -1px 0 rgba(0,0,0,0.25)",
        }}
      >
        {rank}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 -left-full w-full animate-medal-shine bg-[linear-gradient(115deg,transparent_30%,rgba(255,255,255,0.85)_50%,transparent_70%)] [animation-delay:var(--medal-delay)] group-hover:animate-medal-shine-once group-hover:[animation-delay:0s] motion-reduce:hidden"
          style={{ "--medal-delay": medal.delay } as CSSProperties}
        />
      </div>
    </div>
  );
}

const PLATFORM_STYLES: Record<string, string> = {
  // skills.sh: black-and-white with the Vercel triangle.
  "skills.sh":
    "border-black bg-black text-white dark:border-white dark:bg-white dark:text-black",
  // Tencent brand blue (TDesign #0052D9).
  "skillhub-cn":
    "border-[#0052D9]/30 bg-[#0052D9]/10 text-[#0052D9] dark:border-[#4f8cff]/40 dark:bg-[#0052D9]/25 dark:text-[#7aa7ff]",
  // ClawHub lobster red.
  clawhub:
    "border-[#E5483B]/30 bg-[#E5483B]/10 text-[#D23A2E] dark:border-[#E5483B]/50 dark:bg-[#E5483B]/20 dark:text-[#ff7a6e]",
};

interface SkillCardProps {
  skill: SkillCardSkill;
  onInstall: (key: string) => Promise<void>;
  onUninstall: (key: string) => Promise<void>;
  installs?: number;
  ranking?: SkillCardRanking;
  viewOnly?: boolean;
}

export function SkillCard({
  skill,
  onInstall,
  onUninstall,
  installs,
  ranking,
  viewOnly = false,
}: SkillCardProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [descriptionOverflow, setDescriptionOverflow] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(false);

  useEffect(() => {
    const description = descriptionRef.current;
    if (!description) return;
    const measure = () =>
      setDescriptionOverflow(
        description.scrollHeight > description.clientHeight,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(description);
    return () => observer.disconnect();
  }, [skill.description]);

  const handleInstall = async () => {
    setLoading(true);
    try {
      await onInstall(skill.key);
    } finally {
      setLoading(false);
    }
  };

  const handleUninstall = async () => {
    setLoading(true);
    try {
      await onUninstall(skill.key);
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
    <Card className="glass-card flex flex-col h-full transition-all duration-300 hover:shadow-lg group relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          {ranking && <RankMedal rank={ranking.rank} />}
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base font-semibold truncate">
              {skill.name}
            </CardTitle>
            <div className="flex items-center gap-2 mt-1.5">
              {showDirectory && (
                <CardDescription className="text-xs truncate">
                  {skill.directory}
                </CardDescription>
              )}
              {ranking?.platform && (
                <Badge
                  variant="outline"
                  className={cn(
                    "shrink-0 text-[10px] px-1.5 py-0 h-4",
                    PLATFORM_STYLES[ranking.platform],
                  )}
                >
                  {ranking.platform === "skills.sh" && (
                    <span aria-hidden className="mr-0.5 text-[8px]">
                      ▲
                    </span>
                  )}
                  {bestSkillsPlatformName(ranking.platform)}
                </Badge>
              )}
              {skill.repoOwner && skill.repoName && (
                <Badge
                  variant="outline"
                  className="min-w-[4.5rem] text-[10px] px-1.5 py-0 h-4 border-border-default"
                >
                  <span className="truncate">
                    {skill.repoOwner}/{skill.repoName}
                  </span>
                </Badge>
              )}
              {typeof installs === "number" && (
                <Badge
                  variant="secondary"
                  className="shrink-0 text-[10px] px-1.5 py-0 h-4"
                >
                  <Download className="h-2.5 w-2.5 mr-0.5" />
                  {installs.toLocaleString()}
                </Badge>
              )}
              {ranking && <RankingMetric metric={ranking.metric} />}
            </div>
          </div>
          {skill.installed && (
            <Badge
              variant="default"
              className="shrink-0 bg-green-600/90 hover:bg-green-600 dark:bg-green-700/90 dark:hover:bg-green-700 text-white border-0"
            >
              {t("skills.installed")}
            </Badge>
          )}
        </div>
      </CardHeader>
      {skill.description ? (
        <CardContent className="flex-1 pt-0">
          <TooltipProvider delayDuration={150} skipDelayDuration={0}>
            <Tooltip
              open={descriptionOverflow && descriptionOpen}
              onOpenChange={setDescriptionOpen}
              disableHoverableContent={false}
            >
              <TooltipTrigger asChild>
                <p
                  ref={descriptionRef}
                  tabIndex={descriptionOverflow ? 0 : undefined}
                  className={cn(
                    "text-sm text-muted-foreground/90 line-clamp-4 leading-relaxed",
                    descriptionOverflow &&
                      "cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  {skill.description}
                </p>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent
                  side="top"
                  sideOffset={8}
                  collisionPadding={16}
                  className="w-[480px] max-w-[calc(100vw-2rem)] max-h-[min(320px,var(--radix-tooltip-content-available-height))] overflow-y-auto whitespace-pre-wrap break-words select-text border border-border bg-popover px-4 py-3 text-sm leading-relaxed text-popover-foreground shadow-lg !animate-none"
                >
                  {skill.description}
                </TooltipContent>
              </TooltipPortal>
            </Tooltip>
          </TooltipProvider>
        </CardContent>
      ) : (
        <div className="flex-1" />
      )}
      <CardFooter className="flex gap-2 pt-3 border-t border-border/50 relative z-10">
        {skill.readmeUrl && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleOpenGithub}
            disabled={loading}
            className="flex-1"
          >
            <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
            {t("skills.view")}
          </Button>
        )}
        {viewOnly ? (
          !skill.readmeUrl && (
            <Button variant="outline" size="sm" disabled className="flex-1">
              {t("skills.custom.unavailable", "暂无链接")}
            </Button>
          )
        ) : skill.installed ? (
          <Button
            variant="outline"
            size="sm"
            onClick={handleUninstall}
            disabled={loading}
            className="flex-1 border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700 dark:border-red-900/50 dark:text-red-400 dark:hover:bg-red-950/50 dark:hover:text-red-300"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
            )}
            {loading ? t("skills.uninstalling") : t("skills.uninstall")}
          </Button>
        ) : (
          <Button
            variant="mcp"
            size="sm"
            onClick={handleInstall}
            disabled={loading || !skill.repoOwner}
            className="flex-1"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5 mr-1.5" />
            )}
            {loading ? t("skills.installing") : t("skills.install")}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
