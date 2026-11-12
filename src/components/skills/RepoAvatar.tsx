import { memo, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Sparkles } from "lucide-react";

interface RepoAvatarProps {
  owner?: string;
  name?: string;
  className?: string;
}

/**
 * 根据作者或技能名称生成一组稳定的柔和渐变/纯色主题，用于优雅降级
 */
function getFallbackTheme(text: string) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  const themes = [
    "bg-indigo-500/10 text-indigo-600 dark:bg-indigo-500/20 dark:text-indigo-400 border-indigo-200/50 dark:border-indigo-800/40",
    "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400 border-emerald-200/50 dark:border-emerald-800/40",
    "bg-sky-500/10 text-sky-600 dark:bg-sky-500/20 dark:text-sky-400 border-sky-200/50 dark:border-sky-800/40",
    "bg-amber-500/10 text-amber-600 dark:bg-amber-500/20 dark:text-amber-400 border-amber-200/50 dark:border-amber-800/40",
    "bg-violet-500/10 text-violet-600 dark:bg-violet-500/20 dark:text-violet-400 border-violet-200/50 dark:border-violet-800/40",
    "bg-rose-500/10 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400 border-rose-200/50 dark:border-rose-800/40",
  ];
  return themes[Math.abs(hash) % themes.length];
}

/**
 * 提取 1-2 位简短缩写
 */
function getInitials(owner?: string, name?: string): string {
  if (owner) {
    const parts = owner.split(/[-_.]/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return owner.slice(0, 2).toUpperCase();
  }
  if (name) {
    const parts = name.split(/[-_.]/).filter(Boolean);
    if (parts.length >= 2) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.slice(0, 2).toUpperCase();
  }
  return "SK";
}

export const RepoAvatar = memo(function RepoAvatar({
  owner,
  name,
  className,
}: RepoAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // 24小时版本桶：同一天内 URL 完全一致，强命中浏览器磁盘缓存；满 1 天版本号自增，自动拉取最新头像
  const dayBucket = useMemo(
    () => Math.floor(Date.now() / (24 * 60 * 60 * 1000)),
    [],
  );

  const cleanOwner = owner?.trim();
  const avatarUrl = cleanOwner
    ? `https://github.com/${cleanOwner}.png?size=80&v=${dayBucket}`
    : null;

  const initials = getInitials(cleanOwner, name);
  const themeClass = getFallbackTheme(cleanOwner || name || "skills");

  if (!avatarUrl || imgError) {
    return (
      <div
        className={cn(
          "relative flex h-10 w-10 shrink-0 select-none items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted/40 shadow-sm transition-all duration-200 group-hover:scale-105 group-hover:shadow",
          className,
        )}
      >
        <div
          className={cn(
            "flex h-full w-full items-center justify-center font-bold text-xs tracking-wider",
            themeClass,
          )}
          title={cleanOwner || name}
        >
          {initials ? initials : <Sparkles className="h-4 w-4" />}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex h-10 w-10 shrink-0 select-none items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-muted/40 shadow-sm transition-all duration-200 group-hover:scale-105 group-hover:shadow",
        className,
      )}
    >
      {/* 未完成加载前的平滑骨架占位 */}
      {!loaded && (
        <div
          className={cn(
            "absolute inset-0 flex h-full w-full items-center justify-center font-bold text-xs tracking-wider",
            themeClass,
          )}
        >
          {initials}
        </div>
      )}
      <img
        src={avatarUrl}
        alt={cleanOwner || name || "skill avatar"}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setImgError(true)}
        className={cn(
          "h-full w-full object-cover transition-opacity duration-200",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
});
