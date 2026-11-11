import { useTranslation } from "react-i18next";
import { Portal as TooltipPortal } from "@radix-ui/react-tooltip";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AppId } from "@/lib/api/types";
import type {
  SkillUsageRange,
  SkillUsageSnapshot,
  SkillUsageSummary,
} from "@/lib/api/skills";
import { APP_ICON_MAP, SKILLS_APP_IDS } from "@/config/appConfig";
import { skillUsageColor } from "@/lib/skillUsage";
import { cn } from "@/lib/utils";

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`;
  }
  return tokens.toLocaleString();
}

interface Props {
  records: SkillUsageSummary[];
  boundaries: number[];
  range: SkillUsageRange;
  hoveredApp: AppId | null;
  status?: Pick<SkillUsageSnapshot, "completed" | "error">;
  mode?: "count" | "tokens";
  docTokens?: number;
}

export function SkillUsageTrend({
  records,
  boundaries,
  range,
  hoveredApp,
  status,
  mode = "count",
  docTokens,
}: Props) {
  const { t } = useTranslation();
  const visible = records
    .filter((record) => !hoveredApp || record.app === hoveredApp)
    .sort(
      (a, b) => SKILLS_APP_IDS.indexOf(a.app) - SKILLS_APP_IDS.indexOf(b.app),
    );
  const count = visible.reduce((sum, record) => sum + record.count, 0);
  const totalTokens = visible.reduce(
    (sum, record) =>
      sum + (record.inputTokens ?? 0) + (record.outputTokens ?? 0),
    0,
  );
  const inputTokens = visible.reduce(
    (sum, record) => sum + (record.inputTokens ?? 0),
    0,
  );
  const outputTokens = visible.reduce(
    (sum, record) => sum + (record.outputTokens ?? 0),
    0,
  );
  const avgPerRun = count > 0 ? Math.round(totalTokens / count) : 0;
  const totals = boundaries
    .slice(1)
    .map((_, index) =>
      visible.reduce(
        (sum, record) =>
          sum +
          (mode === "tokens"
            ? (record.tokenBuckets?.[index] ?? 0)
            : (record.buckets[index] ?? 0)),
        0,
      ),
    );
  const max = Math.max(1, ...totals);
  // Keep 12px bars in both ranges; extra day buckets extend left of the counter.
  const chartWidth = totals.length * 12 + Math.max(0, totals.length - 1) * 3;
  const unsupported = hoveredApp && !(hoveredApp in skillUsageColor);
  const usageAvailable = !unsupported && status?.completed && !status.error;
  const showCount = !unsupported && (count > 0 || usageAvailable);
  const tooltipApps = SKILLS_APP_IDS.filter(
    (app) => app in skillUsageColor && (!hoveredApp || app === hoveredApp),
  ) as (keyof typeof skillUsageColor)[];
  const formatTime = (at: number) =>
    new Date(at * 1000).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  const emptyLabel = unsupported
    ? t("skills.usage.unsupported")
    : status?.error
      ? t("skills.usage.incomplete")
      : !status?.completed
        ? t("skills.usage.scanning")
        : t(
            range === "day"
              ? "skills.usage.unusedToday"
              : "skills.usage.unusedWeek",
          );
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-2"
      style={{ width: `calc(${chartWidth}px + 3.5rem)` }}
      data-testid="skill-usage-trend"
    >
      {showCount ? (
        <TooltipProvider
          delayDuration={50}
          skipDelayDuration={0}
          disableHoverableContent
        >
          <div
            role="group"
            aria-label={
              count === 0
                ? emptyLabel
                : t("skills.usage.chartLabel", {
                    count,
                    app: hoveredApp
                      ? APP_ICON_MAP[hoveredApp].label
                      : t("skills.usage.allAgents"),
                  })
            }
            className="flex h-7 min-w-0 flex-1 items-end gap-[3px]"
          >
            {totals.map((total, index) => {
              const periodLabel =
                range === "day"
                  ? `${formatTime(boundaries[index])}–${index === totals.length - 1 ? "24:00" : formatTime(boundaries[index + 1])}`
                  : new Date(boundaries[index] * 1000).toLocaleDateString(
                      undefined,
                      { month: "short", day: "numeric" },
                    );
              const bucketCalls = visible.reduce(
                (sum, record) => sum + (record.buckets[index] ?? 0),
                0,
              );
              const bucketInput = visible.reduce(
                (sum, record) => sum + (record.inputTokenBuckets?.[index] ?? 0),
                0,
              );
              const bucketOutput = visible.reduce(
                (sum, record) =>
                  sum + (record.outputTokenBuckets?.[index] ?? 0),
                0,
              );
              const details = tooltipApps.map((app) => ({
                app,
                count: visible.reduce(
                  (sum, record) =>
                    sum +
                    (record.app === app ? (record.buckets[index] ?? 0) : 0),
                  0,
                ),
                tokens: visible.reduce(
                  (sum, record) =>
                    sum +
                    (record.app === app
                      ? (record.tokenBuckets?.[index] ?? 0)
                      : 0),
                  0,
                ),
              }));
              const totalLabel =
                mode === "tokens"
                  ? `${t("skills.usage.periodTotal", "时段消耗")}: ⚡ ${formatTokens(total)} (${bucketCalls} ${t("skills.usage.times")})`
                  : t("skills.usage.bucketTotal", {
                      count: total,
                    });
              return (
                <Tooltip key={index}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      data-usage-bucket={index}
                      aria-label={[
                        periodLabel,
                        ...details.map(({ app, count, tokens }) =>
                          mode === "tokens"
                            ? `${APP_ICON_MAP[app].label} ⚡ ${formatTokens(tokens)} (${count} ${t("skills.usage.times")})`
                            : t("skills.usage.bucketCount", {
                                app: APP_ICON_MAP[app].label,
                                count,
                              }),
                        ),
                        totalLabel,
                      ].join(" · ")}
                      className="flex h-7 min-w-0 flex-1 items-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span
                        aria-hidden="true"
                        data-usage-bar={index}
                        className={cn(
                          "flex w-full flex-col-reverse overflow-hidden rounded-[3px]",
                          total === 0 && "bg-muted-foreground/25",
                        )}
                        style={{
                          height: total ? `${(total / max) * 100}%` : "2px",
                        }}
                      >
                        {visible.map((record) => {
                          const segmentValue =
                            mode === "tokens"
                              ? (record.tokenBuckets?.[index] ?? 0)
                              : (record.buckets[index] ?? 0);
                          return (
                            <span
                              key={`${record.app}:${record.skillName}`}
                              data-usage-segment={record.app}
                              className={
                                skillUsageColor[
                                  record.app as keyof typeof skillUsageColor
                                ]
                              }
                              style={{
                                height: `${total ? (segmentValue / total) * 100 : 0}%`,
                              }}
                            />
                          );
                        })}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipPortal>
                    <TooltipContent
                      side="top"
                      sideOffset={6}
                      className="min-w-40 space-y-1.5 !animate-none"
                    >
                      <p className="font-medium">{periodLabel}</p>
                      <div className="flex flex-col-reverse gap-1.5">
                        {details.map(({ app, count, tokens }) => (
                          <div
                            key={app}
                            className="flex items-center justify-between gap-4"
                          >
                            <span className="inline-flex items-center gap-1.5">
                              <span
                                aria-hidden="true"
                                className={cn(
                                  "h-1.5 w-1.5 rounded-full",
                                  skillUsageColor[app],
                                )}
                              />
                              {APP_ICON_MAP[app].label}
                            </span>
                            <span className="tabular-nums">
                              {mode === "tokens" ? (
                                <span>
                                  <span className="font-medium">
                                    ⚡ {formatTokens(tokens)}
                                  </span>
                                  {count > 0 && (
                                    <span className="text-[10px] text-muted-foreground ml-1">
                                      ({count} {t("skills.usage.times")})
                                    </span>
                                  )}
                                </span>
                              ) : (
                                `${count} ${t("skills.usage.times")}`
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                      <div className="border-t border-primary-foreground/20 pt-1.5 flex items-center justify-between tabular-nums">
                        <span>
                          {mode === "tokens"
                            ? t("skills.usage.periodTotal", "时段消耗")
                            : t("skills.usage.totalCalls", "调用合计")}
                        </span>
                        <span className="font-medium">
                          {mode === "tokens"
                            ? `⚡ ${formatTokens(total)} (${bucketCalls} ${t("skills.usage.times")})`
                            : t("skills.usage.bucketTotal", { count: total })}
                        </span>
                      </div>
                      {mode === "tokens" &&
                        total > 0 &&
                        (bucketOutput > 0 || bucketInput > 0) && (
                          <div className="text-[10px] text-muted-foreground/80 pl-1 space-y-0.5">
                            {bucketOutput > 0 && (
                              <div className="flex items-center justify-between">
                                <span>
                                  ├{" "}
                                  {t(
                                    "skills.usage.outputTokens",
                                    "生成 Output",
                                  )}
                                </span>
                                <span className="tabular-nums">
                                  {formatTokens(bucketOutput)}
                                </span>
                              </div>
                            )}
                            {bucketInput > 0 && (
                              <div className="flex items-center justify-between">
                                <span>
                                  ├{" "}
                                  {t("skills.usage.inputTokens", "输入 Input")}
                                </span>
                                <span className="tabular-nums">
                                  {formatTokens(bucketInput)}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                      {totalTokens > 0 && (
                        <div className="border-t border-primary-foreground/20 pt-1.5 mt-1 text-[11px] space-y-0.5">
                          <div className="flex items-center justify-between font-medium">
                            <span className="text-muted-foreground/90">
                              {range === "day"
                                ? t("skills.usage.dayAggregate", "全天累计")
                                : t("skills.usage.weekAggregate", "7天累计")}
                            </span>
                            <span className="tabular-nums font-semibold">
                              ⚡ {formatTokens(totalTokens)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-muted-foreground/80 pl-1 text-[10px]">
                            <span>
                              ├ {t("skills.usage.outputTokens", "生成 Output")}
                            </span>
                            <span className="tabular-nums">
                              {formatTokens(outputTokens)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-muted-foreground/80 pl-1 text-[10px]">
                            <span>
                              ├ {t("skills.usage.inputTokens", "输入 Input")}
                            </span>
                            <span className="tabular-nums">
                              {formatTokens(inputTokens)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between text-muted-foreground/80 pl-1 text-[10px]">
                            <span>
                              ├ {t("skills.usage.avgPerRun", "单次均值")}
                            </span>
                            <span className="tabular-nums">
                              ~{formatTokens(avgPerRun)} / 次
                            </span>
                          </div>
                          {docTokens != null && docTokens > 0 && (
                            <div className="flex items-center justify-between text-muted-foreground/80 pl-1 text-[10px]">
                              <span>
                                └ {t("skills.usage.docTokens", "文档基准")}
                              </span>
                              <span className="tabular-nums">
                                ~{formatTokens(docTokens)} tokens
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </TooltipContent>
                  </TooltipPortal>
                </Tooltip>
              );
            })}
          </div>
        </TooltipProvider>
      ) : !unsupported && !status?.completed && !status?.error ? (
        <div
          role="img"
          aria-label={t("skills.usage.scanning")}
          data-testid="skill-usage-placeholder"
          className="flex h-7 min-w-0 flex-1 items-end gap-[3px]"
        >
          {boundaries.slice(1).map((_, index) => (
            <span key={index} className="h-2 flex-1 rounded-[3px] bg-muted" />
          ))}
        </div>
      ) : (
        <span className="flex-1 text-center text-[11px] text-muted-foreground">
          {emptyLabel}
        </span>
      )}
      <span
        className="flex min-w-12 shrink-0 items-baseline justify-end gap-1 whitespace-nowrap text-xs font-medium tabular-nums"
        aria-live="polite"
      >
        {unsupported
          ? "—"
          : showCount
            ? mode === "tokens"
              ? `⚡ ${formatTokens(totalTokens)}`
              : count
            : "…"}
        {showCount && mode !== "tokens" && (
          <span className="text-[10px] font-normal text-muted-foreground">
            {t("skills.usage.times")}
          </span>
        )}
      </span>
    </div>
  );
}
