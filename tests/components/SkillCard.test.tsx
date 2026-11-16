import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillCard } from "@/components/skills/SkillCard";

const skill = {
  key: "owner/repo/test",
  name: "Test skill",
  description:
    "A long description with all the details available from the source.",
  directory: "test",
  repoOwner: "owner",
  repoName: "repo",
  repoBranch: "main",
  installed: false,
};

const renderCard = () =>
  render(
    <SkillCard
      skill={skill}
      onInstall={vi.fn()}
      onUninstall={vi.fn()}
      viewOnly
    />,
  );

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SkillCard description", () => {
  it("shows the full clipped description on hover and keyboard focus outside the clipped card", async () => {
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(160);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80);
    const view = renderCard();
    const description = screen.getByText(skill.description);
    expect(description).toHaveClass("line-clamp-4");
    expect(description).toHaveAttribute("tabindex", "0");
    expect(description).not.toHaveAttribute("title");

    const user = userEvent.setup();
    await user.hover(description);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent(skill.description);
    expect(view.container).not.toContainElement(tooltip);
    expect(tooltip.closest("[data-side]")).toHaveClass(
      "overflow-y-auto",
      "select-text",
      "whitespace-pre-wrap",
    );
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
    await user.unhover(description);
    await user.tab();
    expect(description).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      skill.description,
    );
  });

  it("does not open for untruncated text and rechecks overflow when the card is resized", async () => {
    let contentHeight = 40;
    let resize: (() => void) | undefined;
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      () => contentHeight,
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: () => void) {}
        observe(element: Element) {
          if (element.tagName === "P") resize ??= this.callback;
        }
        unobserve() {}
        disconnect() {}
      },
    );
    renderCard();
    const description = screen.getByText(skill.description);
    expect(description).not.toHaveAttribute("tabindex");
    const user = userEvent.setup();
    await user.hover(description);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    await user.unhover(description);

    contentHeight = 160;
    act(() => resize?.());
    expect(description).toHaveAttribute("tabindex", "0");
    await user.hover(description);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      skill.description,
    );

    contentHeight = 40;
    act(() => resize?.());
    await waitFor(() =>
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument(),
    );
    expect(description).not.toHaveAttribute("tabindex");
  });
});

describe("SkillCard ranking and install status", () => {
  it("renders unique rosette SVG medals for top 3 and aligned plain badge for rank 4+", () => {
    render(
      <div>
        <SkillCard
          skill={{ ...skill, key: "k1", installed: false }}
          ranking={{
            rank: 1,
            platform: "skills.sh",
            metric: { icon: "award", label: "综合分", value: "81.1" },
          }}
          onInstall={vi.fn()}
        />
        <SkillCard
          skill={{ ...skill, key: "k2", installed: false }}
          ranking={{
            rank: 2,
            platform: "skills.sh",
            metric: { icon: "award", label: "综合分", value: "76.3" },
          }}
          onInstall={vi.fn()}
        />
        <SkillCard
          skill={{ ...skill, key: "k4", installed: false }}
          ranking={{
            rank: 4,
            platform: "skills.sh",
            metric: { icon: "award", label: "综合分", value: "67.3" },
          }}
          onInstall={vi.fn()}
        />
      </div>,
    );

    const gold = screen.getByLabelText("#1");
    const silver = screen.getByLabelText("#2");
    const fourth = screen.getByLabelText("#4");

    expect(gold.querySelector("svg")).toBeInTheDocument();
    expect(silver.querySelector("svg")).toBeInTheDocument();
    expect(fourth.querySelector("svg")).not.toBeInTheDocument();
    expect(fourth).toHaveTextContent("#4");

    const goldGrad = gold.querySelector("linearGradient")?.id;
    const silverGrad = silver.querySelector("linearGradient")?.id;
    expect(goldGrad).toBeTruthy();
    expect(silverGrad).toBeTruthy();
    expect(goldGrad).not.toBe(silverGrad);

    expect(gold.closest("div.glass-card")).toHaveClass("border-amber-500/45");
    expect(screen.getByTitle("综合分 81.1")).toHaveTextContent("综合分81.1");
  });

  it("shows an honest installed status pill instead of an uninstall button", () => {
    render(
      <SkillCard
        skill={{ ...skill, installed: true }}
        ranking={{
          rank: 2,
          platform: "skills.sh",
          metric: { icon: "award", label: "综合分", value: "76.3" },
        }}
        onInstall={vi.fn()}
      />,
    );

    expect(screen.getByText("skills.installed")).toBeInTheDocument();
    expect(
      screen.getByTitle("skills.uninstallInMainPanel"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "skills.uninstall" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "skills.install" }),
    ).not.toBeInTheDocument();
  });
});
