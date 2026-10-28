import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SkillUsageTrend } from "@/components/skills/SkillUsageTrend";

describe("SkillUsageTrend", () => {
  it.each([
    ["day", 12, 7200],
    ["week", 7, 86400],
  ] as const)(
    "shows %s without usage as equal gray bars with zero-count details",
    async (range, length, step) => {
      const start = new Date(2026, 9, 17).getTime() / 1000;
      render(
        <SkillUsageTrend
          records={[]}
          range={range}
          boundaries={Array.from(
            { length: length + 1 },
            (_, index) => start + index * step,
          )}
          hoveredApp={null}
          status={{ completed: true, error: null }}
        />,
      );
      const trend = screen.getByTestId("skill-usage-trend");
      expect(trend).toHaveClass("w-40");
      const buckets = within(trend).getAllByRole("button");
      expect(buckets).toHaveLength(length);
      for (const bucket of buckets) {
        const bar = bucket.querySelector("[data-usage-bar]");
        expect(bar).toHaveClass("bg-muted-foreground/25", "rounded-[3px]");
        expect(bar).toHaveStyle({ height: "2px" });
      }
      expect(trend).toHaveTextContent("0");
      expect(trend).toHaveTextContent("skills.usage.times");
      expect(
        screen.queryByText(/skills\.usage\.unused/),
      ).not.toBeInTheDocument();
      const user = userEvent.setup();
      await user.hover(buckets[0]);
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip).toHaveTextContent("Claude");
      expect(tooltip).toHaveTextContent("Codex");
      expect(tooltip).toHaveTextContent("0 skills.usage.times");
    },
  );

  it.each([
    [false, null, null, "skill-usage-placeholder"],
    [false, "unavailable", null, "skills.usage.incomplete"],
    [true, null, "gemini", "skills.usage.unsupported"],
  ] as const)(
    "does not show zero usage for incomplete, failed, or unsupported data (%s, %s, %s)",
    (completed, error, hoveredApp, label) => {
      render(
        <SkillUsageTrend
          records={[]}
          range="day"
          boundaries={Array.from({ length: 13 }, (_, index) => index * 7200)}
          hoveredApp={hoveredApp}
          status={{ completed, error }}
        />,
      );
      const trend = screen.getByTestId("skill-usage-trend");
      expect(within(trend).queryAllByRole("button")).toHaveLength(0);
      expect(trend).not.toHaveTextContent("0");
      if (label === "skill-usage-placeholder") {
        expect(screen.getByTestId(label)).toBeInTheDocument();
      } else {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    },
  );

  it("has rounded stacks, spaced full-height targets, and fast details for nonzero and zero buckets", async () => {
    const start = new Date(2026, 9, 17).getTime() / 1000;
    const boundaries = Array.from(
      { length: 13 },
      (_, index) => start + index * 7200,
    );
    const record = (app: "claude" | "codex", count: number) => ({
      skillName: "test",
      app,
      count,
      sessions: 1,
      lastUsed: start,
      manualCount: 0,
      agentCount: count,
      buckets: [count, ...Array(11).fill(0)],
    });
    render(
      <SkillUsageTrend
        records={[record("codex", 3), record("claude", 2)]}
        range="day"
        boundaries={boundaries}
        hoveredApp={null}
        status={{ completed: true, error: null }}
      />,
    );
    const trend = screen.getByTestId("skill-usage-trend");
    const buckets = within(trend).getAllByRole("button");
    expect(buckets).toHaveLength(12);
    expect(buckets[0]).not.toHaveAttribute("title");
    expect(buckets[0]).toHaveClass("h-7");
    expect(buckets[0].parentElement).toHaveClass("gap-[3px]");
    expect(buckets[0].querySelector("[data-usage-bar]")).toHaveClass(
      "rounded-[3px]",
      "overflow-hidden",
      "flex-col-reverse",
    );
    expect(
      [...buckets[0].querySelectorAll("[data-usage-segment]")].map((segment) =>
        segment.getAttribute("data-usage-segment"),
      ),
    ).toEqual(["claude", "codex"]);
    expect(buckets[1].querySelector("[data-usage-bar]")).toHaveStyle({
      height: "2px",
    });
    const user = userEvent.setup();
    await user.hover(buckets[0]);
    const details = await screen.findByRole("tooltip");
    expect(details).toHaveTextContent("00:00–02:00");
    expect(details).toHaveTextContent("Claude");
    expect(details).toHaveTextContent("Codex");
    const claudeRow = within(details).getByText("Claude").closest("div");
    const codexRow = within(details).getByText("Codex").closest("div");
    expect(claudeRow?.parentElement).toHaveClass("flex-col-reverse");
    expect(claudeRow?.nextElementSibling).toBe(codexRow);
    expect(details).toHaveTextContent("skills.usage.bucketTotal");
    await user.unhover(buckets[0]);
    await user.hover(buckets[1]);
    await waitFor(() =>
      expect(screen.getByRole("tooltip")).toHaveTextContent("02:00–04:00"),
    );
    await user.unhover(buckets[1]);
    await user.tab();
    expect(buckets[0]).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("00:00–02:00");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
  });
});
