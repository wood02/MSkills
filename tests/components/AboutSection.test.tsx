import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AboutSection } from "@/components/settings/AboutSection";
import { settingsApi } from "@/lib/api";

const update = vi.hoisted(() => ({
  hasUpdate: true,
  updateInfo: {
    availableVersion: "1.0.3",
    notes: "更新说明",
    manualInstall: false,
  },
  checkUpdate: vi.fn(),
  resetDismiss: vi.fn(),
  isChecking: false,
}));
vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => update }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("1.0.2"),
}));
vi.mock("@/lib/api", () => ({
  settingsApi: {
    getToolVersions: vi.fn().mockResolvedValue([]),
    checkUpdates: vi.fn(),
    installUpdateAndRestart: vi.fn(),
  },
}));
vi.mock("@/components/settings/ToolInstallRow", () => ({
  ToolInstallRow: () => null,
}));

describe("application update actions", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    update.hasUpdate = true;
    update.updateInfo.manualInstall = false;
    vi.mocked(settingsApi.checkUpdates)
      .mockReset()
      .mockResolvedValue(undefined);
    vi.mocked(settingsApi.installUpdateAndRestart)
      .mockReset()
      .mockResolvedValue(true);
  });

  it.each([
    { portable: true, manualInstall: false },
    { portable: false, manualInstall: true },
  ])(
    "opens downloads for manual installs: %j",
    async ({ portable, manualInstall }) => {
      update.updateInfo.manualInstall = manualInstall;
      render(<AboutSection isPortable={portable} />);
      await userEvent.click(
        screen.getByRole("button", { name: "settings.downloadUpdate" }),
      );
      expect(settingsApi.checkUpdates).toHaveBeenCalledOnce();
      expect(settingsApi.installUpdateAndRestart).not.toHaveBeenCalled();
      expect(screen.getByText("settings.manualUpdateHint")).toBeInTheDocument();
    },
  );

  it("installs supported updates only after the user clicks", async () => {
    render(<AboutSection isPortable={false} />);
    expect(settingsApi.installUpdateAndRestart).not.toHaveBeenCalled();
    expect(screen.getByText("更新说明")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "settings.updateTo" }),
    );
    expect(settingsApi.installUpdateAndRestart).toHaveBeenCalledOnce();
  });

  it("offers the release page if installation fails", async () => {
    vi.mocked(settingsApi.installUpdateAndRestart).mockRejectedValue(
      new Error("signature rejected"),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      render(<AboutSection isPortable={false} />);
      await userEvent.click(
        screen.getByRole("button", { name: "settings.updateTo" }),
      );
      await waitFor(() =>
        expect(settingsApi.checkUpdates).toHaveBeenCalledOnce(),
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
