import { act, render, screen, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectsPage } from "@/components/projects/ProjectsPage";
import type {
  ProjectListItem,
  ProjectScanResult,
  ScannedProjectSkill,
} from "@/lib/api/projects";
import type { InstalledSkill } from "@/lib/api/skills";
import type { SkillGroup } from "@/lib/api/skillGroups";

let projectsMock: ProjectListItem[] = [];
let scanResultMock: ProjectScanResult | undefined;
let installedSkillsMock: InstalledSkill[] = [];
let skillGroupsMock: SkillGroup[] = [];

const {
  deployMutateAsyncMock,
  refetchProjectsMock,
  refetchScanMock,
  idleMutation,
} = vi.hoisted(() => ({
  deployMutateAsyncMock: vi.fn(),
  refetchProjectsMock: vi.fn(),
  refetchScanMock: vi.fn(),
  idleMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn().mockResolvedValue({}),
  }),
}));

vi.mock("@/hooks/useSkills", () => ({
  useInstalledSkills: () => ({
    data: installedSkillsMock,
  }),
}));

vi.mock("@/lib/query/skillGroups", () => ({
  useSkillGroupsQuery: () => ({
    data: skillGroupsMock,
  }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectsQuery: () => ({
    data: projectsMock,
    isLoading: false,
    refetch: refetchProjectsMock,
  }),
  useProjectScanQuery: () => ({
    data: scanResultMock,
    isFetching: false,
    refetch: refetchScanMock,
  }),
  useDeploySkillsToProjectMutation: () => ({
    isPending: false,
    mutateAsync: deployMutateAsyncMock,
  }),
  useDeploySkillGroupToProjectMutation: idleMutation,
  useBatchUndeployProjectSkillsMutation: idleMutation,
  useUpdateProjectMutation: idleMutation,
  useUpdateProjectDeploymentsMutation: idleMutation,
  usePromoteClaudeDeploymentMutation: idleMutation,
  useUndeployProjectSkillMutation: idleMutation,
  useSettleMissingProjectLinkMutation: idleMutation,
  usePushSkillToGlobalMutation: idleMutation,
  useImportProjectSkillsMutation: idleMutation,
  useRebindProjectDeploymentMutation: idleMutation,
}));

vi.mock("@/components/projects/ProjectSkillDiffDialog", () => ({
  ProjectSkillDiffDialog: () => null,
}));

vi.mock("@/components/projects/ProjectRulesPanel", () => ({
  ProjectRulesPanel: () => <div data-testid="project-rules-panel" />,
}));

vi.mock("@/components/projects/ProjectModals", () => ({
  AddProjectDialog: () => null,
  AdoptOrRebindDialog: () => null,
  ProjectSettingsDialog: () => null,
  RelocateProjectDialog: () => null,
  RemoveProjectDialog: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const makeSkill = (id: string, name: string, description: string): InstalledSkill => ({
  id,
  name,
  directory: id,
  description,
  installedAt: 1,
  updatedAt: 1,
  apps: {
    claude: false,
    "claude-desktop": false,
    codex: false,
    hermes: false,
    gemini: false,
    grokbuild: false,
    opencode: false,
    openclaw: false,
    pi: false,
    mcode: false,
  },
});

const makeProjectItem = (
  overrides: Partial<ProjectListItem> = {},
): ProjectListItem => ({
  project: {
    id: "proj-1",
    name: "alarm",
    rootPath: "/tmp/aim/alarm",
    rootIdentity: null,
    defaultMode: "symlink",
    enabledTargets: ["agents", "claude"],
    autoGitExclude: true,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides.project,
  },
  rootExists: true,
  identityMatched: true,
  isGitRepo: true,
  isWorktree: false,
  deployedCount: 0,
  syncedCount: 0,
  outdatedCount: 0,
  modifiedCount: 0,
  conflictCount: 0,
  unmanagedCount: 0,
  brokenCount: 0,
  ...overrides,
});

const makeScannedSkill = (
  overrides: Partial<ScannedProjectSkill>,
): ScannedProjectSkill => ({
  projectId: "proj-1",
  target: "agents",
  directory: "archify",
  displayName: "archify",
  description: "Architecture diagrams",
  status: "synced",
  unknownBaseline: false,
  missingOnDisk: false,
  generationMismatch: false,
  canRebindSkillId: null,
  canAutoDeleteCleanCopy: false,
  mode: "symlink",
  managedLinkTarget: null,
  actualLinkTarget: null,
  diskPath: "/tmp/aim/alarm/.agents/skills/archify",
  diskExists: true,
  isSymlink: true,
  skillId: "archify",
  skillInstallationId: null,
  deployedHash: null,
  lastMaterializedHash: null,
  diskHash: null,
  ssotHash: null,
  baselineSource: null,
  detachedAt: null,
  structureError: null,
  diagnostics: {
    frontmatterName: "archify",
    frontmatterDescription: null,
    writtenToDisk: true,
    duplicateNameConflicts: [],
    precedenceWarnings: [],
  },
  ...overrides,
});

describe("ProjectsPage - Option 1 semantic dual-pane redesign", () => {
  beforeEach(() => {
    deployMutateAsyncMock.mockReset();
    deployMutateAsyncMock.mockResolvedValue({
      deployed: [],
      skipped: [],
      warnings: [],
    });
    installedSkillsMock = [
      makeSkill("archify", "archify", "Architecture diagrams"),
      makeSkill("baoyu-design", "baoyu-design", "Design mockups"),
    ];
    skillGroupsMock = [
      {
        id: "grp-1",
        name: "设计组",
        skills: ["archify"],
        createdAt: 1,
      },
    ];
  });

  it("renders clear target toggle pills, 0/N count badge, and semantic accents in cold-start 0-enabled state", () => {
    const projectItem = makeProjectItem();
    projectsMock = [projectItem];
    scanResultMock = {
      project: projectItem.project,
      rootExists: true,
      identityMatched: true,
      entries: [],
    };

    render(<ProjectsPage />);

    // Sidebar card initials, 0/N status, emerald Git & sky mode pills
    expect(screen.getByText("AL")).toBeInTheDocument();
    expect(screen.getByText("0/2 启用")).toBeInTheDocument();

    // Header Git Repo pill & violet Skill Group button
    expect(screen.getByText("projects.gitRepo")).toHaveClass("text-emerald-700");
    const groupBtn = screen.getByTitle("按技能组一键部署或取消部署");
    expect(groupBtn.className).toContain("bg-violet-500/10");

    // Skills tab shows deployed / total count instead of Skills (0)
    expect(screen.getByText("0 / 2")).toHaveClass("bg-sky-500/10");

    // Filter tabs & visible target toggle pills (not opacity-35 faded icons)
    expect(screen.getByText("已启用 (0)")).toBeInTheDocument();
    const agentsButtons = screen.getAllByRole("button", {
      name: "通用 (.agents/skills)",
    });
    const claudeButtons = screen.getAllByRole("button", {
      name: "Claude (.claude/skills)",
    });
    expect(agentsButtons).toHaveLength(2);
    expect(claudeButtons).toHaveLength(2);
    expect(agentsButtons[0]).toHaveTextContent(".agents");
    expect(claudeButtons[0]).toHaveTextContent("Claude");
    expect(agentsButtons[0].className).not.toContain("opacity-35");
  });

  it("applies Option 1 semantic colors across mixed states (sky, orange, emerald, violet, amber)", () => {
    const projectItem = makeProjectItem({
      deployedCount: 2,
      outdatedCount: 1,
      unmanagedCount: 1,
    });
    projectsMock = [projectItem];
    installedSkillsMock = [
      makeSkill("archify", "archify", "Architecture diagrams"),
      makeSkill("baoyu-design", "baoyu-design", "Design mockups"),
    ];
    scanResultMock = {
      project: projectItem.project,
      rootExists: true,
      identityMatched: true,
      entries: [
        makeScannedSkill({
          target: "agents",
          directory: "archify",
          displayName: "archify",
          skillId: "archify",
          mode: "symlink",
          status: "synced",
        }),
        makeScannedSkill({
          target: "claude",
          directory: "archify",
          displayName: "archify",
          skillId: "archify",
          mode: "copy",
          status: "outdated",
          isSymlink: false,
        }),
        makeScannedSkill({
          target: "claude",
          directory: "baoyu-design",
          displayName: "baoyu-design",
          skillId: "baoyu-design",
          mode: "symlink",
          status: "synced",
        }),
        makeScannedSkill({
          target: "claude",
          directory: "custom-lint",
          displayName: "custom-lint",
          skillId: null,
          mode: null,
          status: "unmanaged",
          isSymlink: false,
        }),
      ],
    };

    render(<ProjectsPage />);

    // Sidebar status counts use emerald / amber / violet
    expect(screen.getByText("2 已启用")).toHaveClass("text-emerald-700");
    expect(screen.getByText("1 待处理")).toHaveClass("text-amber-700");
    expect(screen.getByText("+1 未纳管")).toHaveClass("text-violet-700");

    // Skills tab switches count badge to emerald when rows are deployed
    expect(screen.getByText("3 / 3")).toHaveClass("text-emerald-700");

    // Applied group badge in header
    expect(screen.getByText("已套用 · 设计组")).toBeInTheDocument();

    // Filter counts for attention & unmanaged
    expect(
      screen.getByText("projects.filterUpdatesOrConflicts (1)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("projects.filterUnmanaged (1)"),
    ).toBeInTheDocument();

    // Row target toggle colors:
    // archify .agents (sky), archify Claude outdated (amber),
    // baoyu-design Claude synced (orange), custom-lint Claude unmanaged (violet)
    const agentsBtns = screen.getAllByRole("button", {
      name: "通用 (.agents/skills)",
    });
    const claudeBtns = screen.getAllByRole("button", {
      name: "Claude (.claude/skills)",
    });
    expect(agentsBtns[0].className).toContain("bg-sky-500/10");
    expect(claudeBtns[0].className).toContain("bg-amber-500/10");
    expect(claudeBtns[1].className).toContain("bg-orange-500/10");
    expect(claudeBtns[2].className).toContain("bg-violet-500/10");
  });

  it("triggers deployment when clicking a clear .agents target pill in 0-enabled state", async () => {
    const projectItem = makeProjectItem();
    projectsMock = [projectItem];
    scanResultMock = {
      project: projectItem.project,
      rootExists: true,
      identityMatched: true,
      entries: [],
    };

    render(<ProjectsPage />);

    const agentsBtns = await screen.findAllByRole("button", {
      name: "通用 (.agents/skills)",
    });
    await act(async () => {
      fireEvent.click(agentsBtns[0]);
    });
    expect(deployMutateAsyncMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      skillIds: ["archify"],
      targets: ["agents"],
      modeOverride: "symlink",
      overwriteConflicts: false,
    });
  });
});
