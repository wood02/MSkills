import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillDescription } from "@/components/skills/SkillDescription";

const description = "完整描述\n保留换行与 https://example.com/a/long/path";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SkillDescription", () => {
  it("opens a portal for horizontally clipped text with a fixed header and scrollable full description", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(240);
    const view = render(
      <SkillDescription
        name="ship-pr"
        description={description}
        source="本地"
        className="truncate"
      />,
    );
    const trigger = screen.getByText(description, {
      normalizer: (text) => text,
    });
    expect(trigger).not.toHaveAttribute("title");
    expect(trigger).toHaveAttribute("tabindex", "0");
    const user = userEvent.setup();
    await user.hover(trigger);
    const tooltip = await screen.findByRole("tooltip");
    expect(view.container).not.toContainElement(tooltip);
    const content = tooltip.closest("[data-side]")!;
    expect(content).toHaveAttribute("data-side", "bottom");
    expect(content).toHaveClass("w-[480px]", "rounded-lg", "bg-popover");
    expect(content).toHaveTextContent("ship-pr");
    expect(content).toHaveTextContent("本地");
    const body = content.querySelector(".overflow-y-auto")!;
    expect(body.textContent).toBe(description);
    expect(body).toHaveClass("whitespace-pre-wrap", "select-text", "min-h-0");
    expect(body).not.toHaveTextContent("ship-pr");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    await user.unhover(trigger);
    await user.tab();
    expect(trigger).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(description, {
      normalizeWhitespace: false,
    });
  });

  it("only enables the tooltip while text is clipped and remeasures after resizing or content changes", async () => {
    let contentWidth = 120;
    let resize: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      () => contentWidth,
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(240);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const view = render(
      <SkillDescription name="ship-pr" description={description} />,
    );
    const trigger = screen.getByText(description, {
      normalizer: (text) => text,
    });
    expect(trigger).not.toHaveAttribute("tabindex");
    const user = userEvent.setup();
    await user.tab();
    expect(screen.queryByRole("tooltip")).toBeNull();
    contentWidth = 600;
    act(() => resize?.());
    expect(trigger).toHaveAttribute("tabindex", "0");
    await user.tab();
    expect(await screen.findByRole("tooltip")).toBeInTheDocument();
    contentWidth = 120;
    view.rerender(<SkillDescription name="ship-pr" description="简短描述" />);
    expect(screen.getByText("简短描述")).not.toHaveAttribute("tabindex");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(disconnect).toHaveBeenCalled();
    const disconnectedBeforeUnmount = disconnect.mock.calls.length;
    view.unmount();
    expect(disconnect.mock.calls.length).toBeGreaterThan(
      disconnectedBeforeUnmount,
    );
  });
});
