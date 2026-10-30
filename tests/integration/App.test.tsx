import { Suspense, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import userEvent from "@testing-library/user-event";
import { resetProviderState, getSettings, setSettings } from "../msw/state";
import { emitTauriEvent } from "../msw/tauriMocks";
import { server } from "../msw/server";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const skillsPanelMocks = vi.hoisted(() => ({
  checkUpdates: vi.fn(),
  openDiscovery: vi.fn(),
  openInstallFromZip: vi.fn(),
  openRestoreFromBackup: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/components/providers/ProviderList", () => ({
  ProviderList: ({
    providers,
    currentProviderId,
    onSwitch,
    onEdit,
    onDuplicate,
    onConfigureUsage,
    onOpenWebsite,
    onCreate,
    onDelete,
    onRemoveFromConfig,
  }: any) => (
    <div>
      <div data-testid="provider-list">{JSON.stringify(providers)}</div>
      <div data-testid="current-provider">{currentProviderId}</div>
      <button onClick={() => onSwitch(providers[currentProviderId])}>
        switch
      </button>
      <button onClick={() => onEdit(providers[currentProviderId])}>edit</button>
      <button onClick={() => onDuplicate(providers[currentProviderId])}>
        duplicate
      </button>
      <button onClick={() => onConfigureUsage(providers[currentProviderId])}>
        usage
      </button>
      <button onClick={() => onOpenWebsite("https://example.com")}>
        open-website
      </button>
      <button onClick={() => onDelete(Object.values(providers)[0])}>
        delete
      </button>
      <button onClick={() => onRemoveFromConfig?.(Object.values(providers)[0])}>
        remove
      </button>
      <button onClick={() => onCreate?.()}>create</button>
    </div>
  ),
}));

vi.mock("@/components/providers/AddProviderDialog", () => ({
  AddProviderDialog: ({ open, onOpenChange, onSubmit, appId }: any) =>
    open ? (
      <div data-testid="add-provider-dialog">
        <button
          onClick={() =>
            onSubmit({
              name: `New ${appId} Provider`,
              settingsConfig: {},
              category: "custom",
              sortIndex: 99,
            })
          }
        >
          confirm-add
        </button>
        <button onClick={() => onOpenChange(false)}>close-add</button>
      </div>
    ) : null,
}));

vi.mock("@/components/providers/EditProviderDialog", () => ({
  EditProviderDialog: ({ open, provider, onSubmit, onOpenChange }: any) =>
    open ? (
      <div data-testid="edit-provider-dialog">
        <button
          onClick={() =>
            onSubmit({
              provider: {
                ...provider,
                name: `${provider.name}-edited`,
              },
              originalId: provider.id,
            })
          }
        >
          confirm-edit
        </button>
        <button onClick={() => onOpenChange(false)}>close-edit</button>
      </div>
    ) : null,
}));

vi.mock("@/components/UsageScriptModal", () => ({
  default: ({ isOpen, provider, onSave, onClose }: any) =>
    isOpen ? (
      <div data-testid="usage-modal">
        <span data-testid="usage-provider">{provider?.id}</span>
        <button onClick={() => onSave("script-code")}>save-script</button>
        <button onClick={() => onClose()}>close-usage</button>
      </div>
    ) : null,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, message, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <div data-testid="confirm-message">{message}</div>
        <button onClick={() => onConfirm()}>confirm-delete</button>
        <button onClick={() => onCancel()}>cancel-delete</button>
      </div>
    ) : null,
}));

vi.mock("@/components/AppSwitcher", () => ({
  AppSwitcher: ({ activeApp, onSwitch }: any) => (
    <div data-testid="app-switcher">
      <span>{activeApp}</span>
      <button onClick={() => onSwitch("claude")}>switch-claude</button>
      <button onClick={() => onSwitch("codex")}>switch-codex</button>
      <button onClick={() => onSwitch("openclaw")}>switch-openclaw</button>
    </div>
  ),
}));

