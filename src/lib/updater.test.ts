import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBundleType } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";
import { checkForUpdate } from "./updater";

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("1.0.2"),
  getBundleType: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));

describe("application updater", () => {
  const close = vi.fn();
  beforeEach(() => {
    close.mockReset().mockResolvedValue(undefined);
    vi.mocked(check)
      .mockReset()
      .mockResolvedValue({
        currentVersion: "1.0.2",
        version: "1.0.3",
        body: "更新说明",
        date: "2026-10-30T00:00:00Z",
        close,
      } as unknown as NonNullable<Awaited<ReturnType<typeof check>>>);
    vi.mocked(getBundleType).mockReset();
  });

  it.each(["app", "msi", "appimage"])(
    "checks %s updates and returns release notes",
    async (bundle) => {
      vi.mocked(getBundleType).mockResolvedValue(
        bundle as Awaited<ReturnType<typeof getBundleType>>,
      );
      expect(await checkForUpdate({ timeout: 1234 })).toEqual({
        status: "available",
        info: {
          currentVersion: "1.0.2",
          availableVersion: "1.0.3",
          notes: "更新说明",
          pubDate: "2026-10-30T00:00:00Z",
          manualInstall: false,
        },
      });
      expect(check).toHaveBeenCalledWith({ timeout: 1234 });
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each(["deb", "rpm", "unknown"])(
    "requires manual installation for %s",
    async (bundle) => {
      vi.mocked(getBundleType).mockResolvedValue(
        bundle as Awaited<ReturnType<typeof getBundleType>>,
      );
      const result = await checkForUpdate();
      expect(result.status === "available" && result.info.manualInstall).toBe(
        true,
      );
    },
  );

  it("uses manual installation if the bundle type cannot be determined", async () => {
    vi.mocked(getBundleType).mockRejectedValue(new Error("unknown bundle"));
    const result = await checkForUpdate();
    expect(result.status === "available" && result.info.manualInstall).toBe(
      true,
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports up-to-date only when the update source reports no newer version", async () => {
    vi.mocked(check).mockResolvedValue(null);
    expect(await checkForUpdate()).toEqual({ status: "up-to-date" });
  });

  it("propagates update-source failures instead of claiming up-to-date", async () => {
    vi.mocked(check).mockRejectedValue(new Error("network unavailable"));
    await expect(checkForUpdate()).rejects.toThrow("network unavailable");
  });
});
