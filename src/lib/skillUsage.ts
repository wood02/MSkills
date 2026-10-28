import type { SkillUsageRange, SkillUsageSnapshot } from "@/lib/api/skills";
import type { AppId } from "@/lib/api/types";

export function skillUsageTotals(
  snapshot: SkillUsageSnapshot | undefined,
  skillNames: ReadonlySet<string>,
) {
  if (!snapshot) return undefined;
  const totals: Partial<Record<AppId, number>> = {};
  for (const record of snapshot.records) {
    if (skillNames.has(record.skillName)) {
      totals[record.app] = (totals[record.app] ?? 0) + record.count;
    }
  }
  return totals;
}

export function skillUsageBoundaries(range: SkillUsageRange, now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "week") start.setDate(start.getDate() - 6);
  return Array.from({ length: range === "day" ? 13 : 8 }, (_, index) => {
    const at = new Date(start);
    if (range === "day") at.setHours(index * 2);
    else at.setDate(start.getDate() + index);
    return Math.floor(at.getTime() / 1000);
  });
}

export const skillUsageColor = {
  claude: "bg-orange-500",
  codex: "bg-blue-500",
} as const;

export interface SkillUsageData {
  snapshots?: Record<SkillUsageRange, SkillUsageSnapshot>;
  status: Omit<
    SkillUsageSnapshot,
    "records" | "pluginSkills" | "pluginDescriptions" | "pluginSources"
  >;
}

export function settleSkillUsage(
  previous: SkillUsageData | undefined,
  snapshots: Record<SkillUsageRange, SkillUsageSnapshot>,
): SkillUsageData {
  const states = Object.values(snapshots);
  const completed = states.every(
    (state) => state.completed && !state.scanning && !state.error,
  );
  return {
    // Publish both ranges together; partial scans must not change counts or order.
    snapshots: completed ? snapshots : previous?.snapshots,
    status: {
      scanning: states.some((state) => state.scanning),
      completed,
      filesScanned: Math.max(...states.map((state) => state.filesScanned)),
      filesTotal: Math.max(...states.map((state) => state.filesTotal)),
      error: states.find((state) => state.error)?.error ?? null,
    },
  };
}