vi.mock("@/components/skills/UnifiedSkillsPanel", async () => {
  const React = await import("react");
  const MockUnifiedSkillsPanel = React.forwardRef(
    ({ onCheckUpdatesStateChange, visibleApps }: any, ref) => {
      React.useEffect(() => {
        onCheckUpdatesStateChange?.({ isChecking: false, hasSkills: true });
        return () =>
          onCheckUpdatesStateChange?.({
            isChecking: false,
            hasSkills: false,
          });
      }, [onCheckUpdatesStateChange]);
      React.useImperativeHandle(ref, () => ({
        openDiscovery: skillsPanelMocks.openDiscovery,
        openImport: vi.fn(),
        openInstallFromZip: skillsPanelMocks.openInstallFromZip,
        openRestoreFromBackup: skillsPanelMocks.openRestoreFromBackup,
        checkUpdates: skillsPanelMocks.checkUpdates,
      }));
      return (
        <div data-testid="unified-skills-panel">
          <span data-testid="skills-visible-apps">
            {JSON.stringify(visibleApps ?? null)}
          </span>
        </div>
      );
    },
  );
  MockUnifiedSkillsPanel.displayName = "MockUnifiedSkillsPanel";
  return { default: MockUnifiedSkillsPanel };
});

vi.mock("@/components/UpdateBadge", () => ({
  UpdateBadge: ({ onClick }: any) => (
    <button onClick={onClick}>update-badge</button>
  ),
}));

vi.mock("@/components/mcp/McpPanel", () => ({
  default: ({ open, onOpenChange }: any) =>
    open ? (
      <div data-testid="mcp-panel">
        <button onClick={() => onOpenChange(false)}>close-mcp</button>
      </div>
    ) : (
      <button onClick={() => onOpenChange(true)}>open-mcp</button>
    ),
}));

const renderApp = (AppComponent: ComponentType) => {
  const client = new QueryClient();
  const result = render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <AppComponent />
      </Suspense>
    </QueryClientProvider>,
  );
  return { ...result, client };
};

