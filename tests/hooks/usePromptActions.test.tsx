import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePromptActions } from "@/hooks/usePromptActions";
import type { AppId, Prompt } from "@/lib/api";

const mocks = vi.hoisted(() => ({
  getPrompts: vi.fn(),
  getCurrentFileContent: vi.fn(),
  saveCurrentFileContent: vi.fn(),
  enablePrompt: vi.fn(),
  setPromptEnabled: vi.fn(),
  reorderPrompts: vi.fn(),
  upsertPrompt: vi.fn(),
  deletePrompt: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  promptsApi: {
    getPrompts: mocks.getPrompts,
    getCurrentFileContent: mocks.getCurrentFileContent,
    saveCurrentFileContent: mocks.saveCurrentFileContent,
    enablePrompt: mocks.enablePrompt,
    setPromptEnabled: mocks.setPromptEnabled,
    reorderPrompts: mocks.reorderPrompts,
    upsertPrompt: mocks.upsertPrompt,
    deletePrompt: mocks.deletePrompt,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess,
  },
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makePrompts(id: string, name: string): Record<string, Prompt> {
  return {
    [id]: {
      id,
      name,
      content: `${name} content`,
      enabled: false,
    },
  };
}

function renderPromptActions(initialAppId: AppId) {
  return renderHook(({ appId }: { appId: AppId }) => usePromptActions(appId), {
    initialProps: { appId: initialAppId },
  });
}

describe("usePromptActions reload concurrency", () => {
  beforeEach(() => {
    mocks.getPrompts.mockReset();
    mocks.getCurrentFileContent.mockReset();
    mocks.getCurrentFileContent.mockResolvedValue(null);
    mocks.saveCurrentFileContent.mockReset();
    mocks.saveCurrentFileContent.mockResolvedValue(undefined);
    mocks.enablePrompt.mockReset();
    mocks.enablePrompt.mockResolvedValue(undefined);
    mocks.setPromptEnabled.mockReset();
    mocks.setPromptEnabled.mockResolvedValue(undefined);
    mocks.reorderPrompts.mockReset();
    mocks.reorderPrompts.mockResolvedValue(undefined);
    mocks.upsertPrompt.mockReset();
    mocks.upsertPrompt.mockResolvedValue(undefined);
    mocks.deletePrompt.mockReset();
    mocks.deletePrompt.mockResolvedValue(undefined);
    mocks.toastError.mockReset();
    mocks.toastSuccess.mockReset();
  });

  it("does not let an older app request overwrite the current app", async () => {
    const claudeRequest = createDeferred<Record<string, Prompt>>();
    const codexRequest = createDeferred<Record<string, Prompt>>();
    mocks.getPrompts.mockImplementation((appId: AppId) =>
      appId === "claude" ? claudeRequest.promise : codexRequest.promise,
    );
    mocks.getCurrentFileContent.mockImplementation(
      async (appId: AppId) => `${appId} live content`,
    );

    const { result, rerender } = renderPromptActions("claude");
    let claudeReload!: Promise<boolean>;
    act(() => {
      claudeReload = result.current.reload();
    });

    rerender({ appId: "codex" });
    let codexReload!: Promise<boolean>;
    act(() => {
      codexReload = result.current.reload();
    });

    codexRequest.resolve(makePrompts("codex-prompt", "Codex Prompt"));
    await act(async () => {
      await codexReload;
    });

    expect(result.current.prompts).toEqual(
      makePrompts("codex-prompt", "Codex Prompt"),
    );
    expect(result.current.currentFileContent).toBe("codex live content");

    claudeRequest.resolve(makePrompts("claude-prompt", "Claude Prompt"));
    await act(async () => {
      await claudeReload;
    });

    expect(result.current.prompts).toEqual(
      makePrompts("codex-prompt", "Codex Prompt"),
    );
    expect(result.current.currentFileContent).toBe("codex live content");
    expect(mocks.getCurrentFileContent).toHaveBeenCalledTimes(1);
    expect(mocks.getCurrentFileContent).toHaveBeenCalledWith("codex");
  });

  it("keeps the newer result when same-app reloads finish out of order", async () => {
    const olderRequest = createDeferred<Record<string, Prompt>>();
    const newerRequest = createDeferred<Record<string, Prompt>>();
    mocks.getPrompts
      .mockReturnValueOnce(olderRequest.promise)
      .mockReturnValueOnce(newerRequest.promise);
    mocks.getCurrentFileContent.mockResolvedValue("latest live content");

    const { result } = renderPromptActions("claude");
    let olderReload!: Promise<boolean>;
    let newerReload!: Promise<boolean>;
    act(() => {
      olderReload = result.current.reload();
      newerReload = result.current.reload();
    });

    newerRequest.resolve(makePrompts("newer-prompt", "Newer Prompt"));
    await act(async () => {
      await newerReload;
    });

    olderRequest.resolve(makePrompts("older-prompt", "Older Prompt"));
    await act(async () => {
      await olderReload;
    });

    expect(result.current.prompts).toEqual(
      makePrompts("newer-prompt", "Newer Prompt"),
    );
    expect(result.current.currentFileContent).toBe("latest live content");
    expect(mocks.getCurrentFileContent).toHaveBeenCalledTimes(1);
  });

  it("ignores an older request error while the current app is loading", async () => {
    const claudeRequest = createDeferred<Record<string, Prompt>>();
    const codexRequest = createDeferred<Record<string, Prompt>>();
    mocks.getPrompts.mockImplementation((appId: AppId) =>
      appId === "claude" ? claudeRequest.promise : codexRequest.promise,
    );

    const { result, rerender } = renderPromptActions("claude");
    let claudeReload!: Promise<boolean>;
    act(() => {
      claudeReload = result.current.reload();
    });

    rerender({ appId: "codex" });
    let codexReload!: Promise<boolean>;
    act(() => {
      codexReload = result.current.reload();
    });
    await waitFor(() => expect(result.current.loading).toBe(true));

    claudeRequest.reject(new Error("stale Claude failure"));
    await act(async () => {
      await claudeReload;
    });

    expect(result.current.loading).toBe(true);
    expect(mocks.toastError).not.toHaveBeenCalled();

    codexRequest.resolve(makePrompts("codex-prompt", "Codex Prompt"));
    await act(async () => {
      await codexReload;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.prompts).toEqual(
      makePrompts("codex-prompt", "Codex Prompt"),
    );
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("does not show an error when a pending reload fails after unmount", async () => {
    const request = createDeferred<Record<string, Prompt>>();
    mocks.getPrompts.mockReturnValue(request.promise);

    const { result, unmount } = renderPromptActions("claude");
    let reload!: Promise<boolean>;
    act(() => {
      reload = result.current.reload();
    });

    unmount();
    request.reject(new Error("failure after unmount"));
    await act(async () => {
      await reload;
    });

    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("hides the previous app prompts when the new app reload fails", async () => {
    const claudePrompts = makePrompts("claude-prompt", "Claude Prompt");
    mocks.getPrompts
      .mockResolvedValueOnce(claudePrompts)
      .mockRejectedValueOnce(new Error("Codex load failed"));
    mocks.getCurrentFileContent.mockResolvedValueOnce("claude live content");

    const { result, rerender } = renderPromptActions("claude");
    await act(async () => {
      expect(await result.current.reload()).toBe(true);
    });
    expect(result.current.prompts).toEqual(claudePrompts);
    expect(result.current.currentFileContent).toBe("claude live content");

    rerender({ appId: "codex" });
    expect(result.current.prompts).toEqual({});
    expect(result.current.currentFileContent).toBeNull();

    await act(async () => {
      expect(await result.current.reload()).toBe(false);
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.prompts).toEqual({});
    expect(result.current.currentFileContent).toBeNull();
    expect(mocks.toastError).toHaveBeenCalledWith("prompts.loadFailed");
  });

  it("does not roll back the current app when an older app toggle fails", async () => {
    const claudePrompts = makePrompts("claude-prompt", "Claude Prompt");
    const codexPrompts = makePrompts("codex-prompt", "Codex Prompt");
    const enableRequest = createDeferred<void>();
    mocks.getPrompts.mockImplementation(async (appId: AppId) =>
      appId === "claude" ? claudePrompts : codexPrompts,
    );
    mocks.setPromptEnabled.mockReturnValueOnce(enableRequest.promise);

    const { result, rerender } = renderPromptActions("claude");
    await act(async () => {
      expect(await result.current.reload()).toBe(true);
    });

    let togglePromise!: Promise<boolean>;
    act(() => {
      togglePromise = result.current.toggleEnabled("claude-prompt", true);
    });
    await waitFor(() => {
      expect(mocks.setPromptEnabled).toHaveBeenCalledWith(
        "claude",
        "claude-prompt",
        true,
      );
    });

    rerender({ appId: "codex" });
    await act(async () => {
      expect(await result.current.reload()).toBe(true);
    });
    expect(result.current.prompts).toEqual(codexPrompts);

    enableRequest.reject(new Error("stale Claude toggle failed"));
    await act(async () => {
      await expect(togglePromise).rejects.toThrow("stale Claude toggle failed");
    });

    expect(result.current.prompts).toEqual(codexPrompts);
    expect(result.current.currentFileContent).toBeNull();
  });

  it("keeps a saved prompt locally when the follow-up reload fails", async () => {
    const initialPrompts = makePrompts("existing", "Existing Prompt");
    const savedPrompt: Prompt = {
      id: "saved",
      name: "Saved Prompt",
      content: "Saved content",
      enabled: false,
    };
    mocks.getPrompts
      .mockResolvedValueOnce(initialPrompts)
      .mockRejectedValueOnce(new Error("refresh failed"));

    const { result } = renderPromptActions("claude");
    await act(async () => {
      expect(await result.current.reload()).toBe(true);
      expect(await result.current.savePrompt("saved", savedPrompt)).toBe(false);
    });

    expect(mocks.upsertPrompt).toHaveBeenCalledWith(
      "claude",
      "saved",
      savedPrompt,
    );
    expect(result.current.prompts).toEqual({
      ...initialPrompts,
      saved: savedPrompt,
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith("prompts.saveSuccess", {
      closeButton: true,
    });
  });

  it("keeps a deleted prompt removed when the follow-up reload fails", async () => {
    const initialPrompts = {
      ...makePrompts("keep", "Keep Prompt"),
      ...makePrompts("remove", "Remove Prompt"),
    };
    mocks.getPrompts
      .mockResolvedValueOnce(initialPrompts)
      .mockRejectedValueOnce(new Error("refresh failed"));

    const { result } = renderPromptActions("claude");
    await act(async () => {
      expect(await result.current.reload()).toBe(true);
      expect(await result.current.deletePrompt("remove")).toBe(false);
    });

    expect(mocks.deletePrompt).toHaveBeenCalledWith("claude", "remove");
    expect(result.current.prompts).toEqual(makePrompts("keep", "Keep Prompt"));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("prompts.deleteSuccess", {
      closeButton: true,
    });
  });

  it("keeps an optimistic toggle when the follow-up reload fails", async () => {
    const initialPrompts = makePrompts("toggle", "Toggle Prompt");
    mocks.getPrompts
      .mockResolvedValueOnce(initialPrompts)
      .mockRejectedValueOnce(new Error("refresh failed"));

    const { result } = renderPromptActions("claude");
    await act(async () => {
      expect(await result.current.reload()).toBe(true);
    });
    await act(async () => {
      expect(await result.current.toggleEnabled("toggle", true)).toBe(false);
    });

    expect(mocks.setPromptEnabled).toHaveBeenCalledWith(
      "claude",
      "toggle",
      true,
    );
    expect(result.current.prompts.toggle.enabled).toBe(true);
    expect(mocks.toastSuccess).toHaveBeenCalledWith("prompts.enableSuccess", {
      closeButton: true,
    });
  });

  it("keeps other enabled prompts active when toggling a second prompt on", async () => {
    const initialPrompts: Record<string, Prompt> = {
      first: {
        id: "first",
        name: "First Prompt",
        content: "First content",
        enabled: true,
        sortOrder: 0,
      },
      second: {
        id: "second",
        name: "Second Prompt",
        content: "Second content",
        enabled: false,
        sortOrder: 1,
      },
    };
    const toggleRequest = createDeferred<void>();
    mocks.getPrompts
      .mockResolvedValueOnce(initialPrompts)
      .mockResolvedValueOnce({
        ...initialPrompts,
        second: { ...initialPrompts.second, enabled: true },
      });
    mocks.setPromptEnabled.mockReturnValueOnce(toggleRequest.promise);

    const { result } = renderPromptActions("claude");
    await act(async () => {
      expect(await result.current.reload()).toBe(true);
    });

    let togglePromise!: Promise<boolean>;
    act(() => {
      togglePromise = result.current.toggleEnabled("second", true);
    });

    // 乐观更新阶段：启用 second 时不得把已启用的 first 关掉
    expect(result.current.prompts.first.enabled).toBe(true);
    expect(result.current.prompts.second.enabled).toBe(true);

    toggleRequest.resolve();
    await act(async () => {
      expect(await togglePromise).toBe(true);
    });

    expect(mocks.setPromptEnabled).toHaveBeenCalledWith("claude", "second", true);
    expect(result.current.prompts.first.enabled).toBe(true);
    expect(result.current.prompts.second.enabled).toBe(true);
  });

  it("rolls back optimistic order and shows toast when reorderPrompts fails", async () => {
    const initialPrompts: Record<string, Prompt> = {
      a: {
        id: "a",
        name: "Prompt A",
        content: "Content A",
        enabled: true,
        sortOrder: 0,
      },
      b: {
        id: "b",
        name: "Prompt B",
        content: "Content B",
        enabled: true,
        sortOrder: 1,
      },
    };
    mocks.getPrompts.mockResolvedValueOnce(initialPrompts);
    mocks.reorderPrompts.mockRejectedValueOnce(new Error("reorder rejected"));

    const { result } = renderPromptActions("claude");
    await act(async () => {
      expect(await result.current.reload()).toBe(true);
    });

    await act(async () => {
      await expect(result.current.reorderPrompts(["b", "a"])).rejects.toThrow(
        "reorder rejected",
      );
    });

    expect(mocks.reorderPrompts).toHaveBeenCalledWith("claude", ["b", "a"]);
    expect(Object.keys(result.current.prompts)).toEqual(["a", "b"]);
    expect(result.current.prompts.a.sortOrder).toBe(0);
    expect(mocks.toastError).toHaveBeenCalledWith("prompts.reorderFailed", {
      description: "reorder rejected",
    });
  });

  it("saves live file content, updates local snapshot, and surfaces error toast on failure", async () => {
    mocks.getPrompts.mockResolvedValue({});
    mocks.getCurrentFileContent
      .mockResolvedValueOnce("@RTK.md\n")
      .mockResolvedValueOnce("@RTK.md\n\n# Edited");

    const { result } = renderPromptActions("antigravity");
    await act(async () => {
      expect(await result.current.reload()).toBe(true);
    });
    expect(result.current.currentFileContent).toBe("@RTK.md\n");

    await act(async () => {
      expect(
        await result.current.saveCurrentFileContent("@RTK.md\n\n# Edited"),
      ).toBe(true);
    });

    expect(mocks.saveCurrentFileContent).toHaveBeenCalledWith(
      "antigravity",
      "@RTK.md\n\n# Edited",
    );
    expect(result.current.currentFileContent).toBe("@RTK.md\n\n# Edited");
    expect(mocks.toastSuccess).toHaveBeenCalledWith("prompts.saveFileSuccess", {
      closeButton: true,
    });

    mocks.saveCurrentFileContent.mockRejectedValueOnce(
      new Error("Invalid markers"),
    );
    await act(async () => {
      await expect(
        result.current.saveCurrentFileContent("<!-- mskills:start"),
      ).rejects.toThrow("Invalid markers");
    });
    expect(mocks.toastError).toHaveBeenCalledWith("prompts.saveFailed", {
      description: "Invalid markers",
    });
  });
});
