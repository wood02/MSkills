import React from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AppId } from "@/lib/api/types";
import { APP_IDS, APP_ICON_MAP } from "@/config/appConfig";
import { cn } from "@/lib/utils";

interface AppToggleGroupProps {
  apps: Partial<Record<AppId, boolean>>;
  onToggle: (app: AppId, enabled: boolean) => void;
  appIds?: AppId[];
  disabled?: boolean;
  usage?: Partial<Record<AppId, { count: number; label: string }>>;
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
  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      {appIds.map((app) => {
        const { label, icon, activeClass } = APP_ICON_MAP[app];
        const enabled = apps[app];
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
                  {icon}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <p>
                  {label}
                  {enabled ? " ✓" : ""}
                </p>
                {usage?.[app] && (
                  <p className="max-w-64 whitespace-pre-line">
                    {usage[app].label}
                  </p>
                )}
              </TooltipContent>
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
