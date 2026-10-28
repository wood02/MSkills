import { createRef } from "react";
import { render, screen, waitFor, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";

import UnifiedSkillsPanel, {
  type UnifiedSkillsPanelHandle,
} from "@/components/skills/UnifiedSkillsPanel";
import type {
  InstalledSkill,
  SkillBackupEntry,
  SkillUpdateInfo,
  SkillUsageRange,
  SkillUsageSnapshot,
} from "@/lib/api/skills";
import type { VisibleApps } from "@/types";
import { settleSkillUsage, type SkillUsageData } from "@/lib/skillUsage";

vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useIsMutating: () => 0,
}));

const selectedVisibleApps: VisibleApps = {
  claude: true,
  "claude-desktop": false,
  codex: true,
  hermes: true,
  gemini: false,
  grokbuild: false,
  opencode: false,
  openclaw: false,
  pi: false,
  mcode: false,
};

const scanUnmanagedMock = vi.fn();
vi.mock("@/components/skills/SkillDocumentPanel", () => ({
  SkillDocumentPanel: ({
    skill,
    onClose,
    startEditing,
  }: {
    skill: InstalledSkill;
    onClose: () => void;
    startEditing?: boolean;
  }) => (
    <div data-testid="skill-document" data-editing={String(!!startEditing)}>
      <span>{skill.directory}</span>
      <button onClick={onClose}>Close preview</button>
    </div>
  ),
}));
const toggleSkillAppMock = vi.fn();
const uninstallSkillMock = vi.fn();
const importSkillsMock = vi.fn();
const createSkillMock = vi.fn();
const installFromZipMock = vi.fn();
const deleteSkillBackupMock = vi.fn();
const restoreSkillBackupMock = vi.fn();
const bulkToggleSkillAppMock = vi.fn();
const checkUpdatesMock = vi.fn();
const updateSkillMock = vi.fn();
const refetchSkillBackupsMock = vi.fn();
const togglePluginMock = vi.fn();
let pluginStatesMock: Record<string, Record<string, boolean>> = {};
const { toastErrorMock, toastSuccessMock, toastWarningMock } = vi.hoisted(
  () => ({
    toastErrorMock: vi.fn(),
    toastSuccessMock: vi.fn(),
    toastWarningMock: vi.fn(),
  }),
);
let installedSkillsMock: InstalledSkill[] = [];
let skillBackupsMock: SkillBackupEntry[] = [];
let skillUpdatesMock: SkillUpdateInfo[] = [];
let usageDataMock: Record<SkillUsageRange, SkillUsageSnapshot>;
let settledUsageDataMock: SkillUsageData | undefined;
let checkUpdatesFetching = false;
let toggleSkillAppPending = false;
let toggleSkillAppVariables:
  | { id: string; app: "claude"; enabled: boolean }
  | undefined;
let bulkToggleSkillAppPending = false;
let bulkToggleSkillAppVariables:
  | { ids: string[]; app: "claude"; enabled: boolean }
  | undefined;

vi.mock("sonner", () => ({
  toast: {
    success: toastSuccessMock,
    error: toastErrorMock,
    warning: toastWarningMock,
    info: vi.fn(),
  },
}));

vi.mock("@/hooks/useSkills", () => ({
  useSkillUsage: () => {
    settledUsageDataMock = settleSkillUsage(settledUsageDataMock, {
      ...usageDataMock,
    });
    return {
      data: settledUsageDataMock,
      boundaries: {
        day: Array.from(
          { length: 13 },
          (_, index) => 1792108800 + index * 7200,
        ),
        week: Array.from(
          { length: 8 },
          (_, index) => 1792108800 + index * 86400,
        ),
      },
      isError: false,
    };
  },
  usePluginStates: () => ({ data: pluginStatesMock }),
  useTogglePlugin: () => ({ mutate: togglePluginMock, isPending: false }),
  useInstalledSkills: () => ({
    data: installedSkillsMock,
    isLoading: false,
  }),
  useSkillBackups: () => ({
    data: skillBackupsMock,
    refetch: refetchSkillBackupsMock,
    isFetching: false,
  }),
  useDeleteSkillBackup: () => ({
    mutateAsync: deleteSkillBackupMock,
    isPending: false,
  }),
  useToggleSkillApp: () => ({
    mutateAsync: toggleSkillAppMock,
    isPending: toggleSkillAppPending,
    variables: toggleSkillAppVariables,
  }),
  useBulkToggleSkillApp: () => ({
    mutateAsync: bulkToggleSkillAppMock,
    isPending: bulkToggleSkillAppPending,
    variables: bulkToggleSkillAppVariables,
  }),
  useRestoreSkillBackup: () => ({
    mutateAsync: restoreSkillBackupMock,
    isPending: false,
  }),
  useUninstallSkill: () => ({
    mutateAsync: uninstallSkillMock,
  }),
  useScanUnmanagedSkills: () => ({
    data: [
      {
        directory: "shared-skill",
        name: "Shared Skill",
        description: "Imported from Grok Build",
        foundIn: ["grokbuild"],
        path: "/tmp/shared-skill",
      },
    ],
    refetch: scanUnmanagedMock,
  }),
  useImportSkillsFromApps: () => ({
    mutateAsync: importSkillsMock,
  }),
  useCreateLocalSkill: () => ({
    mutateAsync: createSkillMock,
    isPending: false,
  }),
  useInstallSkillsFromZip: () => ({
    mutateAsync: installFromZipMock,
  }),
  useCheckSkillUpdates: () => ({
    data: skillUpdatesMock,
    refetch: checkUpdatesMock,
    isFetching: checkUpdatesFetching,
  }),
  useUpdateSkill: () => ({
    mutateAsync: updateSkillMock,
    isPending: false,
  }),
}));

type InstalledSkillOverrides = Omit<Partial<InstalledSkill>, "apps"> & {
  apps?: Partial<InstalledSkill["apps"]>;
};

