import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SkillUsageWeekMode } from "@/types";

export interface SkillUsageWeekModeSettingsProps {
  value: SkillUsageWeekMode;
  onChange: (value: SkillUsageWeekMode) => void;
}

export function SkillUsageWeekModeSettings({
  value,
  onChange,
}: SkillUsageWeekModeSettingsProps) {
  const { t } = useTranslation();
  const displayValue: SkillUsageWeekMode =
    value === "calendar_week" ? "calendar_week" : "rolling_7d";

  return (
    <section className="space-y-2">
      <header className="space-y-1">
        <h3 className="text-sm font-medium">
          {t("settings.skillUsageWeekMode.title")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("settings.skillUsageWeekMode.description")}
        </p>
      </header>
      <div className="inline-flex gap-1 rounded-md border border-border-default bg-background p-1">
        <WeekModeButton
          active={displayValue === "rolling_7d"}
          onClick={() => onChange("rolling_7d")}
        >
          {t("settings.skillUsageWeekMode.rolling7d")}
        </WeekModeButton>
        <WeekModeButton
          active={displayValue === "calendar_week"}
          onClick={() => onChange("calendar_week")}
        >
          {t("settings.skillUsageWeekMode.calendarWeek")}
        </WeekModeButton>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          displayValue === "calendar_week"
            ? "settings.skillUsageWeekMode.calendarWeekHint"
            : "settings.skillUsageWeekMode.rolling7dHint",
        )}
      </p>
    </section>
  );
}

interface WeekModeButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function WeekModeButton({ active, onClick, children }: WeekModeButtonProps) {
  return (
    <Button
      type="button"
      onClick={onClick}
      size="sm"
      variant={active ? "default" : "ghost"}
      className={cn(
        "min-w-[112px]",
        active
          ? "shadow-sm"
          : "text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
    >
      {children}
    </Button>
  );
}
