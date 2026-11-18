import { useTranslation } from "react-i18next";
import { Zap } from "lucide-react";
import { Portal as TooltipPortal } from "@radix-ui/react-tooltip";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AppId } from "@/lib/api/types";
import type { SkillUsageWeekMode } from "@/types";
import type {
  SkillUsageRange,
  SkillUsageSnapshot,
  SkillUsageSummary,
} from "@/lib/api/skills";
import { APP_ICON_MAP, SKILLS_APP_IDS } from "@/config/appConfig";
import { formatTokens, skillUsageColor } from "@/lib/skillUsage";
import { cn } from "@/lib/utils";

interface Props {
  records: SkillUsageSummary[];
  boundaries: number[];
  range: SkillUsageRange;
  weekMode?: SkillUsageWeekMode;
  hoveredApp: AppId | null;
  status?: Pick<SkillUsageSnapshot, "completed" | "error">;
  mode?: "count" | "tokens";
  docTokens?: number;
}

export function SkillUsageTrend({
  records,
  boundaries,
  range,
  weekMode = "rolling_7d",
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
              : weekMode === "calendar_week"
                ? "skills.usage.unusedCalendarWeek"
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
                      weekMode === "calendar_week"
                        ? { month: "short", day: "numeric", weekday: "short" }
                        : { month: "short", day: "numeric" },
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
                  ? `${t("skills.usage.periodTotal")}: ${formatTokens(total)} (${bucketCalls} ${t("skills.usage.times")})`
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
                            ? `${APP_ICON_MAP[app].label} ${formatTokens(tokens)} (${count} ${t("skills.usage.times")})`
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
                      className="w-[264px] space-y-2 rounded-xl border border-border-default bg-popover p-3 text-popover-foreground shadow-lg !animate-none"
                    >
                      <div className="flex items-center justify-between border-b border-border/60 pb-2">
                        <span className="font-semibold text-foreground">
                          {periodLabel}
                        </span>
                        <span className="rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-sky-700 dark:text-sky-300">
                          {mode === "tokens"
                            ? `${formatTokens(total)} · ${bucketCalls} ${t("skills.usage.times")}`
                            : t("skills.usage.bucketTotal", { count: total })}
                        </span>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        {details.map(
                          ({ app, count: appBucketCount, tokens }) => {
                            const isIdle =
                              mode === "tokens"
                                ? tokens === 0 && appBucketCount === 0
                                : appBucketCount === 0;
                            return (
                              <div
                                key={app}
                                className={cn(
                                  "flex items-center justify-between gap-4",
                                  isIdle && "text-muted-foreground/75",
                                )}
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
                                      <span className="font-semibold">
                                        {formatTokens(tokens)}
                                      </span>
                                      {appBucketCount > 0 && (
                                        <span className="ml-1 text-[10px] text-muted-foreground">
                                          ({appBucketCount}{" "}
                                          {t("skills.usage.times")})
                                        </span>
                                      )}
                                    </span>
                                  ) : (
                                    <span
                                      className={cn(!isIdle && "font-semibold")}
                                    >
                                      {appBucketCount} {t("skills.usage.times")}
                                    </span>
                                  )}
                                </span>
                              </div>
                            );
                          },
                        )}
                      </div>

                      {mode === "tokens" &&
                        total > 0 &&
                        (bucketOutput > 0 || bucketInput > 0) && (
                          <div className="flex items-center justify-between rounded-md border border-border/70 bg-muted/60 px-2 py-1 text-[11px] tabular-nums text-muted-foreground">
                            <span>
                              {t("skills.usage.periodOutput")}{" "}
                              <strong className="font-semibold text-foreground">
                                {formatTokens(bucketOutput)}
                              </strong>
                            </span>
                            <span>
                              {t("skills.usage.periodInput")}{" "}
                              <strong className="font-semibold text-foreground">
                                {formatTokens(bucketInput)}
                              </strong>
                            </span>
                          </div>
                        )}

                      {totalTokens > 0 && (
                        <div className="space-y-2 rounded-lg border border-border/70 bg-muted/60 px-2.5 py-2 text-[11px]">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-muted-foreground">
                              {range === "day"
                                ? t("skills.usage.dayAggregate", { count })
                                : t(
                                    weekMode === "calendar_week"
                                      ? "skills.usage.calendarWeekAggregate"
                                      : "skills.usage.weekAggregate",
                                    { count },
                                  )}
                            </span>
                            <span className="inline-flex items-center gap-1 font-semibold tabular-nums text-foreground">
                              <Zap
                                className="h-3 w-3 shrink-0 text-amber-500"
                                aria-hidden="true"
                              />
                              {formatTokens(totalTokens)}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                            <div className="flex flex-col">
                              <span className="text-[10px] text-muted-foreground">
                                {t("skills.usage.inputTokens")}
                              </span>
                              <span className="font-semibold tabular-nums text-foreground">
                                {formatTokens(inputTokens)}
                              </span>
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[10px] text-muted-foreground">
                                {t("skills.usage.outputTokens")}
                              </span>
                              <span className="font-semibold tabular-nums text-foreground">
                                {formatTokens(outputTokens)}
                              </span>
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[10px] text-muted-foreground">
                                {t("skills.usage.avgPerRun")}
                              </span>
                              <span className="font-semibold tabular-nums text-foreground">
                                {t("skills.usage.avgPerCallUnit", {
                                  value: formatTokens(avgPerRun),
                                })}
                              </span>
                            </div>
                            {docTokens != null && docTokens > 0 && (
                              <div className="flex flex-col">
                                <span className="text-[10px] text-muted-foreground">
                                  {t("skills.usage.docTokens")}
                                </span>
                                <span className="font-semibold tabular-nums text-foreground">
                                  ~{formatTokens(docTokens)} tokens
                                </span>
                              </div>
                            )}
                          </div>

                          <p className="border-t border-border/50 pt-1.5 text-[10px] leading-snug text-muted-foreground">
                            {t("skills.usage.tokenScopeHint")}
                          </p>
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
        {unsupported ? (
          "—"
        ) : showCount ? (
          mode === "tokens" ? (
            <span className="inline-flex items-center gap-1 text-purple-700 dark:text-purple-300">
              <Zap className="h-3 w-3 shrink-0" aria-hidden="true" />
              {formatTokens(totalTokens)}
            </span>
          ) : (
            count
          )
        ) : (
          "…"
        )}
        {showCount && mode !== "tokens" && (
          <span className="text-[10px] font-normal text-muted-foreground">
            {t("skills.usage.times")}
          </span>
        )}
      </span>
    </div>
  );
}
