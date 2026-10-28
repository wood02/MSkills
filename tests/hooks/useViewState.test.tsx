import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useViewState } from "@/hooks/useViewState";

describe("useViewState", () => {
  it("keeps the value after the component unmounts and remounts", () => {
    const first = renderHook(() => useViewState("test.search", ""));
    act(() => first.result.current[1]("abc"));
    first.unmount();

    const second = renderHook(() => useViewState("test.search", ""));
    expect(second.result.current[0]).toBe("abc");
  });

  it("supports updater functions and isolates keys", () => {
    const { result } = renderHook(() => useViewState("test.count", 1));
    act(() => result.current[1]((prev) => prev + 1));
    expect(result.current[0]).toBe(2);

    const other = renderHook(() => useViewState("test.other", 1));
    expect(other.result.current[0]).toBe(1);
  });
});
