import { createRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { BestSkillsRow, BestSkillsRanking } from "@/lib/bestSkills";
import { settingsApi } from "@/lib/api";

import {
  SkillsPage,
  getSkillsPageHeaderActions,
  type SkillsPageHandle,
} from "@/components/skills/SkillsPage";
import type {
  DiscoverableSkill,
  SkillRepo,
  SkillsShDiscoverableSkill,
  SkillsShSearchResult,
  SkillsShLeaderboardResult,
  SkillsShLeaderboardView,
} from "@/lib/api/skills";

const installMutateAsyncMock = vi.fn();
let discoverableSkillsMock: DiscoverableSkill[] = [];
let skillReposMock: SkillRepo[] = [];
const refetchDiscoverableMock = vi.fn();
const fetchLeaderboardPageMock = vi.fn();
const refetchLeaderboardMock = vi.fn();
const refetchCustomMock = vi.fn();
const refetchHistoryMock = vi.fn();
let historyDatesMock: string[] = [];
let historyErrorMock = false;
const customRankingCache = new Map<
  string,
  {
    data?: BestSkillsRow[] | null;
    isError?: boolean;
    error?: Error;
  }
>();
const leaderboardCache = new Map<
  SkillsShLeaderboardView,
  {
    data?: { pages: SkillsShLeaderboardResult[] };
    hasNextPage?: boolean;
    isLoading?: boolean;
    isFetching?: boolean;
    isFetchNextPageError?: boolean;
    error?: Error;
  }
>();

// Stable cache so repeated renders see referentially-equal data.
// SkillsPage has `useEffect([skillsShResult, ...])` that calls setState — a
// fresh object every render would loop forever.
const searchCache = new Map<
  string,
  {
    data: SkillsShSearchResult | undefined;
    isLoading: boolean;
    isFetching: boolean;
    isPlaceholderData?: boolean;
  }
>();

const setSearchResult = (
  query: string,
  offset: number,
  result: SkillsShSearchResult | undefined,
  state: Partial<{
    isLoading: boolean;
    isFetching: boolean;
    isPlaceholderData: boolean;
  }> = {},
) => {
  searchCache.set(`${query}:${offset}`, {
    data: result,
    isLoading: false,
    isFetching: false,
    ...state,
  });
};

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/hooks/useSkills", () => ({
  useBestSkillsDates: () => ({
    data: historyDatesMock,
    isError: historyErrorMock,
    isFetching: false,
    refetch: refetchHistoryMock,
  }),
  useBestSkillsRanking: (ranking: BestSkillsRanking, date: string) => ({
    data: undefined,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: refetchCustomMock,
    ...customRankingCache.get(`${ranking}:${date}`),
  }),
  useDiscoverableSkills: () => ({
    data: discoverableSkillsMock,
    isLoading: false,
    isFetching: false,
    refetch: refetchDiscoverableMock,
  }),
  useInstalledSkills: () => ({
    data: [],
    isLoading: false,
  }),
  useInstallSkill: () => ({
    mutateAsync: installMutateAsyncMock,
  }),
  useSkillRepos: () => ({
    data: skillReposMock,
    refetch: vi.fn(),
  }),
  useAddSkillRepo: () => ({
    mutateAsync: vi.fn(),
  }),
  useRemoveSkillRepo: () => ({
    mutateAsync: vi.fn(),
  }),
  useSearchSkillsSh: (query: string, _limit: number, offset: number) => {
    const cached = searchCache.get(`${query}:${offset}`);
    if (cached) return { ...cached, refetch: vi.fn() };
    return {
      data: undefined,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
  useSkillsShLeaderboard: (view: SkillsShLeaderboardView) => ({
    data: undefined,
    hasNextPage: false,
    isLoading: false,
    isFetching: false,
    fetchNextPage: fetchLeaderboardPageMock,
    refetch: refetchLeaderboardMock,
    ...leaderboardCache.get(view),
  }),
}));

const makeSkillsShSkill = (
  overrides: Partial<SkillsShDiscoverableSkill> = {},
): SkillsShDiscoverableSkill => ({
  key: "agent-browser:owner-a:repo-a",
  name: "Agent Browser",
  directory: "agent-browser",
  repoOwner: "owner-a",
  repoName: "repo-a",
  repoBranch: "main",
  installs: 100,
  readmeUrl: "https://example.com/a",
  ...overrides,
});

