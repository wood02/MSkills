import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSkillsShLeaderboard } from "@/hooks/useSkills";

const getLeaderboardMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/skills", () => ({
  skillsApi: { getSkillsShLeaderboard: getLeaderboardMock },
}));

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

describe("public skills leaderboard pagination", () => {
  beforeEach(() => getLeaderboardMock.mockReset());

  it("loads only when enabled and follows server pagination until hasMore is false", async () => {
    getLeaderboardMock
      .mockResolvedValueOnce({ skills: [], totalCount: 400, hasMore: true })
      .mockResolvedValueOnce({ skills: [], totalCount: 400, hasMore: false });
    const { result, rerender } = renderHook(
      ({ enabled }) => useSkillsShLeaderboard("trending", enabled),
      {
        wrapper: wrapper(),
        initialProps: { enabled: false },
      },
    );
    expect(getLeaderboardMock).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(getLeaderboardMock.mock.calls).toEqual([
      ["trending", 0],
      ["trending", 1],
    ]);
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(result.current.data?.pages).toHaveLength(2);
  });

  it("retries a failed next page without losing or skipping the loaded page", async () => {
    getLeaderboardMock
      .mockResolvedValueOnce({ skills: [], totalCount: 400, hasMore: true })
      .mockRejectedValueOnce(new Error("Network failure"))
      .mockResolvedValueOnce({ skills: [], totalCount: 400, hasMore: false });
    const { result } = renderHook(() => useSkillsShLeaderboard("hot", true), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.isFetchNextPageError).toBe(true));
    expect(result.current.data?.pages).toHaveLength(1);
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(getLeaderboardMock.mock.calls).toEqual([
      ["hot", 0],
      ["hot", 1],
      ["hot", 1],
    ]);
    await waitFor(() =>
      expect(result.current.isFetchNextPageError).toBe(false),
    );
    expect(result.current.data?.pages).toHaveLength(2);
  });
});
