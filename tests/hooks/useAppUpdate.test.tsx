import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdateProvider, useUpdate } from "@/contexts/UpdateContext";
import { checkForUpdate } from "@/lib/updater";

vi.mock("@/lib/updater", () => ({ checkForUpdate: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(checkForUpdate)
    .mockReset()
    .mockResolvedValue({
      status: "available",
      info: {
        currentVersion: "1.0.2",
        availableVersion: "1.0.3",
        notes: "更新说明",
        manualInstall: false,
      },
    });
});
afterEach(() => vi.useRealTimers());

it("checks at startup and exposes the new version and release notes", async () => {
  const { result } = renderHook(() => useUpdate(), { wrapper: UpdateProvider });
  expect(checkForUpdate).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(checkForUpdate).toHaveBeenCalledOnce();
  expect(result.current.hasUpdate).toBe(true);
  expect(result.current.updateInfo?.notes).toBe("更新说明");
});

it("exposes check failures and allows retrying", async () => {
  const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    vi.mocked(checkForUpdate).mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useUpdate(), {
      wrapper: UpdateProvider,
    });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(result.current.error).toBe("offline");
    expect(result.current.hasUpdate).toBe(false);
    await act(async () => {
      await result.current.checkUpdate();
    });
    expect(result.current.hasUpdate).toBe(true);
    expect(result.current.error).toBeNull();
  } finally {
    consoleError.mockRestore();
  }
});
