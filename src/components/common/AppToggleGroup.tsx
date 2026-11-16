import React from "react";
import { useTranslation } from "react-i18next";
import { Check, Zap } from "lucide-react";
import { Portal as TooltipPortal } from "@radix-ui/react-tooltip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AppId } from "@/lib/api/types";
import { APP_IDS, APP_ICON_MAP } from "@/config/appConfig";
import { formatTokens, skillUsageColor } from "@/lib/skillUsage";
import { cn } from "@/lib/utils";

export interface AppToggleUsage {
  count: number;
  label: string;
  sessions?: number;
  manualCount?: number;
  agentCount?: number;
  tokens?: number;
  lastUsed?: string;
  warning?: string;
  note?: string;
  emptyLabel?: string;
}

interface AppToggleGroupProps {
  apps: Partial<Record<AppId, boolean>>;
  onToggle: (app: AppId, enabled: boolean) => void;
  appIds?: AppId[];
  disabled?: boolean;
  usage?: Partial<Record<AppId, AppToggleUsage>>;
  hoveredApp?: AppId | null;
  onAppHover?: (app: AppId | null) => void;
}

export const AppToggleGroup: React.FC<AppToggleGroupProps> = ({
  apps,
  onToggle,
  appIds = APP_IDS,
  disabled = false,
  usage,
  hoveredApp,
  onAppHover,
}) => {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {appIds.map((app) => {
        const { label, icon, activeClass } = APP_ICON_MAP[app];
        const enabled = apps[app];
        const itemUsage = usage?.[app];
        const hasMetrics = itemUsage?.sessions !== undefined;
        const hasFallbackText = Boolean(
          itemUsage && (itemUsage.emptyLabel || itemUsage.label),
        );
        const hasBody = hasMetrics || hasFallbackText;
        const dotClass =
          skillUsageColor[app as keyof typeof skillUsageColor] ??
          "bg-muted-foreground/60";

        return (
          <div
            key={app}
            className="relative"
            onMouseEnter={() => onAppHover?.(app)}
            onMouseLeave={() => onAppHover?.(null)}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onToggle(app, !enabled)}
                  disabled={disabled}
                  aria-label={label}
                  aria-pressed={Boolean(enabled)}
                  onFocus={() => onAppHover?.(app)}
                  onBlur={() => onAppHover?.(null)}
                  className={cn(
                    `w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
                      enabled ? activeClass : "opacity-35 hover:opacity-70"
                    } disabled:cursor-not-allowed`,
                    hoveredApp === app && "ring-2 ring-ring opacity-100",
                  )}
                >
                  {icon && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none inline-flex items-center justify-center"
                    >
                      {icon}
                    </span>
                  )}
                </button>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent
                  side="bottom"
                  sideOffset={6}
                  className={cn(
                    "rounded-xl border border-border-default bg-popover text-xs text-popover-foreground shadow-lg !animate-none",
                    hasMetrics
                      ? "w-[244px] space-y-2 p-3"
                      : hasBody
                        ? "min-w-[180px] max-w-[244px] space-y-2 px-3 py-2.5"
                        : "min-w-[164px] px-2.5 py-2",
                  )}
                >
                  <div
                    className={cn(
                      "flex items-center justify-between gap-2",
                      hasBody && "border-b border-border/60 pb-2",
                    )}
                  >
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-foreground">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "h-1.5 w-1.5 shrink-0 rounded-full",
                          dotClass,
                        )}
                      />
                      {label}
                    </span>
                    {itemUsage?.warning ? (
                      <span className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-amber-500/35 bg-amber-500/12 px-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300">
                        {t("skills.usage.statusClosed")}
                      </span>
                    ) : enabled ? (
                      <span className="inline-flex h-[18px] shrink-0 items-center gap-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                        <Check
                          className="h-2.5 w-2.5 shrink-0"
                          aria-hidden="true"
                        />
                        {t("skills.usage.statusEnabled")}
                      </span>
                    ) : (
                      <span className="inline-flex h-[18px] shrink-0 items-center rounded-full border border-border-default bg-muted/80 px-1.5 text-[10px] font-medium text-muted-foreground">
                        {t("skills.usage.statusDisabled")}
                      </span>
                    )}
                  </div>

                  {hasMetrics && itemUsage ? (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-x-2.5 gap-y-2 rounded-lg border border-border/70 bg-muted/60 px-2.5 py-2">
                        <div className="flex flex-col">
                          <span className="text-[10px] text-muted-foreground">
                            {t("skills.usage.callsSessions")}
                          </span>
                          <span className="font-semibold tabular-nums text-foreground">
                            {itemUsage.count} {t("skills.usage.times")}
                            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                              ·{" "}
                              {t("skills.usage.sessionCount", {
                                count: itemUsage.sessions ?? 0,
                              })}
                            </span>
                          </span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] text-muted-foreground">
                            {t("skills.usage.manualAgent")}
                          </span>
                          <span className="font-semibold tabular-nums text-foreground">
                            {itemUsage.manualCount ?? 0}
                            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
                              / {itemUsage.agentCount ?? 0}
                            </span>
                          </span>
                        </div>
                        {itemUsage.tokens != null && itemUsage.tokens > 0 && (
                          <div className="col-span-2 flex items-center justify-between border-t border-border/50 pt-1.5">
                            <span className="text-[10px] text-muted-foreground">
                              {t("skills.usage.totalTokens")}
                            </span>
                            <span className="inline-flex items-center gap-1 font-semibold tabular-nums text-foreground">
                              <Zap
                                className="h-3 w-3 shrink-0 text-amber-500"
                                aria-hidden="true"
                              />
                              {formatTokens(itemUsage.tokens)}
                            </span>
                          </div>
                        )}
                      </div>

                      {itemUsage.lastUsed && (
                        <div className="flex items-center justify-between gap-2 text-[11px]">
                          <span className="text-muted-foreground">
                            {t("skills.usage.lastUsedLabel")}
                          </span>
                          <span className="font-medium tabular-nums text-foreground">
                            {itemUsage.lastUsed}
                          </span>
                        </div>
                      )}

                      {itemUsage.warning && (
                        <p className="rounded-md border border-amber-500/35 bg-amber-500/12 px-2 py-1 text-[10.5px] leading-snug text-amber-700 dark:text-amber-300">
                          {itemUsage.warning}
                        </p>
                      )}

                      {itemUsage.note && (
                        <p className="border-t border-border/50 pt-1.5 text-[10px] leading-snug text-muted-foreground/80">
                          {itemUsage.note}
                        </p>
                      )}
                    </div>
                  ) : (
                    hasFallbackText &&
                    itemUsage && (
                      <p className="whitespace-pre-line text-[11.5px] leading-relaxed text-muted-foreground">
                        {itemUsage.emptyLabel ?? itemUsage.label}
                      </p>
                    )
                  )}
                </TooltipContent>
              </TooltipPortal>
            </Tooltip>
            {!!usage?.[app]?.count && (
              <span
                data-usage-app={app}
                data-usage-warning={!enabled || undefined}
                className={cn(
                  "pointer-events-none absolute -right-1.5 -top-1.5 z-10 min-w-3.5 rounded-full px-1 text-center text-[10px] font-medium leading-[15px]",
                  enabled
                    ? app === "codex"
                      ? "bg-blue-500 text-white"
                      : app === "claude"
                        ? "bg-[#D97757] text-white"
                        : app === "antigravity"
                          ? "bg-antigravity-gradient-badge text-white"
                          : "bg-black text-white"
                    : "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-100",
                )}
              >
                {usage[app].count}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
};
