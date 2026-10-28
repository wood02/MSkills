import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppToggleGroup } from "@/components/common/AppToggleGroup";
import { TooltipProvider } from "@/components/ui/tooltip";

describe("AppToggleGroup", () => {
  it.each([
    ["codex", "bg-blue-500"],
    ["claude", "bg-[#D97757]"],
  ] as const)(
    "uses the %s brand color and preserves its count in gray when disabled",
    (app, color) => {
      const props = {
        onToggle: vi.fn(),
        usage: { [app]: { count: 3, label: "3 uses" } },
      };
      const { container, rerender } = render(
        <TooltipProvider>
          <AppToggleGroup {...props} appIds={[app]} apps={{ [app]: true }} />
        </TooltipProvider>,
      );
      const badge = container.querySelector(`[data-usage-app="${app}"]`);
      expect(badge).toHaveTextContent("3");
      expect(badge).toHaveClass(color, "text-white");
      expect(badge).not.toHaveAttribute("data-usage-warning");
      if (app === "codex") {
        expect(
          screen
            .getByRole("button", { name: "Codex" })
            .querySelector("svg title"),
        ).toHaveTextContent("Codex");
      }
      rerender(
        <TooltipProvider>
          <AppToggleGroup {...props} appIds={[app]} apps={{ [app]: false }} />
        </TooltipProvider>,
      );
      expect(badge).toHaveTextContent("3");
      expect(badge).toHaveClass("bg-zinc-200");
      expect(badge).not.toHaveClass(color);
      expect(badge).toHaveAttribute("data-usage-warning", "true");
    },
  );

  it("exposes each app state and respects the shared disabled state", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <TooltipProvider>
        <AppToggleGroup
          apps={{ claude: true }}
          appIds={["claude"]}
          onToggle={onToggle}
        />
      </TooltipProvider>,
    );

    const enabledButton = screen.getByRole("button", { name: "Claude" });
    expect(enabledButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(enabledButton);
    expect(onToggle).toHaveBeenCalledWith("claude", false);

    rerender(
      <TooltipProvider>
        <AppToggleGroup
          apps={{ claude: false }}
          appIds={["claude"]}
          onToggle={onToggle}
          disabled
        />
      </TooltipProvider>,
    );

    const disabledButton = screen.getByRole("button", { name: "Claude" });
    expect(disabledButton).toHaveAttribute("aria-pressed", "false");
    expect(disabledButton).toBeDisabled();
    expect(disabledButton.className).not.toContain("disabled:opacity-");
  });
});