describe("App integration with MSW", () => {
  beforeEach(() => {
    resetProviderState();
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    skillsPanelMocks.checkUpdates.mockReset();
    skillsPanelMocks.openDiscovery.mockReset();
    skillsPanelMocks.openInstallFromZip.mockReset();
    skillsPanelMocks.openRestoreFromBackup.mockReset();
    localStorage.removeItem("mskills-last-view");
    localStorage.removeItem("mskills-last-app");
  });

  it("shows toast when auto sync fails in background", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    expect(
      await screen.findByTestId("unified-skills-panel"),
    ).toBeInTheDocument();

    expect(() => {
      emitTauriEvent("webdav-sync-status-updated", null);
    }).not.toThrow();
    expect(toastErrorMock).not.toHaveBeenCalled();

    emitTauriEvent("webdav-sync-status-updated", {
      source: "auto",
      status: "error",
      error: "network timeout",
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });

    toastErrorMock.mockReset();
    expect(() => {
      emitTauriEvent("s3-sync-status-updated", null);
    }).not.toThrow();
    expect(toastErrorMock).not.toHaveBeenCalled();

    emitTauriEvent("s3-sync-status-updated", {
      source: "auto",
      status: "error",
      error: "s3 timeout",
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
  });

  it("lands on Skills instead of the removed provider page", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    localStorage.setItem("mskills-last-view", "providers");
    const { default: App } = await import("@/App");
    renderApp(App);

    expect(
      await screen.findByTestId("unified-skills-panel"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("provider-list")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "common.back" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "provider.addNewProvider" }),
    ).not.toBeInTheDocument();
  });

  it.each([undefined, false])(
    "keeps the remembered page when startup Skills is %s",
    async (enabled) => {
      setSettings({ openSkillsOnStartup: enabled });
      localStorage.setItem("mskills-last-view", "skills");
      const { default: App } = await import("@/App");
      const { client } = renderApp(App);

      expect(
        await screen.findByTestId("unified-skills-panel"),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(client.getQueryData(["settings"])).toBeDefined(),
      );
      expect(screen.getByTestId("unified-skills-panel")).toBeInTheDocument();
    },
  );

  it("passes the selected apps to Skills only while the display preference is enabled", async () => {
    setSettings({
      skillsFollowVisibleApps: true,
      firstRunNoticeConfirmed: true,
      visibleApps: {
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
        dsh: false,
      },
    });
    localStorage.setItem("mskills-last-view", "skills");
    const { default: App } = await import("@/App");
    const { client } = renderApp(App);
    await waitFor(() =>
      expect(
        JSON.parse(screen.getByTestId("skills-visible-apps").textContent!),
      ).toEqual(getSettings().visibleApps),
    );
    act(() => {
      client.setQueryData(["settings"], {
        ...getSettings(),
        skillsFollowVisibleApps: false,
      });
    });
    await waitFor(() =>
      expect(screen.getByTestId("skills-visible-apps")).toHaveTextContent(
        "null",
      ),
    );
  });

  it("hosts the Skills check-update action in the App toolbar", async () => {
    localStorage.setItem("mskills-last-view", "skills");
    const { default: App } = await import("@/App");
    renderApp(App);

    expect(
      await screen.findByTestId("unified-skills-panel"),
    ).toBeInTheDocument();
    const checkUpdatesButton = await screen.findByRole("button", {
      name: "skills.checkUpdates",
    });
    await waitFor(() => expect(checkUpdatesButton).toBeEnabled());

    fireEvent.click(checkUpdatesButton);
    expect(skillsPanelMocks.checkUpdates).toHaveBeenCalledTimes(1);
  });

  it("applies a skill group to the viewed app from the Skills page", async () => {
    const skill = (id: string, pi: boolean) => ({
      id,
      name: id,
      directory: id.replace("local:", ""),
      apps: { claude: false, codex: false, pi },
      installedAt: 1,
    });
    const applied: unknown[] = [];
    let currentGroup = "fe";
    let profileCalls = 0;
    server.use(
      http.post("http://tauri.local/get_current_skill_group", () =>
        HttpResponse.json(currentGroup),
      ),
      http.post("http://tauri.local/list_skill_groups", () =>
        HttpResponse.json([
          { id: "fe", name: "Frontend", skills: ["local:a"] },
          { id: "docs", name: "Docs", skills: ["local:b", "local:gone"] },
        ]),
      ),
      http.post("http://tauri.local/get_installed_skills", () =>
        HttpResponse.json([skill("local:a", true), skill("local:b", false)]),
      ),
      http.post("http://tauri.local/apply_skill_group", async ({ request }) => {
        const body = (await request.json()) as { id: string; app: string };
        applied.push(body);
        currentGroup = body.id;
        return HttpResponse.json([]);
      }),
      http.post("http://tauri.local/apply_profile", () => {
        profileCalls += 1;
        return HttpResponse.json([]);
      }),
    );
    localStorage.setItem("mskills-last-view", "skills");
    localStorage.setItem("mskills-last-app", "pi");
    const { default: App } = await import("@/App");
    renderApp(App);

    const trigger = await screen.findByRole("combobox", {
      name: "skills.group.ariaLabel",
    });
    expect(trigger).toHaveAttribute("title", "skills.group.tooltip");
    // pi 当前启用的 Skill 集合与「Frontend」一致
    await waitFor(() => expect(trigger).toHaveTextContent("Frontend"));

    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText("Docs"));

    await waitFor(() => expect(applied).toEqual([{ id: "docs", app: "pi" }]));
    await waitFor(() => expect(trigger).toHaveTextContent("Docs"));
    expect(profileCalls).toBe(0);
  });

  it("badges the Skills button when the startup check finds updates", async () => {
    server.use(
      http.post("http://tauri.local/check_skill_updates", () =>
        HttpResponse.json([
          { id: "local:demo", name: "demo", remoteHash: "h" },
        ]),
      ),
    );
    const { default: App } = await import("@/App");
    renderApp(App);

    expect(
      (await screen.findAllByTitle(/skills\.updatesFound/)).length,
    ).toBeGreaterThan(0);
  });

  it("routes the Skills discover toolbar action through the panel guard", async () => {
    localStorage.setItem("mskills-last-view", "skills");
    const { default: App } = await import("@/App");
    renderApp(App);

    expect(
      await screen.findByTestId("unified-skills-panel"),
    ).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "skills.discover",
      }),
    );

    expect(skillsPanelMocks.openDiscovery).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("unified-skills-panel")).toBeInTheDocument();
  });

  it("groups the Skills add actions under one toolbar menu", async () => {
    localStorage.setItem("mskills-last-view", "skills");
    const { default: App } = await import("@/App");
    renderApp(App);
    const user = userEvent.setup({ pointerEventsCheck: 0 });

    expect(
      await screen.findByTestId("unified-skills-panel"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "skills.installFromZip.button" }),
    ).not.toBeInTheDocument();

    await user.click(
      await screen.findByRole("button", { name: /skills\.add/ }),
    );
    for (const name of [
      "skills.create.button",
      "skills.import",
      "skills.restoreFromBackup.button",
    ]) {
      expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
    }
    await user.click(
      screen.getByRole("menuitem", { name: "skills.installFromZip.button" }),
    );
    expect(skillsPanelMocks.openInstallFromZip).toHaveBeenCalledTimes(1);
  });
});
