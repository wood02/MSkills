import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, badgeVariants } from "@/components/ui/badge";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import type { AppId } from "@/lib/api/types";
import { APP_IDS, APP_ICON_MAP } from "@/config/appConfig";
import { cn } from "@/lib/utils";

export interface AppCountHoverRow {
  label: React.ReactNode;
  value: React.ReactNode;
}

interface AppCountBarProps {
  totalLabel: string;
  leading?: React.ReactNode;
  countsLabel?: React.ReactNode;
  formatCount?: (app: AppId, count: number) => React.ReactNode;
  getCountDescription?: (app: AppId, count: number) => string;
  getHoverRows?: (app: AppId, count: number) => AppCountHoverRow[];
  counts: Partial<Record<AppId, number>>;
  appIds?: AppId[];
  totalCount?: number;
  onToggleAll?: (app: AppId, enabled: boolean) => void | Promise<void>;
  pendingApp?: AppId | null;
  disabled?: boolean;
}

const HOVER_OPEN_DELAY_MS = 80;
const HOVER_CLOSE_DELAY_MS = 140;

export const AppCountBar: React.FC<AppCountBarProps> = ({
  totalLabel,
  leading,
  countsLabel,
  formatCount,
  getCountDescription,
  getHoverRows,
  counts,
  appIds = APP_IDS,
  totalCount,
  onToggleAll,
  pendingApp,
  disabled = false,
}) => {
  const { t } = useTranslation();
  const [hoveredApp, setHoveredApp] = useState<AppId | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bulkToggleEnabled = totalCount !== undefined && !!onToggleAll;
  const bulkTotalCount = totalCount ?? 0;
  const hasPendingBulkToggle = pendingApp !== undefined && pendingApp !== null;
  const canInteractWithBulk =
    bulkToggleEnabled &&
    !disabled &&
    bulkTotalCount > 0 &&
    !hasPendingBulkToggle;

  const clearHoverTimers = () => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  useEffect(() => clearHoverTimers, []);

  useEffect(() => {
    if (!canInteractWithBulk) {
      clearHoverTimers();
      setHoveredApp(null);
    }
  }, [canInteractWithBulk]);

  const scheduleOpen = (app: AppId) => {
    if (!canInteractWithBulk) return;
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (hoveredApp === app) return;
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
    }
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setHoveredApp(app);
    }, HOVER_OPEN_DELAY_MS);
  };

  const cancelClose = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = () => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    cancelClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setHoveredApp(null);
    }, HOVER_CLOSE_DELAY_MS);
  };

  const triggerBulkToggle = (app: AppId, enabled: boolean) => {
    clearHoverTimers();
    setHoveredApp(null);
    void onToggleAll?.(app, enabled);
  };

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

    const isOpen = canInteractWithBulk && hoveredApp === app;
    const remainCount = Math.max(0, bulkTotalCount - count);
    const hoverRows = isOpen ? getHoverRows?.(app, count) : undefined;
    const descriptionLines =
      isOpen && !hoverRows?.length
        ? (getCountDescription?.(app, count)
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean) ?? [])
        : [];

    return (
      <Popover
        key={app}
        open={isOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            clearHoverTimers();
            setHoveredApp((prev) => (prev === app ? null : prev));
          }
        }}
      >
        <PopoverAnchor asChild>
          <button
            type="button"
            role="checkbox"
            aria-checked={partiallyEnabled ? "mixed" : allEnabled}
            aria-busy={pending}
            aria-label={actionLabel}
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
            onMouseEnter={() => scheduleOpen(app)}
            onMouseLeave={scheduleClose}
            onClick={() => triggerBulkToggle(app, !allEnabled)}
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
        </PopoverAnchor>

        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="w-[244px] rounded-xl border-border-default px-3 py-2.5 text-xs shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-1.5">
            <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold text-foreground">
              {iconTile}
              <span className="truncate">{APP_ICON_MAP[app].label}</span>
            </span>
            <span
              className={cn(
                "inline-flex h-[18px] shrink-0 items-center rounded-full border px-1.5 text-[10.5px] font-semibold tabular-nums",
                allEnabled
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : partiallyEnabled
                    ? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"
                    : "border-border-default bg-muted/80 text-muted-foreground",
              )}
            >
              {count}/{bulkTotalCount}
            </span>
          </div>

          <div className="space-y-1 py-2 text-[11.5px]">
            {hoverRows && hoverRows.length > 0 ? (
              hoverRows.map((row, index) => (
                <div
                  key={index}
                  className="flex items-center justify-between gap-3"
                >
                  <span className="text-muted-foreground">{row.label}</span>
                  <span className="font-semibold tabular-nums text-foreground">
                    {row.value}
                  </span>
                </div>
              ))
            ) : descriptionLines.length > 0 ? (
              descriptionLines.map((line, index) => (
                <div key={index} className="leading-snug text-muted-foreground">
                  {line}
                </div>
              ))
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {t("common.enabled")}
                </span>
                <span className="font-semibold tabular-nums text-foreground">
                  {count} / {bulkTotalCount}
                </span>
              </div>
            )}
          </div>

          <div
            className={cn(
              "grid gap-1.5 border-t border-border/60 pt-2",
              partiallyEnabled ? "grid-cols-2" : "grid-cols-1",
            )}
          >
            {!allEnabled && (
              <button
                type="button"
                onClick={() => triggerBulkToggle(app, true)}
                className="inline-flex h-7 items-center justify-center whitespace-nowrap rounded-[7px] border border-blue-500/30 bg-blue-500/10 px-2 text-[11.5px] font-semibold text-blue-700 transition-colors hover:bg-blue-500/18 dark:text-blue-300"
              >
                {t("common.enableAllShort")} (
                {partiallyEnabled ? `+${remainCount}` : bulkTotalCount})
              </button>
            )}
            {count > 0 && (
              <button
                type="button"
                onClick={() => triggerBulkToggle(app, false)}
                className="inline-flex h-7 items-center justify-center whitespace-nowrap rounded-[7px] border border-rose-500/30 bg-rose-500/10 px-2 text-[11.5px] font-semibold text-rose-700 transition-colors hover:bg-rose-500/18 dark:text-rose-300"
              >
                {t("common.disableAllShort")} ({count})
              </button>
            )}
          </div>
        </PopoverContent>
      </Popover>
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