const makeInstalledSkill = (
  overrides: InstalledSkillOverrides = {},
): InstalledSkill => {
  const defaultApps: InstalledSkill["apps"] = {
    claude: false,
    codex: false,
    gemini: false,
    grokbuild: false,
    opencode: false,
    openclaw: false,
    hermes: false,
    pi: false,
  };
  const { apps, ...skillOverrides } = overrides;

  return {
    id: "owner/repo:alpha-skill",
    name: "Alpha Skill",
    description: "Alpha description",
    directory: "alpha-skill",
    repoOwner: "owner",
    repoName: "repo",
    repoBranch: "main",
    apps: { ...defaultApps, ...apps },
    installedAt: 1,
    updatedAt: 1,
    ...skillOverrides,
  };
};

const appCountControl = (app: string) =>
  screen
    .getAllByRole("checkbox")
    .find((element) => element.textContent?.startsWith(`${app}:`))!;

const renderPanel = () =>
  render(<UnifiedSkillsPanel onOpenDiscovery={() => {}} currentApp="claude" />);

const usageRecord = (skillName: string, count: number, length = 12) => ({
  skillName,
  app: "codex" as const,
  count,
  sessions: 1,
  lastUsed: 1792112400,
  manualCount: 0,
  agentCount: count,
  buckets: Array.from({ length }, (_, index) => (index === 0 ? count : 0)),
});

