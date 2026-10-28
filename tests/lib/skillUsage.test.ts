import { describe, expect, it } from "vitest";
import {
  settleSkillUsage,
  skillUsageBoundaries,
  skillUsageTotals,
} from "@/lib/skillUsage";
import type { SkillUsageSnapshot } from "@/lib/api/skills";

describe("Skill usage time ranges", () => {
  const now = new Date(2026, 9, 16, 15, 30);
  it("starts today at local midnight and allocates 12 two-hour buckets", () => {
    const boundaries = skillUsageBoundaries("day", now);
    expect(boundaries).toHaveLength(13);
    expect(new Date(boundaries[0] * 1000)).toEqual(new Date(2026, 9, 16));
    expect(new Date(boundaries[1] * 1000)).toEqual(new Date(2026, 9, 16, 2));
    expect(new Date(boundaries[12] * 1000)).toEqual(new Date(2026, 9, 17));
    expect(now).toEqual(new Date(2026, 9, 16, 15, 30));
  });
  it("includes today and the previous six local calendar days", () => {
    const boundaries = skillUsageBoundaries("week", now);
    expect(boundaries).toHaveLength(8);
    expect(new Date(boundaries[0] * 1000)).toEqual(new Date(2026, 9, 10));
    expect(new Date(boundaries[7] * 1000)).toEqual(new Date(2026, 9, 17));
  });
});

describe("Skill usage scan snapshots", () => {
  const snapshot = (scanning: boolean, count = 2): SkillUsageSnapshot => ({
    scanning,
    completed: !scanning,
    filesScanned: scanning ? 1 : 10,
    filesTotal: 10,
    error: null,
    records: [
      {
        skillName: "example",
        app: "codex",
        count,
        sessions: 1,
        lastUsed: 1,
        manualCount: 0,
        agentCount: count,
        buckets: [count],
      },
    ],
  });

  it("totals each agent across the filtered skills, including disabled skills", () => {
    const data = snapshot(false, 5);
    data.records = [
      data.records[0],
      { ...data.records[0], app: "claude", count: 2 },
      { ...data.records[0], skillName: "hidden", count: 50 },
    ];
    expect(skillUsageTotals(data, new Set(["example"]))).toEqual({
      codex: 5,
      claude: 2,
    });
    expect(skillUsageTotals(data, new Set(["hidden"]))).toEqual({ codex: 50 });
  });

  it("distinguishes unavailable usage from a completed range with no matching calls", () => {
    expect(skillUsageTotals(undefined, new Set(["example"]))).toBeUndefined();
    expect(skillUsageTotals(snapshot(false), new Set(["other"]))).toEqual({});
  });

  it("withholds partial first-scan results, including a range that finishes first", () => {
    const data = settleSkillUsage(undefined, {
      day: snapshot(false),
      week: snapshot(true),
    });
    expect(data.snapshots).toBeUndefined();
    expect(data.status.scanning).toBe(true);
  });

  it("keeps both completed ranges through refreshes and errors, then publishes together", () => {
    const initial = settleSkillUsage(undefined, {
      day: snapshot(false, 2),
      week: snapshot(false, 8),
    });
    const refreshing = settleSkillUsage(initial, {
      day: snapshot(true, 3),
      week: snapshot(false, 9),
    });
    expect(refreshing.snapshots).toBe(initial.snapshots);
    const failed = settleSkillUsage(refreshing, {
      day: { ...snapshot(false, 3), completed: false, error: "unreadable" },
      week: snapshot(false, 9),
    });
    expect(failed.snapshots).toBe(initial.snapshots);
    expect(failed.status.error).toBe("unreadable");
    const completed = settleSkillUsage(failed, {
      day: snapshot(false, 4),
      week: snapshot(false, 10),
    });
    expect(completed.snapshots?.day.records[0].count).toBe(4);
    expect(completed.snapshots?.week.records[0].count).toBe(10);
    expect(completed.status.scanning).toBe(false);
  });
});
