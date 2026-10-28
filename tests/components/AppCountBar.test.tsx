import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppCountBar } from "@/components/common/AppCountBar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: { app?: string }) =>
      params?.app ? `${key}:${params.app}` : key,
  }),
}));

describe("AppCountBar", () => {
  it("shows enabled and usage together while bulk toggles depend only on enabled count", () => {
    const onToggleAll = vi.fn();
    render(
      <AppCountBar
        totalLabel=""
        leading={<span>Calls</span>}
        countsLabel={
          <>
            <span>Enabled</span>
            <span>/ Calls</span>
          </>
        }
        formatCount={(_app, count) => `${count}个 / 8次`}
        appIds={["codex"]}
        counts={{ codex: 3 }}
        totalCount={4}
        onToggleAll={onToggleAll}
      />,
    );
    const control = screen.getByRole("checkbox");
    expect(control).toHaveTextContent("3个 / 8次");
    expect(control).toHaveAttribute("aria-checked", "mixed");
    fireEvent.click(control);
    expect(onToggleAll).toHaveBeenCalledWith("codex", true);
  });

  it("keeps all agents directly available with working bulk controls", () => {
    const onToggleAll = vi.fn();
    render(
      <div style={{ width: 320 }}>
        <AppCountBar
          totalLabel=""
          countsLabel="Enabled"
          appIds={[
            "claude",
            "codex",
            "gemini",
            "grokbuild",
            "opencode",
            "hermes",
            "mcode",
          ]}
          counts={{ claude: 1, codex: 1, hermes: 1, mcode: 1 }}
          totalCount={2}
          onToggleAll={onToggleAll}
        />
      </div>,
    );
    expect(screen.getAllByRole("checkbox")).toHaveLength(7);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "common.enableAllForApp:MiniMax Code",
      }),
    );
    expect(onToggleAll).toHaveBeenCalledWith("mcode", true);
  });

  it("labels enabled counts while preserving the bulk action and description", () => {
    const onToggleAll = vi.fn();
    render(
      <AppCountBar
        totalLabel=""
        leading={<span>Calls</span>}
        countsLabel="Enabled skills (count)"
        getCountDescription={(app, count) =>
          `${count} skills enabled for ${app}`
        }
        counts={{ codex: 3 }}
        appIds={["codex"]}
        totalCount={4}
        onToggleAll={onToggleAll}
      />,
    );
    expect(screen.getByText("Enabled skills (count)")).toBeInTheDocument();
    const control = screen.getByRole("checkbox");
    expect(control.title).toContain("3 skills enabled for codex");
    expect(control).toHaveClass("bg-blue-500/10");
    fireEvent.click(control);
    expect(onToggleAll).toHaveBeenCalledWith("codex", true);
  });

  it("keeps legacy counts non-interactive without a bulk callback", () => {
    render(
      <AppCountBar
        totalLabel="2 items"
        counts={{ claude: 1 }}
        appIds={["claude"]}
      />,
    );

    expect(screen.getByText("2 items")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("uses the whole badge to turn none or mixed into all and all into none", () => {
    const onToggleAll = vi.fn();
    const { rerender } = render(
      <AppCountBar
        totalLabel="2 items"
        totalCount={2}
        counts={{ claude: 1 }}
        appIds={["claude"]}
        onToggleAll={onToggleAll}
      />,
    );

    const mixed = screen.getByRole("checkbox", {
      name: "common.enableAllForApp:Claude",
    });
    expect(mixed).toHaveAttribute("aria-checked", "mixed");
    expect(mixed).toHaveAttribute("data-selection-state", "partial");
    expect(mixed.querySelectorAll("span")).toHaveLength(2);
    expect(mixed.querySelector("svg")).not.toBeInTheDocument();
    fireEvent.click(mixed);
    expect(onToggleAll).toHaveBeenCalledWith("claude", true);

    rerender(
      <AppCountBar
        totalLabel="2 items"
        totalCount={2}
        counts={{ claude: 2 }}
        appIds={["claude"]}
        onToggleAll={onToggleAll}
      />,
    );

    const all = screen.getByRole("checkbox", {
      name: "common.disableAllForApp:Claude",
    });
    expect(all).toHaveAttribute("aria-checked", "true");
    expect(all).toHaveAttribute("data-selection-state", "all");
    expect(all.querySelectorAll("span")).toHaveLength(2);
    expect(all.querySelector("svg")).not.toBeInTheDocument();
    fireEvent.click(all);
    expect(onToggleAll).toHaveBeenLastCalledWith("claude", false);
  });

  it("does not render a trailing selection box when no items are selected", () => {
    const onToggleAll = vi.fn();
    render(
      <AppCountBar
        totalLabel="2 items"
        totalCount={2}
        counts={{ claude: 0 }}
        appIds={["claude"]}
        onToggleAll={onToggleAll}
      />,
    );

    const none = screen.getByRole("checkbox", {
      name: "common.enableAllForApp:Claude",
    });
    expect(none).toHaveAttribute("aria-checked", "false");
    expect(none).toHaveAttribute("data-selection-state", "none");
    expect(none.querySelectorAll("span")).toHaveLength(2);
    expect(none.querySelector("svg")).not.toBeInTheDocument();

    fireEvent.click(none);
    expect(onToggleAll).toHaveBeenCalledWith("claude", true);
  });

  it("disables bulk controls for an empty list or while any app is pending", () => {
    const onToggleAll = vi.fn();
    const { rerender } = render(
      <AppCountBar
        totalLabel="0 items"
        totalCount={0}
        counts={{ claude: 0 }}
        appIds={["claude"]}
        onToggleAll={onToggleAll}
      />,
    );

    expect(screen.getByRole("checkbox")).toBeDisabled();

    rerender(
      <AppCountBar
        totalLabel="2 items"
        totalCount={2}
        counts={{ claude: 1, codex: 1 }}
        appIds={["claude", "codex"]}
        pendingApp="claude"
        onToggleAll={onToggleAll}
      />,
    );

    for (const control of screen.getAllByRole("checkbox")) {
      expect(control).toBeDisabled();
      expect(control.className).not.toContain("disabled:opacity-");
    }

    const pendingControl = screen.getByRole("checkbox", {
      name: "common.enableAllForApp:Claude",
    });
    expect(pendingControl).toHaveAttribute("aria-busy", "true");
    expect(pendingControl.querySelectorAll("span")).toHaveLength(2);
    expect(pendingControl.querySelector("svg")).not.toBeInTheDocument();
  });

  it("supports disabling bulk controls during another management write", () => {
    render(
      <AppCountBar
        totalLabel="2 items"
        totalCount={2}
        counts={{ claude: 1 }}
        appIds={["claude"]}
        onToggleAll={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByRole("checkbox")).toBeDisabled();
  });

  it("keeps the total and app badges in the legacy inline layout", () => {
    render(
      <AppCountBar
        totalLabel="2 items"
        totalCount={2}
        counts={{ claude: 1 }}
        appIds={["claude"]}
        onToggleAll={vi.fn()}
      />,
    );

    const bar = screen.getByText("2 items").closest(".glass");
    expect(bar).toHaveClass("items-center");
    expect(bar).not.toHaveClass("flex-col");
  });

  it("hides pointer focus rings while preserving keyboard focus styling", () => {
    render(
      <AppCountBar
        totalLabel="2 items"
        totalCount={2}
        counts={{ claude: 1 }}
        appIds={["claude"]}
        onToggleAll={vi.fn()}
      />,
    );

    expect(screen.getByRole("checkbox")).toHaveClass(
      "select-none",
      "focus:ring-0",
      "focus-visible:outline-none",
      "focus-visible:ring-2",
    );
  });
});