describe("UnifiedSkillsPanel", () => {
  it("keeps scan failures visible and retains the last completed usage", () => {
    installedSkillsMock = [makeInstalledSkill()];
    usageDataMock.day.records = [usageRecord("alpha-skill", 3)];
    const view = renderPanel();
    usageDataMock.day = {
      ...usageDataMock.day,
      completed: false,
      error: "Unable to read session log",
    };
    view.rerender(
      <UnifiedSkillsPanel onOpenDiscovery={() => {}} currentApp="claude" />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "skills.usage.incomplete",
    );
    expect(screen.getByTestId("skill-usage-trend")).toHaveTextContent("3");
  });

  it("includes hidden agents in the skill total and stacked trend", () => {
    installedSkillsMock = [makeInstalledSkill()];
    usageDataMock.day.records = [usageRecord("alpha-skill", 3)];
    render(
      <UnifiedSkillsPanel
        currentApp="claude"
        onOpenDiscovery={() => {}}
        visibleApps={{ ...selectedVisibleApps, codex: false }}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Codex" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("skill-usage-trend")).toHaveTextContent("3");
    expect(document.querySelector('[data-usage-segment="codex"]')).toHaveClass(
      "bg-blue-500",
    );
    expect(
      screen.getByRole("button", { name: /skills\.usage\.today/ }),
    ).toHaveTextContent("3");
  });

  it("sorts by the selected period's total, keeps ties alphabetical and freezes order during scans", async () => {
    installedSkillsMock = ["Zeta", "beta", "Alpha", "Gamma"].map((name) =>
      makeInstalledSkill({ id: name, name, directory: name.toLowerCase() }),
    );
    usageDataMock.day.records = [
      usageRecord("alpha", 1),
      usageRecord("beta", 3),
      usageRecord("zeta", 3),
    ];
    usageDataMock.week.records = [
      usageRecord("alpha", 8, 7),
      usageRecord("beta", 3, 7),
      usageRecord("zeta", 1, 7),
    ];
    const view = renderPanel();
    const user = userEvent.setup();
    const names = () =>
      screen
        .getAllByText(/^(Alpha|beta|Gamma|Zeta)$/)
        .map((element) => element.textContent);
    expect(names()).toEqual(["Alpha", "beta", "Gamma", "Zeta"]);
    await user.click(
      screen.getByRole("combobox", { name: "skills.usage.sort" }),
    );
    await user.click(
      screen.getByRole("option", { name: "skills.usage.sortUsage" }),
    );
    expect(names()).toEqual(["beta", "Zeta", "Alpha", "Gamma"]);

    const betaRow = screen.getByText("beta").closest(".group")!;
    await user.hover(
      within(betaRow as HTMLElement).getByRole("button", { name: "Claude" }),
    );
    expect(names()).toEqual(["beta", "Zeta", "Alpha", "Gamma"]);
    await user.unhover(
      within(betaRow as HTMLElement).getByRole("button", { name: "Claude" }),
    );

    usageDataMock.day = {
      ...usageDataMock.day,
      scanning: true,
      completed: false,
      records: [usageRecord("alpha", 100)],
    };
    view.rerender(
      <UnifiedSkillsPanel onOpenDiscovery={() => {}} currentApp="claude" />,
    );
    expect(names()).toEqual(["beta", "Zeta", "Alpha", "Gamma"]);
    expect(
      screen.getByRole("button", { name: /skills\.usage\.today/ }),
    ).toHaveTextContent("7");
    expect(
      screen.queryByText("skills.usage.unusedToday"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "skills.usage.unusedToday" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("skills.usage.scanning")).not.toBeInTheDocument();

    usageDataMock.day = {
      ...usageDataMock.day,
      scanning: false,
      completed: true,
    };
    view.rerender(
      <UnifiedSkillsPanel onOpenDiscovery={() => {}} currentApp="claude" />,
    );
    expect(names()).toEqual(["Alpha", "beta", "Gamma", "Zeta"]);
    expect(
      screen.getByRole("button", { name: /skills\.usage\.today/ }),
    ).toHaveTextContent("100");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("skills.usage.updated")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /skills\.usage\.week/ }),
    );
    expect(names()).toEqual(["Alpha", "beta", "Zeta", "Gamma"]);
    await user.type(
      screen.getByRole("textbox", { name: "skills.installedSearchAriaLabel" }),
      "gamma",
    );
    expect(names()).toEqual(["Gamma"]);
    expect(
      screen.getByRole("button", { name: /skills\.usage\.week/ }),
    ).toHaveTextContent("0");
  });

  it("defaults to today, filters one row on hover, and changes badges and buckets with the range", async () => {
    installedSkillsMock = [
      makeInstalledSkill({ apps: { claude: true, codex: false } }),
    ];
    const record = (
      app: "claude" | "codex",
      count: number,
      length: number,
    ) => ({
      skillName: "alpha-skill",
      app,
      count,
      sessions: 1,
      lastUsed: 1792112400,
      manualCount: 0,
      agentCount: count,
      buckets: Array.from({ length }, (_, index) => (index === 0 ? count : 0)),
    });
    usageDataMock.day!.records = [
      record("claude", 2, 12),
      record("codex", 3, 12),
    ];
    usageDataMock.week!.records = [
      record("claude", 4, 7),
      record("codex", 7, 7),
    ];
    render(
      <UnifiedSkillsPanel
        currentApp="claude"
        onOpenDiscovery={() => {}}
        visibleApps={selectedVisibleApps}
      />,
    );
    const user = userEvent.setup();
    const trend = screen.getByTestId("skill-usage-trend");
    expect(
      screen.getByRole("button", { name: /skills\.usage\.today/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(trend.querySelectorAll("[data-usage-bucket]")).toHaveLength(12);
    expect(trend.querySelector('[data-usage-segment="claude"]')).toHaveClass(
      "bg-orange-500",
    );
    expect(trend.querySelector('[data-usage-segment="codex"]')).toHaveClass(
      "bg-blue-500",
    );
    expect(trend.querySelector('[data-usage-segment="claude"]')).toHaveStyle({
      height: "40%",
    });
    expect(trend.querySelector('[data-usage-segment="codex"]')).toHaveStyle({
      height: "60%",
    });
    expect(
      screen.getByRole("button", { name: /skills\.usage\.today/ }),
    ).toHaveTextContent("5");
    expect(
      screen.getByRole("button", { name: /skills\.usage\.week/ }),
    ).toHaveTextContent("11");
    expect(trend).toHaveTextContent("5");
    expect(
      document.querySelector('[data-usage-app="codex"]'),
    ).toHaveTextContent("3");
    expect(document.querySelector('[data-usage-app="codex"]')).toHaveAttribute(
      "data-usage-warning",
      "true",
    );
    expect(document.querySelector('[data-usage-app="codex"]')).toHaveClass(
      "bg-zinc-200",
      "text-zinc-700",
    );
    expect(document.querySelector('[data-usage-app="claude"]')).toHaveClass(
      "bg-[#D97757]",
      "text-white",
    );

    const codex = screen.getByRole("button", { name: "Codex" });
    await user.hover(codex);
    expect(trend).toHaveTextContent("3");
    expect(codex).toHaveClass("ring-2");
    await user.unhover(codex);
    expect(trend).toHaveTextContent("5");

    await user.click(
      screen.getByRole("button", { name: /skills\.usage\.week/ }),
    );
    expect(trend.querySelectorAll("[data-usage-bucket]")).toHaveLength(7);
    expect(trend).toHaveTextContent("11");
    expect(
      document.querySelector('[data-usage-app="codex"]'),
    ).toHaveTextContent("7");

    await user.hover(screen.getByRole("button", { name: "Hermes" }));
    expect(trend).toHaveTextContent("skills.usage.unsupported");
    expect(trend.querySelectorAll("[data-usage-bucket]")).toHaveLength(0);
    await user.click(codex);
    await waitFor(() =>
      expect(toggleSkillAppMock).toHaveBeenCalledWith({
        id: "owner/repo:alpha-skill",
        app: "codex",
        enabled: true,
      }),
    );
  });

  it("lists used plugin Skills separately and counts them in the totals", async () => {
    installedSkillsMock = [makeInstalledSkill()];
    usageDataMock.day!.records = [
      usageRecord("alpha-skill", 2),
      usageRecord("ponytail:ponytail-review", 5),
    ];
    usageDataMock.day!.pluginSkills = {
      "ponytail:ponytail-gain": "Show measured savings",
      "ponytail:ponytail-review": "",
      "karpathy-skills:karpathy-guidelines": "Fewer LLM mistakes",
    };
    usageDataMock.day!.pluginDescriptions = { ponytail: "Lazy senior dev" };
    usageDataMock.day!.pluginSources = {
      ponytail: [
        {
          app: "claude",
          marketplace: "ponytail",
          version: "1.0.0",
          commands: 2,
        },
        {
          app: "codex",
          marketplace: "ponytail",
          version: "1.0.0",
          commands: 0,
        },
      ],
    };
    pluginStatesMock = {
      claude: { "ponytail@ponytail": true },
      codex: { "ponytail@ponytail": false },
    };
    const user = userEvent.setup();
    renderPanel();
    expect(screen.getByText("skills.usage.pluginSkills")).toBeInTheDocument();
    const group = screen.getByRole("button", { name: /^ponytail/ });
    expect(group).toHaveTextContent(
      "ponytail · 1.0.0 · skills.usage.pluginSkillCount · skills.usage.pluginCommandCount",
    );
    // Each agent icon toggles the plugin in that agent's own config.
    expect(screen.getByTitle("skills.usage.pluginEnabledIn")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(screen.getByTitle("skills.usage.pluginDisabledIn"));
    expect(togglePluginMock).toHaveBeenCalledWith(
      { app: "codex", id: "ponytail@ponytail", enabled: true },
      expect.anything(),
    );
    expect(group).toHaveAttribute("aria-expanded", "false");
    // A one-Skill plugin is a flat row named after its Skill, with no toggle.
    expect(screen.getByText("karpathy-guidelines")).toBeInTheDocument();
    expect(screen.getByText("karpathy-skills")).toBeInTheDocument();
    expect(screen.getByText("Fewer LLM mistakes")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^karpathy/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("ponytail-gain")).not.toBeInTheDocument();
    await user.click(group);
    expect(screen.getByText("ponytail-review")).toBeInTheDocument();
    expect(screen.getByText("ponytail-gain")).toBeInTheDocument();
    expect(screen.getByText("Lazy senior dev")).toBeInTheDocument();
    expect(screen.getByText("Show measured savings")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /skills\.usage\.today/ }),
    ).toHaveTextContent("7");
    await user.type(
      screen.getByRole("textbox", { name: "skills.installedSearchAriaLabel" }),
      "alpha",
    );
    expect(
      screen.queryByText("skills.usage.pluginSkills"),
    ).not.toBeInTheDocument();
    await user.clear(
      screen.getByRole("textbox", { name: "skills.installedSearchAriaLabel" }),
    );
    await user.click(
      screen.getByRole("combobox", { name: "skills.filter.repo" }),
    );
    await user.click(
      screen.getByRole("option", { name: "skills.usage.pluginSkills（3）" }),
    );
    expect(screen.queryByText("alpha-skill")).not.toBeInTheDocument();
    expect(
      screen.queryByText("skills.noInstalledSearchResults"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^ponytail/ }),
    ).toBeInTheDocument();
  });

  it("does not label a skill unused while the first background scan is unfinished", () => {
    installedSkillsMock = [makeInstalledSkill()];
    usageDataMock.day = {
      scanning: true,
      completed: false,
      filesScanned: 1,
      filesTotal: 10,
      error: null,
      records: [],
    };
    renderPanel();
    expect(screen.getByTestId("skill-usage-placeholder")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText("skills.usage.scanning")).not.toBeInTheDocument();
    expect(
      screen.queryByText("skills.usage.unusedToday"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "skills.filter.repo" }),
    ).toHaveTextContent("skills.usage.allSources");
  });

  it("opens the selected Skill document and blocks management until it closes", async () => {
    installedSkillsMock = [makeInstalledSkill()];
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      screen.getByRole("button", { name: "skills.document.open" }),
    );
    expect(screen.getByTestId("skill-document")).toHaveTextContent(
      "alpha-skill",
    );
    expect(
      screen.getByRole("button", { name: "skills.document.open" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByTestId("skill-document")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "skills.document.open" }),
    ).toBeEnabled();
  });
  beforeEach(() => {
    installedSkillsMock = [];
    skillBackupsMock = [];
    skillUpdatesMock = [];
    const snapshot = {
      scanning: false,
      completed: true,
      filesScanned: 1,
      filesTotal: 1,
      error: null,
      records: [],
    };
    usageDataMock = { day: { ...snapshot }, week: { ...snapshot } };
    settledUsageDataMock = undefined;
    checkUpdatesFetching = false;
    toggleSkillAppPending = false;
    toggleSkillAppVariables = undefined;
    bulkToggleSkillAppPending = false;
    bulkToggleSkillAppVariables = undefined;
    scanUnmanagedMock.mockReset();
    scanUnmanagedMock.mockResolvedValue({
      data: [
        {
          directory: "shared-skill",
          name: "Shared Skill",
          description: "Imported from Grok Build",
          foundIn: ["grokbuild"],
          path: "/tmp/shared-skill",
        },
      ],
    });
    toggleSkillAppMock.mockReset();
    toggleSkillAppMock.mockResolvedValue(true);
    bulkToggleSkillAppMock.mockReset();
    bulkToggleSkillAppMock.mockResolvedValue({ succeeded: [], failed: [] });
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
    toastWarningMock.mockReset();
    uninstallSkillMock.mockReset();
    importSkillsMock.mockReset();
    installFromZipMock.mockReset();
    deleteSkillBackupMock.mockReset();
    refetchSkillBackupsMock.mockReset();
    refetchSkillBackupsMock.mockResolvedValue({ data: skillBackupsMock });
    restoreSkillBackupMock.mockReset();
    checkUpdatesMock.mockReset();
    checkUpdatesMock.mockResolvedValue({ data: [] });
    updateSkillMock.mockReset();
    updateSkillMock.mockImplementation(async (id: string) =>
      makeInstalledSkill({ id }),
    );
  });

  it("filters count badges and row controls while preserving every skill and enabled state", () => {
    installedSkillsMock = [
      makeInstalledSkill({ apps: { gemini: true } }),
      makeInstalledSkill({
        id: "local:beta",
        name: "Beta Skill",
        directory: "beta",
        apps: { gemini: true },
      }),
    ];
    const { rerender } = render(
      <UnifiedSkillsPanel
        currentApp="claude"
        onOpenDiscovery={vi.fn()}
        visibleApps={selectedVisibleApps}
      />,
    );
    expect(screen.getByText("Alpha Skill")).toBeInTheDocument();
    expect(screen.getByText("Beta Skill")).toBeInTheDocument();
    expect(appCountControl("Claude")).toBeInTheDocument();
    expect(appCountControl("Codex")).toBeInTheDocument();
    expect(appCountControl("Hermes")).toBeInTheDocument();
    expect(screen.queryByText("Gemini:")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Gemini" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Claude" })).toHaveLength(2);
    rerender(
      <UnifiedSkillsPanel currentApp="claude" onOpenDiscovery={vi.fn()} />,
    );
    expect(appCountControl("Gemini")).toBeInTheDocument();
    screen
      .getAllByRole("button", { name: "Gemini" })
      .forEach((button) =>
        expect(button).toHaveAttribute("aria-pressed", "true"),
      );
    expect(toggleSkillAppMock).not.toHaveBeenCalled();
    expect(bulkToggleSkillAppMock).not.toHaveBeenCalled();
  });

  it("shares the Claude Desktop skills entry and includes a selected Pi without inventing OpenClaw support", () => {
    installedSkillsMock = [makeInstalledSkill({ apps: { pi: true } })];
    const desktopVisible = {
      ...selectedVisibleApps,
      claude: false,
      codex: false,
      hermes: false,
      "claude-desktop": true,
      openclaw: true,
    };
    const { rerender } = render(
      <UnifiedSkillsPanel
        currentApp="claude"
        onOpenDiscovery={vi.fn()}
        visibleApps={desktopVisible}
      />,
    );
    expect(screen.getByRole("button", { name: "Claude" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "OpenClaw" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Codex" }),
    ).not.toBeInTheDocument();
    rerender(
      <UnifiedSkillsPanel
        currentApp="claude"
        onOpenDiscovery={vi.fn()}
        visibleApps={{ ...desktopVisible, "claude-desktop": false, pi: true }}
      />,
    );
    expect(screen.getByRole("button", { name: "Pi" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "Claude" }),
    ).not.toBeInTheDocument();
  });

  it("uses the same visible app controls in the import dialog without rewriting hidden source flags", async () => {
    const ref = createRef<UnifiedSkillsPanelHandle>();
    importSkillsMock.mockResolvedValue([]);
    render(
      <UnifiedSkillsPanel
        ref={ref}
        currentApp="claude"
        onOpenDiscovery={vi.fn()}
        visibleApps={selectedVisibleApps}
      />,
    );
    await act(async () => {
      ref.current?.openImport();
    });
    expect(await screen.findByText("Shared Skill")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claude" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Grok Build" }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "skills.importSelected" }));
    await waitFor(() =>
      expect(importSkillsMock).toHaveBeenCalledWith([
        expect.objectContaining({
          directory: "shared-skill",
          apps: expect.objectContaining({ grokbuild: true }),
        }),
      ]),
    );
  });

  it("creates a local Skill and opens its document in edit mode", async () => {
    const ref = createRef<UnifiedSkillsPanelHandle>();
    createSkillMock.mockResolvedValue(
      makeInstalledSkill({ id: "local:my-skill", directory: "my-skill" }),
    );
    render(
      <UnifiedSkillsPanel
        ref={ref}
        currentApp="claude"
        onOpenDiscovery={vi.fn()}
      />,
    );
    act(() => ref.current?.openCreate());
    const user = userEvent.setup();
    const submit = screen.getByRole("button", { name: "skills.create.submit" });
    await user.type(screen.getByPlaceholderText("my-skill"), "My Skill");
    expect(submit).toBeDisabled();
    await user.clear(screen.getByPlaceholderText("my-skill"));
    await user.type(screen.getByPlaceholderText("my-skill"), "my-skill");
    await user.click(submit);

    expect(createSkillMock).toHaveBeenCalledWith({
      directory: "my-skill",
      description: "",
    });
    const document = await screen.findByTestId("skill-document");
    expect(document).toHaveAttribute("data-editing", "true");
    expect(within(document).getByText("my-skill")).toBeInTheDocument();
  });

  it("opens the import dialog without crashing when app toggles render", async () => {
    const ref = createRef<UnifiedSkillsPanelHandle>();

    render(
      <UnifiedSkillsPanel
        ref={ref}
        onOpenDiscovery={() => {}}
        currentApp="claude"
      />,
    );

    await act(async () => {
      await ref.current?.openImport();
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "skills.import" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Shared Skill")).toBeInTheDocument();
      expect(screen.getByText("/tmp/shared-skill")).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText("skills.importSelected").click();
    });

    await waitFor(() => {
      expect(importSkillsMock).toHaveBeenCalledWith([
        {
          directory: "shared-skill",
          apps: expect.objectContaining({ grokbuild: true }),
        },
      ]);
    });
  });

  it("passes only the installed Skill ID to uninstall", async () => {
    installedSkillsMock = [
      makeInstalledSkill({
        id: "owner/repo:skill-id",
        directory: "nested/skill-directory",
        repoOwner: "owner",
        repoName: "repo",
      }),
    ];
    uninstallSkillMock.mockResolvedValueOnce({ backupPath: undefined });
    renderPanel();

    const user = userEvent.setup();
    await user.click(screen.getByTitle("skills.uninstall"));
    await user.click(
      screen.getByRole("button", {
        name: "common.confirm",
      }),
    );

    await waitFor(() => {
      expect(uninstallSkillMock).toHaveBeenCalledWith("owner/repo:skill-id");
    });
  });

  it("warns when uninstall preserves an unverified Pi directory", async () => {
    installedSkillsMock = [makeInstalledSkill({ name: "Pi Skill" })];
    uninstallSkillMock.mockResolvedValueOnce({
      backupPath: "/tmp/backup",
      preservedPiPath: "/tmp/pi/skills/pi-skill",
    });
    renderPanel();

    const user = userEvent.setup();
    await user.click(screen.getByTitle("skills.uninstall"));
    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => {
      expect(toastWarningMock).toHaveBeenCalledWith("skills.uninstallSuccess", {
        description: "skills.uninstallPiPreserved",
        closeButton: true,
      });
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("warns when the Pi Skills directory could not be resolved", async () => {
    installedSkillsMock = [makeInstalledSkill({ name: "Pi Skill" })];
    uninstallSkillMock.mockResolvedValueOnce({ piCleanupIncomplete: true });
    renderPanel();

    const user = userEvent.setup();
    await user.click(screen.getByTitle("skills.uninstall"));
    await user.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => {
      expect(toastWarningMock).toHaveBeenCalledWith("skills.uninstallSuccess", {
        description: "skills.uninstallPiCleanupIncomplete",
        closeButton: true,
      });
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it.each([
    ["name", "searchable name"],
    ["id", "opaque-id-token"],
    ["description", "descriptive-token"],
    ["directory", "directory-token"],
    ["repo owner", "owner-token"],
    ["repo name", "repository-token"],
  ])("filters installed Skills by %s", async (_field, query) => {
    installedSkillsMock = [
      makeInstalledSkill({
        id: "opaque-id-token",
        name: "Searchable Name",
        description: "Contains descriptive-token",
        directory: "nested/directory-token",
        repoOwner: "owner-token",
        repoName: "repository-token",
      }),
      makeInstalledSkill({
        id: "unrelated-id",
        name: "Unrelated Skill",
        description: "Nothing to match",
        directory: "other-directory",
        repoOwner: "another-owner",
        repoName: "another-repo",
      }),
    ];
    renderPanel();

    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", {
        name: "skills.installedSearchAriaLabel",
      }),
      `  ${query.toUpperCase()}  `,
    );

    expect(screen.getByText("Searchable Name")).toBeInTheDocument();
    expect(screen.queryByText("Unrelated Skill")).not.toBeInTheDocument();
  });

  it("offers discover and import from the empty list", async () => {
    const onOpenDiscovery = vi.fn();
    const user = userEvent.setup();
    render(
      <UnifiedSkillsPanel
        onOpenDiscovery={onOpenDiscovery}
        currentApp="claude"
      />,
    );

    await user.click(screen.getByRole("button", { name: "skills.discover" }));
    expect(onOpenDiscovery).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "skills.import" })).toBeEnabled();
  });

  it("distinguishes an empty list from an installed-Skill search miss", async () => {
    const { rerender } = renderPanel();

    expect(screen.getByText("skills.noInstalled")).toBeInTheDocument();
    expect(
      screen.queryByText("skills.noInstalledSearchResults"),
    ).not.toBeInTheDocument();

    installedSkillsMock = [makeInstalledSkill()];
    rerender(
      <UnifiedSkillsPanel onOpenDiscovery={() => {}} currentApp="claude" />,
    );
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", {
        name: "skills.installedSearchAriaLabel",
      }),
      "missing",
    );

    expect(
      screen.getByText("skills.noInstalledSearchResults"),
    ).toBeInTheDocument();
    expect(screen.queryByText("skills.noInstalled")).not.toBeInTheDocument();
  });

  it("keeps the search control outside the visible scroll viewport", () => {
    installedSkillsMock = [makeInstalledSkill()];
    const { container } = renderPanel();

    const searchInput = screen.getByRole("textbox", {
      name: "skills.installedSearchAriaLabel",
    });
    const viewport = container.querySelector(
      "[data-radix-scroll-area-viewport]",
    );

    expect(viewport).not.toBeNull();
    expect(viewport).not.toContainElement(searchInput);
  });

  it("scopes bulk toggles to the searched Skills", async () => {
    installedSkillsMock = [
      makeInstalledSkill({
        id: "enabled-id",
        name: "Visible Skill",
        apps: { claude: true },
      }),
      makeInstalledSkill({ id: "visible-off-id", name: "Visible Skill Two" }),
      makeInstalledSkill({ id: "hidden-id", name: "Hidden Skill" }),
    ];
    renderPanel();

    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox", {
        name: "skills.installedSearchAriaLabel",
      }),
      "Visible Skill",
    );
    expect(
      screen.getByRole("combobox", { name: "skills.filter.repo" }),
    ).toHaveTextContent("skills.usage.allSources");
    await user.click(appCountControl("Claude"));

    await waitFor(() => {
      expect(bulkToggleSkillAppMock).toHaveBeenCalledWith({
        ids: ["visible-off-id"],
        app: "claude",
        enabled: true,
      });
    });
  });

  it("filters by source and scopes bulk toggles to that source", async () => {
    installedSkillsMock = [
      makeInstalledSkill({ id: "repo-a-id", name: "Repo A Skill" }),
      makeInstalledSkill({
        id: "repo-b-id",
        name: "Repo B Skill",
        repoOwner: "other",
        repoName: "pack",
      }),
      makeInstalledSkill({
        id: "local-id",
        name: "Local Skill",
        repoOwner: undefined,
        repoName: undefined,
      }),
      makeInstalledSkill({
        id: "upper-id",
        name: "Upper Skill",
        repoOwner: "Zed",
        repoName: "pack",
      }),
    ];
    renderPanel();

    const user = userEvent.setup();
    await user.click(
      screen.getByRole("combobox", { name: "skills.filter.repo" }),
    );
    // 全部、本地在前，仓库按 a-z 排序且不区分大小写
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual([
      "skills.usage.allSources",
      "skills.local（1）",
      "other/pack（1）",
      "owner/repo（1）",
      "Zed/pack（1）",
    ]);
    await user.click(screen.getByRole("option", { name: "skills.local（1）" }));

    expect(screen.getByText("Local Skill")).toBeInTheDocument();
    expect(screen.queryByText("Repo A Skill")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("combobox", { name: "skills.filter.repo" }),
    );
    await user.click(screen.getByRole("option", { name: "other/pack（1）" }));

    expect(screen.getByText("Repo B Skill")).toBeInTheDocument();
    expect(screen.queryByText("Local Skill")).not.toBeInTheDocument();
    await user.click(appCountControl("Claude"));

    await waitFor(() => {
      expect(bulkToggleSkillAppMock).toHaveBeenCalledWith({
        ids: ["repo-b-id"],
        app: "claude",
        enabled: true,
      });
    });
  });

  it("enables all Skills when none are enabled for an app", async () => {
    installedSkillsMock = [
      makeInstalledSkill({ id: "first-id" }),
      makeInstalledSkill({ id: "second-id" }),
    ];
    renderPanel();

    const user = userEvent.setup();
    await user.click(appCountControl("Claude"));

    await waitFor(() => {
      expect(bulkToggleSkillAppMock).toHaveBeenCalledWith({
        ids: ["first-id", "second-id"],
        app: "claude",
        enabled: true,
      });
    });
  });

  it("disables all Skills when every Skill is enabled for an app", async () => {
    installedSkillsMock = [
      makeInstalledSkill({ id: "first-id", apps: { claude: true } }),
      makeInstalledSkill({ id: "second-id", apps: { claude: true } }),
    ];
    renderPanel();

    const user = userEvent.setup();
    await user.click(appCountControl("Claude"));

    await waitFor(() => {
      expect(bulkToggleSkillAppMock).toHaveBeenCalledWith({
        ids: ["first-id", "second-id"],
        app: "claude",
        enabled: false,
      });
    });
  });

  it("reports partial bulk-toggle failures", async () => {
    installedSkillsMock = [
      makeInstalledSkill({ id: "first-id" }),
      makeInstalledSkill({ id: "second-id" }),
    ];
    bulkToggleSkillAppMock.mockResolvedValue({
      succeeded: ["first-id"],
      failed: [{ item: "second-id", error: new Error("permission denied") }],
    });
    renderPanel();

    const user = userEvent.setup();
    await user.click(appCountControl("Claude"));

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("common.bulkToggleFailed", {
        description: "Error: permission denied",
      });
    });
  });

  it.each(["single", "bulk"] as const)(
    "disables row app toggles while a %s toggle is pending",
    async (pendingKind) => {
      installedSkillsMock = [makeInstalledSkill()];
      if (pendingKind === "single") {
        toggleSkillAppPending = true;
        toggleSkillAppVariables = {
          id: "owner/repo:alpha-skill",
          app: "claude",
          enabled: true,
        };
      } else {
        bulkToggleSkillAppPending = true;
        bulkToggleSkillAppVariables = {
          ids: ["owner/repo:alpha-skill"],
          app: "claude",
          enabled: true,
        };
      }
      renderPanel();

      const row = screen.getByText("Alpha Skill").closest(".group");
      const appToggleButtons = Array.from(
        row!.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
      );

      expect(appToggleButtons).toHaveLength(7);
      appToggleButtons.forEach((button) => expect(button).toBeDisabled());
      expect(screen.getByTitle("skills.uninstall")).toBeDisabled();
      await userEvent.setup().click(appToggleButtons[0]);
      expect(toggleSkillAppMock).not.toHaveBeenCalled();
    },
  );

  it("reports check-update availability and clears it on unmount", async () => {
    installedSkillsMock = [makeInstalledSkill()];
    const onCheckUpdatesStateChange = vi.fn();

    const { unmount } = render(
      <UnifiedSkillsPanel
        onOpenDiscovery={() => {}}
        currentApp="claude"
        onCheckUpdatesStateChange={onCheckUpdatesStateChange}
      />,
    );

    await waitFor(() => {
      expect(onCheckUpdatesStateChange).toHaveBeenLastCalledWith({
        isChecking: false,
        hasSkills: true,
      });
    });
    expect(screen.queryByText("skills.checkUpdates")).not.toBeInTheDocument();

    unmount();
    expect(onCheckUpdatesStateChange).toHaveBeenLastCalledWith({
      isChecking: false,
      hasSkills: false,
    });
  });

  it("ignores rapid duplicate check-update ref calls", async () => {
    installedSkillsMock = [makeInstalledSkill()];
    let resolveCheck!: (value: { data: never[] }) => void;
    checkUpdatesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );
    const ref = createRef<UnifiedSkillsPanelHandle>();

    render(
      <UnifiedSkillsPanel
        ref={ref}
        onOpenDiscovery={() => {}}
        currentApp="claude"
      />,
    );

    act(() => {
      ref.current?.checkUpdates();
      ref.current?.checkUpdates();
    });
    expect(checkUpdatesMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCheck({ data: [] });
      await Promise.resolve();
    });
  });

  it("does not block actions during a background update check", async () => {
    installedSkillsMock = [makeInstalledSkill()];
    checkUpdatesFetching = true;
    const onInteractionBlockedChange = vi.fn();

    render(
      <UnifiedSkillsPanel
        onOpenDiscovery={() => {}}
        currentApp="claude"
        onInteractionBlockedChange={onInteractionBlockedChange}
      />,
    );

    await waitFor(() => {
      expect(onInteractionBlockedChange).toHaveBeenLastCalledWith(false);
    });
    expect(screen.getByTitle("skills.uninstall")).toBeEnabled();
  });

  it("blocks actions but not navigation while checking updates", async () => {
    installedSkillsMock = [makeInstalledSkill()];
    let resolveCheck!: (value: { data: never[] }) => void;
    checkUpdatesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );
    const ref = createRef<UnifiedSkillsPanelHandle>();
    const onInteractionBlockedChange = vi.fn();
    const onNavigationBlockedChange = vi.fn();

    render(
      <UnifiedSkillsPanel
        ref={ref}
        onOpenDiscovery={() => {}}
        currentApp="claude"
        onInteractionBlockedChange={onInteractionBlockedChange}
        onNavigationBlockedChange={onNavigationBlockedChange}
      />,
    );

    act(() => {
      ref.current?.checkUpdates();
    });

    await waitFor(() => {
      expect(onInteractionBlockedChange).toHaveBeenLastCalledWith(true);
      expect(onNavigationBlockedChange).toHaveBeenLastCalledWith(false);
    });
    expect(appCountControl("Claude")).toBeDisabled();
    expect(screen.getByTitle("skills.uninstall")).toBeDisabled();

    await act(async () => {
      await ref.current?.openImport();
    });
    expect(scanUnmanagedMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveCheck({ data: [] });
      await Promise.resolve();
    });
  });

  it("closes the backup dialog and reports an explicit refresh failure", async () => {
    refetchSkillBackupsMock.mockRejectedValueOnce(new Error("refresh failed"));
    const ref = createRef<UnifiedSkillsPanelHandle>();
    render(
      <UnifiedSkillsPanel
        ref={ref}
        onOpenDiscovery={() => {}}
        currentApp="claude"
      />,
    );

    await act(async () => {
      await ref.current?.openRestoreFromBackup();
    });

    expect(refetchSkillBackupsMock).toHaveBeenCalledWith({
      throwOnError: true,
    });
    expect(toastErrorMock).toHaveBeenCalledWith("common.error", {
      description: "Error: refresh failed",
    });
    expect(
      screen.queryByText("skills.restoreFromBackup.title"),
    ).not.toBeInTheDocument();
  });

  it("blocks writes immediately when an update check starts", async () => {
    installedSkillsMock = [makeInstalledSkill()];
    let resolveCheck!: (value: { data: never[] }) => void;
    checkUpdatesMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );
    const ref = createRef<UnifiedSkillsPanelHandle>();
    render(
      <UnifiedSkillsPanel
        ref={ref}
        onOpenDiscovery={() => {}}
        currentApp="claude"
      />,
    );

    act(() => {
      ref.current?.checkUpdates();
    });
    expect(checkUpdatesMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await ref.current?.openImport();
    });
    await userEvent.setup().click(screen.getByTitle("skills.uninstall"));
    await userEvent.setup().click(appCountControl("Claude"));

    expect(scanUnmanagedMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(bulkToggleSkillAppMock).not.toHaveBeenCalled();

    await act(async () => {
      resolveCheck({ data: [] });
      await Promise.resolve();
    });
  });

  it("ignores stale update entries for uninstalled Skills", async () => {
    installedSkillsMock = [makeInstalledSkill({ id: "installed-id" })];
    skillUpdatesMock = [
      { id: "removed-id", name: "Removed Skill", remoteHash: "removed" },
      { id: "installed-id", name: "Alpha Skill", remoteHash: "current" },
    ];
    renderPanel();

    expect(screen.getAllByText("skills.updateAvailable")).toHaveLength(1);
    await userEvent.setup().click(
      screen.getByRole("button", {
        name: "skills.updateAll",
      }),
    );

    await waitFor(() => {
      expect(updateSkillMock).toHaveBeenCalledTimes(1);
      expect(updateSkillMock).toHaveBeenCalledWith("installed-id");
    });
  });

  it("waits for an explicit backup refresh before reporting deletion failure", async () => {
    skillBackupsMock = [
      {
        backupId: "backup-1",
        backupPath: "C:\\backups\\backup-1",
        createdAt: 1,
        skill: makeInstalledSkill({ name: "Backup Skill" }),
      },
    ];
    deleteSkillBackupMock.mockRejectedValueOnce(undefined);
    let releaseRefresh: (() => void) | undefined;
    const refreshPending = new Promise((resolve) => {
      releaseRefresh = () => resolve({ data: [] });
    });
    refetchSkillBackupsMock
      .mockResolvedValueOnce({ data: skillBackupsMock })
      .mockReturnValueOnce(refreshPending);
    const ref = createRef<UnifiedSkillsPanelHandle>();
    render(
      <UnifiedSkillsPanel
        ref={ref}
        onOpenDiscovery={() => {}}
        currentApp="claude"
      />,
    );

    await act(async () => {
      await ref.current?.openRestoreFromBackup();
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "skills.restoreFromBackup.delete",
      }),
    );
    const confirmDialog = screen
      .getByText("skills.restoreFromBackup.deleteConfirmTitle")
      .closest<HTMLElement>('[role="dialog"]');
    expect(confirmDialog).not.toBeNull();
    await user.click(
      within(confirmDialog!).getByRole("button", {
        name: "skills.restoreFromBackup.delete",
      }),
    );

    await waitFor(() => {
      expect(deleteSkillBackupMock).toHaveBeenCalledWith("backup-1");
      expect(refetchSkillBackupsMock).toHaveBeenCalledTimes(2);
    });
    expect(toastErrorMock).not.toHaveBeenCalled();

    releaseRefresh?.();
    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledTimes(1);
      expect(toastErrorMock).toHaveBeenCalledWith(
        "skills.restoreFromBackup.deleteFailed",
        { description: "undefined" },
      );
    });
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(
      screen.queryByText("skills.restoreFromBackup.deleteConfirmTitle"),
    ).not.toBeInTheDocument();
  });

  it("does not report a completed deletion as failed when refresh rejects", async () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    skillBackupsMock = [
      {
        backupId: "backup-1",
        backupPath: "C:\\backups\\backup-1",
        createdAt: 1,
        skill: makeInstalledSkill({ name: "Backup Skill" }),
      },
    ];
    deleteSkillBackupMock.mockResolvedValueOnce(true);
    refetchSkillBackupsMock
      .mockResolvedValueOnce({ data: skillBackupsMock })
      .mockRejectedValueOnce(new Error("refresh failed"));
    const ref = createRef<UnifiedSkillsPanelHandle>();
    render(
      <UnifiedSkillsPanel
        ref={ref}
        onOpenDiscovery={() => {}}
        currentApp="claude"
      />,
    );

    await act(async () => {
      await ref.current?.openRestoreFromBackup();
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", {
        name: "skills.restoreFromBackup.delete",
      }),
    );
    const confirmDialog = screen
      .getByText("skills.restoreFromBackup.deleteConfirmTitle")
      .closest<HTMLElement>('[role="dialog"]');
    expect(confirmDialog).not.toBeNull();
    await user.click(
      within(confirmDialog!).getByRole("button", {
        name: "skills.restoreFromBackup.delete",
      }),
    );

    await waitFor(() => {
      expect(toastSuccessMock).toHaveBeenCalledWith(
        "skills.restoreFromBackup.deleteSuccess",
        { closeButton: true },
      );
    });
    expect(refetchSkillBackupsMock).toHaveBeenCalledTimes(2);
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to refresh Skill backups after deletion:",
      expect.any(Error),
    );
    consoleErrorSpy.mockRestore();
  });

  it("renders and toggles the Pi app state like the other apps", async () => {
    installedSkillsMock = [
      makeInstalledSkill({
        id: "skill-1",
        name: "Pi Skill",
        directory: "pi-skill",
        apps: { pi: true },
      }),
    ];

    render(<UnifiedSkillsPanel onOpenDiscovery={() => {}} currentApp="pi" />);

    const piToggle = screen.getByRole("button", { name: "Pi" });
    expect(piToggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.setup().click(piToggle);

    await waitFor(() => {
      expect(toggleSkillAppMock).toHaveBeenCalledWith({
        id: "skill-1",
        app: "pi",
        enabled: false,
      });
    });
  });

  it("renders an inactive Pi state like the other apps", () => {
    installedSkillsMock = [
      makeInstalledSkill({
        id: "skill-1",
        name: "Claude Skill",
        directory: "claude-skill",
        apps: { claude: true, pi: false },
      }),
    ];

    render(<UnifiedSkillsPanel onOpenDiscovery={() => {}} currentApp="pi" />);

    expect(screen.getByRole("button", { name: "Pi" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("does not add an inactive Pi toggle outside the Pi context", () => {
    installedSkillsMock = [
      makeInstalledSkill({
        name: "Claude Skill",
        apps: { claude: true, pi: false },
      }),
    ];

    render(
      <UnifiedSkillsPanel onOpenDiscovery={() => {}} currentApp="claude" />,
    );

    expect(
      screen.queryByRole("button", { name: "Pi" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claude" })).toBeInTheDocument();
  });
});