const makeDiscoverableSkill = (
  overrides: Partial<DiscoverableSkill> = {},
): DiscoverableSkill => ({
  key: "repo-skill:owner-a:repo-a",
  name: "Repo Skill",
  description: "Skill from a configured repository",
  directory: "repo-skill",
  readmeUrl: "https://example.com/repo-skill",
  repoOwner: "owner-a",
  repoName: "repo-a",
  repoBranch: "main",
  ...overrides,
});

const makeSkillRepo = (overrides: Partial<SkillRepo> = {}): SkillRepo => ({
  owner: "owner-a",
  name: "repo-a",
  branch: "main",
  enabled: true,
  ...overrides,
});

const makeCustomRow = (
  overrides: Partial<BestSkillsRow> = {},
): BestSkillsRow => ({
  key: "custom-row",
  rank: 1,
  name: "Custom Skill",
  description: "A reusable skill",
  metric: { icon: "award", label: "综合分", value: "99" },
  platform: "skills.sh",
  skill: makeDiscoverableSkill({ name: "Custom Skill" }),
  ...overrides,
});

describe("SkillsPage - skills.sh install (regression)", () => {
  beforeEach(() => {
    installMutateAsyncMock.mockReset();
    installMutateAsyncMock.mockResolvedValue({});
    discoverableSkillsMock = [];
    skillReposMock = [];
    refetchDiscoverableMock.mockReset();
    searchCache.clear();
    leaderboardCache.clear();
    customRankingCache.clear();
    historyDatesMock = [];
    historyErrorMock = false;
    refetchCustomMock.mockReset();
    refetchHistoryMock.mockReset();
    fetchLeaderboardPageMock.mockReset();
    refetchLeaderboardMock.mockReset();
  });

  it("installs a Custom skill through the existing v3 installer", async () => {
    const row = makeCustomRow();
    customRankingCache.set("best-100:latest", { data: [row] });
    const onSourceChange = vi.fn();
    render(<SkillsPage initialApp="codex" onSourceChange={onSourceChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Custom" }));
    expect(onSourceChange).toHaveBeenLastCalledWith("custom");
    expect(screen.getByText("Custom Skill")).toBeInTheDocument();
    expect(screen.getByLabelText("#1")).toBeInTheDocument();
    expect(screen.getByTitle("综合分 99")).toHaveTextContent("99");
    await user.click(screen.getByRole("button", { name: "skills.install" }));
    expect(installMutateAsyncMock).toHaveBeenCalledWith({
      currentApp: "codex",
      skill: row.skill,
    });
  });

  it("switches Custom rankings and dates without mixing results", async () => {
    historyDatesMock = ["2026-10-14"];
    customRankingCache.set("best-100:latest", { data: [makeCustomRow()] });
    customRankingCache.set("trending-7d:latest", {
      data: [
        makeCustomRow({
          name: "Weekly Skill",
          skill: makeDiscoverableSkill({ name: "Weekly Skill" }),
        }),
      ],
    });
    customRankingCache.set("trending-7d:2026-10-14", {
      data: [
        makeCustomRow({
          name: "History Skill",
          skill: makeDiscoverableSkill({ name: "History Skill" }),
        }),
      ],
    });
    render(<SkillsPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Custom" }));
    await user.click(screen.getByRole("combobox", { name: "榜单" }));
    await user.click(screen.getByRole("option", { name: "近七天趋势" }));
    expect(screen.getByText("Weekly Skill")).toBeInTheDocument();
    expect(screen.queryByText("Custom Skill")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "数据日期" }));
    await user.click(screen.getByRole("option", { name: "2026-10-14" }));
    expect(screen.getByText("History Skill")).toBeInTheDocument();
    expect(screen.queryByText("Weekly Skill")).not.toBeInTheDocument();
  });

  it("offers a return to latest when a snapshot is missing", async () => {
    historyDatesMock = ["2026-10-14"];
    customRankingCache.set("best-100:latest", { data: [makeCustomRow()] });
    customRankingCache.set("best-100:2026-10-14", { data: null });
    render(<SkillsPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Custom" }));
    await user.click(screen.getByRole("combobox", { name: "数据日期" }));
    await user.click(screen.getByRole("option", { name: "2026-10-14" }));
    expect(screen.getByText("该日期暂无此榜单")).toBeInTheDocument();
    expect(screen.queryByText("Custom Skill")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "切回最新" }));
    expect(screen.getByText("Custom Skill")).toBeInTheDocument();
  });

  it("hides raw ranking errors and retries the ranking and date index", async () => {
    customRankingCache.set("best-100:latest", {
      isError: true,
      error: new Error("Unavailable"),
    });
    render(<SkillsPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Custom" }));
    expect(screen.getByRole("alert")).toHaveTextContent("榜单读取失败");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Unavailable");
    await user.click(
      screen.getByRole("button", { name: "skills.skillssh.retry" }),
    );
    expect(refetchCustomMock).toHaveBeenCalledTimes(1);
    expect(refetchHistoryMock).toHaveBeenCalledTimes(1);
  });

  it("keeps latest results usable when the date index fails", async () => {
    historyErrorMock = true;
    customRankingCache.set("best-100:latest", { data: [makeCustomRow()] });
    render(<SkillsPage />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Custom" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "历史日期读取失败，仍可查看最新榜单",
    );
    expect(screen.getByText("Custom Skill")).toBeInTheDocument();
  });

  it("only offers viewing for non-installable Custom rows", async () => {
    const open = vi
      .spyOn(settingsApi, "openExternal")
      .mockResolvedValue(undefined);
    customRankingCache.set("best-100:latest", {
      data: [
        makeCustomRow({
          name: "Vendor",
          skill: undefined,
          url: "https://github.com/owner/repo",
        }),
      ],
    });
    render(<SkillsPage />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Custom" }));
    expect(
      screen.queryByRole("button", { name: "skills.install" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "skills.view" }));
    expect(open).toHaveBeenCalledWith("https://github.com/owner/repo");
    expect(installMutateAsyncMock).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("installs the second skill when two results share the same directory", async () => {
    const first = makeSkillsShSkill({
      key: "agent-browser:owner-a:repo-a",
      name: "Agent Browser A",
      repoOwner: "owner-a",
      repoName: "repo-a",
    });
    const second = makeSkillsShSkill({
      key: "agent-browser:owner-b:repo-b",
      name: "Agent Browser B",
      repoOwner: "owner-b",
      repoName: "repo-b",
    });

    setSearchResult("agent", 0, {
      skills: [first, second],
      totalCount: 2,
      query: "agent",
    });

    const ref = createRef<SkillsPageHandle>();
    render(<SkillsPage ref={ref} initialApp="claude" />);

    const user = userEvent.setup();

    // Switch to skills.sh source
    await user.click(screen.getByRole("button", { name: /skills\.sh/i }));

    // Type a query and submit
    const input = screen.getByPlaceholderText(
      "skills.skillssh.searchPlaceholder",
    );
    await user.type(input, "agent");
    await user.click(screen.getByRole("button", { name: "skills.search" }));

    // Wait for both cards to render
    await waitFor(() => {
      expect(screen.getByText("Agent Browser A")).toBeInTheDocument();
      expect(screen.getByText("Agent Browser B")).toBeInTheDocument();
    });

    // Click install on the SECOND card (Agent Browser B)
    const secondCard = screen
      .getByText("Agent Browser B")
      .closest("div.glass-card");
    expect(secondCard).not.toBeNull();
    const installButton = secondCard!.querySelector(
      "button:last-of-type",
    ) as HTMLButtonElement;
    expect(installButton).not.toBeNull();
    await user.click(installButton);

    // Verify the SECOND skill was passed to the install mutation, not the first
    await waitFor(() => {
      expect(installMutateAsyncMock).toHaveBeenCalledTimes(1);
    });
    const callArgs = installMutateAsyncMock.mock.calls[0][0];
    expect(callArgs.skill.repoOwner).toBe("owner-b");
    expect(callArgs.skill.repoName).toBe("repo-b");
    expect(callArgs.skill.name).toBe("Agent Browser B");
  });

  it("keeps skills.sh results when submitting the same query again", async () => {
    const figmaSkill = makeSkillsShSkill({
      key: "figma-use:figma:mcp-server-guide",
      name: "figma-use",
      directory: "figma-use",
      repoOwner: "figma",
      repoName: "mcp-server-guide",
    });

    setSearchResult("figma", 0, {
      skills: [figmaSkill],
      totalCount: 1,
      query: "figma",
    });

    render(<SkillsPage initialApp="claude" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /skills\.sh/i }));
    const input = screen.getByPlaceholderText(
      "skills.skillssh.searchPlaceholder",
    );
    await user.type(input, "figma");

    const searchButton = screen.getByRole("button", {
      name: "skills.search",
    });
    await user.click(searchButton);

    await waitFor(() => {
      expect(screen.getByText("figma-use")).toBeInTheDocument();
    });

    await user.click(searchButton);

    expect(screen.getByText("figma-use")).toBeInTheDocument();
  });

  it("shows the skills.sh loading state while a new query is fetching", async () => {
    const figmaSkill = makeSkillsShSkill({
      key: "figma-use:figma:mcp-server-guide",
      name: "figma-use",
      directory: "figma-use",
      repoOwner: "figma",
      repoName: "mcp-server-guide",
    });

    setSearchResult("figma", 0, {
      skills: [figmaSkill],
      totalCount: 1,
      query: "figma",
    });
    setSearchResult("react", 0, undefined, { isFetching: true });

    render(<SkillsPage initialApp="claude" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /skills\.sh/i }));
    const input = screen.getByPlaceholderText(
      "skills.skillssh.searchPlaceholder",
    );
    await user.type(input, "figma");

    const searchButton = screen.getByRole("button", {
      name: "skills.search",
    });
    await user.click(searchButton);

    await waitFor(() => {
      expect(screen.getByText("figma-use")).toBeInTheDocument();
    });

    await user.clear(input);
    await user.type(input, "react");
    await user.click(searchButton);

    expect(screen.getByText("skills.skillssh.loading")).toBeInTheDocument();
  });

  it("reports the effective skills.sh source to parent chrome", async () => {
    const onSourceChange = vi.fn();

    render(<SkillsPage initialApp="claude" onSourceChange={onSourceChange} />);

    await waitFor(() => {
      expect(onSourceChange).toHaveBeenCalledWith("skillssh");
    });
  });

  it("keeps the selected repository source when configured repositories return no discoverable skills", async () => {
    skillReposMock = [makeSkillRepo()];
    const onSourceChange = vi.fn();

    render(<SkillsPage initialApp="claude" onSourceChange={onSourceChange} />);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "skills.searchSource.repos" }));

    await waitFor(() => {
      expect(onSourceChange).toHaveBeenCalledWith("repos");
    });
    expect(
      screen.getByPlaceholderText("skills.searchPlaceholder"),
    ).toBeVisible();
  });

  it("can switch back to repository results after discoverable skills refresh", async () => {
    const onSourceChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <SkillsPage initialApp="claude" onSourceChange={onSourceChange} />,
    );

    await waitFor(() => {
      expect(onSourceChange).toHaveBeenCalledWith("skillssh");
    });

    await user.click(screen.getByRole("button", { name: /skills\.sh/i }));

    discoverableSkillsMock = [makeDiscoverableSkill()];
    skillReposMock = [makeSkillRepo()];
    rerender(
      <SkillsPage initialApp="claude" onSourceChange={onSourceChange} />,
    );

    await user.click(
      screen.getByRole("button", { name: "skills.searchSource.repos" }),
    );

    expect(screen.getByText("Repo Skill")).toBeInTheDocument();
    expect(onSourceChange).toHaveBeenCalledWith("repos");
  });

  it("exposes repository-only header actions for the parent chrome", () => {
    expect(
      getSkillsPageHeaderActions("repos").map((action) => action.key),
    ).toEqual(["refresh-repos", "manage-repos"]);
    expect(
      getSkillsPageHeaderActions("skillssh").map((action) => action.key),
    ).toEqual(["manage-repos"]);
  });

  it("defaults to the 24-hour leaderboard and installs by the selected repository key", async () => {
    leaderboardCache.set("trending", {
      data: {
        pages: [
          {
            skills: [makeSkillsShSkill({ name: "Leaderboard Skill" })],
            totalCount: 250,
            hasMore: true,
          },
        ],
      },
      hasNextPage: true,
    });
    skillReposMock = [makeSkillRepo()];
    render(<SkillsPage initialApp="codex" />);
    expect(screen.getByText("Leaderboard Skill")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "skills.skillssh.loadMore" }),
    );
    expect(fetchLeaderboardPageMock).toHaveBeenCalledTimes(1);
    const card = screen
      .getByText("Leaderboard Skill")
      .closest("div.glass-card")!;
    await user.click(card.querySelector("button:last-of-type")!);
    expect(installMutateAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentApp: "codex",
        skill: expect.objectContaining({
          repoOwner: "owner-a",
          repoName: "repo-a",
        }),
      }),
    );
  });

  it("changes between the three server rankings without mixing pages", async () => {
    for (const [view, name] of [
      ["all-time", "Total Skill"],
      ["trending", "Trending Skill"],
      ["hot", "Hot Skill"],
    ] as const) {
      leaderboardCache.set(view, {
        data: {
          pages: [
            {
              skills: [makeSkillsShSkill({ name })],
              totalCount: 1,
              hasMore: false,
            },
          ],
        },
      });
    }
    render(<SkillsPage />);
    const user = userEvent.setup();
    expect(screen.getByText("Trending Skill")).toBeInTheDocument();
    await user.click(
      screen.getByRole("combobox", { name: "skills.skillssh.sortLabel" }),
    );
    await user.click(
      screen.getByRole("option", { name: "skills.skillssh.sortAllTime" }),
    );
    expect(screen.getByText("Total Skill")).toBeInTheDocument();
    expect(screen.queryByText("Trending Skill")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("combobox", { name: "skills.skillssh.sortLabel" }),
    );
    await user.click(
      screen.getByRole("option", { name: "skills.skillssh.sortHot" }),
    );
    expect(screen.getByText("Hot Skill")).toBeInTheDocument();
    expect(screen.queryByText("Total Skill")).not.toBeInTheDocument();
  });

  it("returns to the leaderboard when clearing a submitted search", async () => {
    leaderboardCache.set("trending", {
      data: {
        pages: [
          {
            skills: [makeSkillsShSkill({ name: "Trending Skill" })],
            totalCount: 1,
            hasMore: false,
          },
        ],
      },
    });
    setSearchResult("react", 0, {
      skills: [makeSkillsShSkill({ name: "React Skill" })],
      totalCount: 1,
      query: "react",
    });
    render(<SkillsPage />);
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(
      "skills.skillssh.searchPlaceholder",
    );
    await user.type(input, "react");
    await user.click(screen.getByRole("button", { name: "skills.search" }));
    expect(screen.getByText("React Skill")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "skills.skillssh.sortLabel" }),
    ).toBeDisabled();
    await user.clear(input);
    expect(screen.getByText("Trending Skill")).toBeInTheDocument();
    expect(screen.queryByText("React Skill")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "skills.skillssh.sortLabel" }),
    ).toBeEnabled();
  });

  it("preserves loaded rows after a pagination error and offers retry", async () => {
    const skill = makeSkillsShSkill({ name: "Loaded Skill" });
    leaderboardCache.set("trending", {
      data: {
        pages: [
          { skills: [skill], totalCount: 2, hasMore: true },
          { skills: [skill], totalCount: 2, hasMore: true },
        ],
      },
      hasNextPage: true,
      error: new Error("Network failure"),
      isFetchNextPageError: true,
    });
    render(<SkillsPage />);
    expect(screen.getAllByText("Loaded Skill")).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "skills.skillssh.leaderboardError",
    );
    expect(
      screen.queryByRole("button", { name: "skills.skillssh.loadMore" }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "skills.skillssh.retry" }));
    expect(fetchLeaderboardPageMock).toHaveBeenCalledTimes(1);
  });
});
