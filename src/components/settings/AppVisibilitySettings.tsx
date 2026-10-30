import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";
import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToggleRow } from "@/components/ui/toggle-row";
import { cn } from "@/lib/utils";
import { ProviderIcon } from "@/components/ProviderIcon";
import type { SettingsFormState } from "@/hooks/useSettings";
import type { VisibleApps } from "@/types";
import type { AppId } from "@/lib/api";
import { DEFAULT_VISIBLE_APPS } from "@/config/appConfig";

interface AppVisibilitySettingsProps {
  settings: SettingsFormState;
  onChange: (updates: Partial<SettingsFormState>) => void;
}

const APP_CONFIG: Array<{
  id: AppId;
  icon: string;
  nameKey: string;
}> = [
  { id: "claude", icon: "claude", nameKey: "apps.claudeCode" },
  {
    id: "claude-desktop",
    icon: "claude",
    nameKey: "apps.claudeDesktop",
  },
  { id: "codex", icon: "codex", nameKey: "apps.codex" },
  { id: "gemini", icon: "gemini", nameKey: "apps.gemini" },
  { id: "grokbuild", icon: "grok", nameKey: "apps.grokbuild" },
  { id: "opencode", icon: "opencode", nameKey: "apps.opencode" },
  { id: "openclaw", icon: "openclaw", nameKey: "apps.openclaw" },
  { id: "hermes", icon: "hermes", nameKey: "apps.hermes" },
  { id: "pi", icon: "pi", nameKey: "apps.pi" },
  { id: "dsh", icon: "deepseek", nameKey: "apps.dsh" },
  { id: "mcode", icon: "minimax", nameKey: "apps.mcode" },
];

export function AppVisibilitySettings({
  settings,
  onChange,
}: AppVisibilitySettingsProps) {
  const { t } = useTranslation();

  const visibleApps: VisibleApps = settings.visibleApps ?? DEFAULT_VISIBLE_APPS;
  const savedProfile = settings.dshProfile ?? "web";
  // Settings autosave on change, so keep keystrokes local until the profile is committed.
  const [profile, setProfile] = useState(savedProfile);
  useEffect(() => setProfile(savedProfile), [savedProfile]);
  const profileValid = /^[A-Za-z0-9_-]*$/.test(profile.trim());
  const commitProfile = () => {
    const next = profile.trim() || "web";
    if (!profileValid) return;
    setProfile(next);
    if (next !== savedProfile) onChange({ dshProfile: next });
  };

  // Count how many apps are currently visible
  const visibleCount = Object.values(visibleApps).filter(Boolean).length;

  const handleToggle = (appId: AppId) => {
    const isCurrentlyVisible = visibleApps[appId];
    // Prevent disabling the last visible app
    if (isCurrentlyVisible && visibleCount <= 1) return;

    onChange({
      visibleApps: {
        ...visibleApps,
        [appId]: !isCurrentlyVisible,
      },
    });
  };

  return (
    <section className="space-y-2">
      <header className="space-y-1">
        <h3 className="text-sm font-medium">
          {t("settings.appVisibility.title")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("settings.appVisibility.description")}
        </p>
      </header>
      <div className="flex flex-wrap gap-1 rounded-md border border-border-default bg-background p-1">
        {APP_CONFIG.map((app) => {
          const isVisible =
            visibleApps[app.id] ?? DEFAULT_VISIBLE_APPS[app.id] ?? true;
          // Disable button if this is the last visible app
          const isDisabled = isVisible && visibleCount <= 1;

          return (
            <AppButton
              key={app.id}
              active={isVisible}
              disabled={isDisabled}
              onClick={() => handleToggle(app.id)}
              icon={app.icon}
              name={t(app.nameKey)}
            >
              {t(app.nameKey)}
            </AppButton>
          );
        })}
      </div>
      <div className="space-y-2 pt-2">
        <Label htmlFor="dsh-profile">{t("dsh.profile")}</Label>
        <Input
          id="dsh-profile"
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          onBlur={commitProfile}
          onKeyDown={(e) => e.key === "Enter" && commitProfile()}
          aria-invalid={!profileValid}
          placeholder="web"
        />
        {!profileValid && (
          <p className="text-xs text-destructive">{t("dsh.profileInvalid")}</p>
        )}
        <p className="text-xs text-muted-foreground">{t("dsh.profileHint")}</p>
      </div>
      <ToggleRow
        icon={<Filter className="h-4 w-4 text-violet-500" />}
        title={t("settings.appVisibility.skillsFollowVisibleApps")}
        description={t(
          "settings.appVisibility.skillsFollowVisibleAppsDescription",
        )}
        checked={settings.skillsFollowVisibleApps ?? false}
        onCheckedChange={(value) =>
          onChange({ skillsFollowVisibleApps: value })
        }
      />
    </section>
  );
}

interface AppButtonProps {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  icon: string;
  name: string;
  children: React.ReactNode;
}

function AppButton({
  active,
  disabled,
  onClick,
  icon,
  name,
  children,
}: AppButtonProps) {
  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={disabled}
      size="sm"
      variant={active ? "default" : "ghost"}
      className={cn(
        "min-w-[90px] w-auto gap-1.5 px-3",
        active
          ? "shadow-sm"
          : "text-muted-foreground hover:text-foreground hover:bg-muted",
      )}
    >
      <ProviderIcon icon={icon} name={name} size={14} />
      {children}
    </Button>
  );
}
