import React from "react";
import { useTranslation } from "react-i18next";
import { Badge, badgeVariants } from "@/components/ui/badge";
import type { AppId } from "@/lib/api/types";
import { APP_IDS, APP_ICON_MAP } from "@/config/appConfig";
import { cn } from "@/lib/utils";

interface AppCountBarProps {
  totalLabel: string;
  leading?: React.ReactNode;
  countsLabel?: React.ReactNode;
  formatCount?: (app: AppId, count: number) => React.ReactNode;
  getCountDescription?: (app: AppId, count: number) => string;
  counts: Partial<Record<AppId, number>>;
  appIds?: AppId[];
  totalCount?: number;
  onToggleAll?: (app: AppId, enabled: boolean) => void | Promise<void>;
  pendingApp?: AppId | null;
  disabled?: boolean;
}

export const AppCountBar: React.FC<AppCountBarProps> = ({
  totalLabel,
  leading,
  countsLabel,
  formatCount,
  getCountDescription,
  counts,
  appIds = APP_IDS,
  totalCount,
  onToggleAll,
  pendingApp,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const bulkToggleEnabled = totalCount !== undefined && !!onToggleAll;
  const bulkTotalCount = totalCount ?? 0;
  const hasPendingBulkToggle = pendingApp !== undefined && pendingApp !== null;
  const renderCount = (app: AppId) => {
    const label = app === "dsh" ? "DSH" : APP_ICON_MAP[app].label;
    const count = counts[app] ?? 0;
    const allEnabled =
      bulkToggleEnabled && bulkTotalCount > 0 && count >= bulkTotalCount;
    const partiallyEnabled =
      bulkToggleEnabled && count > 0 && count < bulkTotalCount;
    const pending = pendingApp === app;
    const actionLabel = allEnabled
      ? t("common.disableAllForApp", { app: APP_ICON_MAP[app].label })
      : t("common.enableAllForApp", { app: APP_ICON_MAP[app].label });

    const idle = count === 0;
    const iconTile = (
      <span
        data-app-icon-tile
        aria-hidden="true"
        className={cn(
          "pointer-events-none inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border",
          idle
            ? "border-border bg-transparent opacity-65 grayscale"
            : "border-border/60 bg-background/95 shadow-[0_1px_1px_rgba(0,0,0,0.04)]",
        )}
      >
        <span className="inline-flex scale-[0.82] items-center justify-center">
          {APP_ICON_MAP[app].icon}
        </span>
      </span>
    );

    if (!bulkToggleEnabled) {
      return (
        <Badge
          key={app}
          variant="secondary"
          className={cn(
            "h-7 rounded-lg border pl-1.5 pr-2.5 text-xs",
            idle
              ? "border-border/70 bg-muted/65 text-muted-foreground"
              : APP_ICON_MAP[app].badgeClass,
          )}
        >
          {iconTile}
          <span data-app-label={label} className="font-medium opacity-90">
            {label}
          </span>
          <span className="ml-0.5 font-semibold tabular-nums">
            {formatCount?.(app, count) ?? count}
          </span>
        </Badge>
      );
    }
    return (
      <button
        key={app}
        type="button"
        role="checkbox"
        aria-checked={partiallyEnabled ? "mixed" : allEnabled}
        aria-busy={pending}
        aria-label={actionLabel}
        title={[getCountDescription?.(app, count), actionLabel]
          .filter(Boolean)
          .join("\n")}
        data-selection-state={
          pending
            ? "pending"
            : allEnabled
              ? "all"
              : partiallyEnabled
                ? "partial"
                : "none"
        }
        disabled={disabled || bulkTotalCount === 0 || hasPendingBulkToggle}
        onClick={() => void onToggleAll?.(app, !allEnabled)}
        className={cn(
          badgeVariants({ variant: "secondary" }),
          "h-7 shrink-0 cursor-pointer select-none whitespace-nowrap rounded-lg border pl-1.5 pr-2.5 text-xs transition-colors focus:ring-0 focus:ring-offset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed",
          idle
            ? "border-border/70 bg-muted/65 text-muted-foreground hover:bg-muted hover:text-foreground"
            : APP_ICON_MAP[app].badgeClass,
          pending && "cursor-wait disabled:cursor-wait",
        )}
      >
        {iconTile}
        <span data-app-label={label} className="font-medium opacity-90">
          {label}
        </span>
        <span className="ml-0.5 inline-flex items-baseline gap-1 font-semibold tabular-nums">
          {formatCount?.(app, count) ?? count}
        </span>
      </button>
    );
  };
  return (
    <div
      className={cn(
        "glass mb-4 flex flex-shrink-0 items-center gap-3.5 rounded-xl border border-border-default bg-card/90 shadow-sm",
        leading || countsLabel ? "px-3.5 py-2.5" : "px-6 py-4",
      )}
    >
      {leading ?? (
        <Badge
          variant="outline"
          className="h-7 shrink-0 whitespace-nowrap bg-background/50 px-3"
        >
          {totalLabel}
        </Badge>
      )}
      <div
        className={cn(
          "min-w-0 flex-1",
          (leading || countsLabel) &&
            "flex items-center gap-3 border-l border-border/70 pl-3.5",
        )}
      >
        {countsLabel && (
          <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
            {countsLabel}
          </span>
        )}
        <div
          className={
            leading || countsLabel
              ? "min-w-0 flex-1"
              : "overflow-x-auto no-scrollbar"
          }
        >
          <div
            className={cn(
              "flex items-center gap-2",
              leading || countsLabel
                ? "flex-wrap justify-start"
                : "ml-auto w-max min-w-full justify-end",
            )}
          >
            {appIds.map(renderCount)}
          </div>
        </div>
      </div>
    </div>
  );
};
