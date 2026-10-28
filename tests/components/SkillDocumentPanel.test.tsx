import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SkillDocumentPanel } from "@/components/skills/SkillDocumentPanel";
import { SkillMarkdownPreview } from "@/components/skills/SkillMarkdownPreview";
import {
  skillsApi,
  type InstalledSkill,
  type SkillDocument,
  type SkillDocumentSaveResult,
} from "@/lib/api/skills";
import { createTestQueryClient } from "../utils/testQueryClient";

const notices = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: notices }));
vi.mock("@/components/MarkdownEditor", () => ({
  default: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange: (value: string) => void;
    readOnly: boolean;
  }) => (
    <textarea
      aria-label="SKILL.md"
      value={value}
      readOnly={readOnly}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const skill: InstalledSkill = {
  id: "local:example",
  name: "Example",
  directory: "example",
  installedAt: 1,
  updatedAt: 0,
  apps: {
    claude: true,
    codex: false,
    gemini: false,
    opencode: false,
    openclaw: false,
    hermes: false,
    pi: false,
  },
};
const original = {
  content: "# Original\n\nSkill instructions",
  revision: "1:old",
  path: "/tmp/skills/example/SKILL.md",
};

function renderPanel(cachedDocument?: SkillDocument) {
  const client = createTestQueryClient();
  if (cachedDocument)
    client.setQueryData(["skills", "document", skill.id], cachedDocument);
  client.setQueryData(["skills", "installed"], [skill]);
  const close = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SkillDocumentPanel skill={skill} onClose={close} />
    </QueryClientProvider>,
  );
  return { client, close };
}

describe("SkillDocumentPanel", () => {
  it("waits for the local file instead of editing old cache and preserves a draft when cache changes", async () => {
    const latest = { ...original, content: "# Latest", revision: "1:latest" };
    vi.mocked(skillsApi.readDocument).mockResolvedValue(latest);
    const user = userEvent.setup();
    const { client } = renderPanel({ ...original, content: "# Old cache" });
    expect(
      screen.queryByRole("button", { name: "skills.document.edit" }),
    ).not.toBeInTheDocument();
    await screen.findByRole("heading", { name: "Latest" });
    await user.click(
      screen.getByRole("button", { name: "skills.document.edit" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "SKILL.md" }),
      " draft",
    );
    client.setQueryData(["skills", "document", skill.id], {
      ...latest,
      content: "# External",
      revision: "1:external",
    });
    expect(screen.getByRole("textbox", { name: "SKILL.md" })).toHaveValue(
      "# Latest draft",
    );
    await user.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(skillsApi.saveDocument).toHaveBeenCalledWith(
        skill.id,
        "# Latest draft",
        latest.revision,
      ),
    );
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(skillsApi, "readDocument").mockResolvedValue(original);
    vi.spyOn(skillsApi, "saveDocument").mockImplementation(
      async (_id, content) => ({
        document: { ...original, content, revision: "1:new" },
        skill: { ...skill, name: "Updated" },
        backupPath: "/tmp/backup",
        syncErrors: [],
      }),
    );
  });

  it("previews the local document, preserves the draft across modes, and saves with its revision", async () => {
    const user = userEvent.setup();
    const { client } = renderPanel();
    expect(
      await screen.findByRole("heading", { name: "Original" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "common.save" })).toBeDisabled();
    await user.click(
      screen.getByRole("button", { name: "skills.document.edit" }),
    );
    await user.clear(screen.getByRole("textbox", { name: "SKILL.md" }));
    await user.type(
      screen.getByRole("textbox", { name: "SKILL.md" }),
      "# Updated",
    );
    await user.click(
      screen.getByRole("button", { name: "skills.document.preview" }),
    );
    expect(screen.getByRole("heading", { name: "Updated" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(skillsApi.saveDocument).toHaveBeenCalledWith(
        skill.id,
        "# Updated",
        original.revision,
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "common.save" }),
      ).toBeDisabled(),
    );
    expect(
      client.getQueryData<InstalledSkill[]>(["skills", "installed"])?.[0].name,
    ).toBe("Updated");
  });

  it("keeps unsaved content when saving fails and asks before discarding it", async () => {
    vi.mocked(skillsApi.saveDocument).mockRejectedValue(
      new Error("changed externally"),
    );
    const user = userEvent.setup();
    const { close } = renderPanel();
    await screen.findByRole("heading", { name: "Original" });
    await user.click(
      screen.getByRole("button", { name: "skills.document.edit" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "SKILL.md" }),
      " draft",
    );
    await user.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(notices.error).toHaveBeenCalledWith(
        "skills.document.saveFailed",
        expect.objectContaining({ description: "Error: changed externally" }),
      ),
    );
    expect(screen.getByRole("textbox", { name: "SKILL.md" })).toHaveValue(
      `${original.content} draft`,
    );
    await user.click(screen.getByRole("button", { name: "common.back" }));
    expect(close).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(screen.getByRole("textbox", { name: "SKILL.md" })).toHaveValue(
      `${original.content} draft`,
    );
    await user.click(screen.getByRole("button", { name: "common.back" }));
    await user.click(
      screen.getByRole("button", { name: "skills.document.discard" }),
    );
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports partial sync as a saved document and keeps the refreshed revision", async () => {
    const result: SkillDocumentSaveResult = {
      document: { ...original, content: "# New", revision: "1:new" },
      skill,
      backupPath: "/tmp/backup",
      syncErrors: ["codex: permission denied"],
    };
    vi.mocked(skillsApi.saveDocument).mockResolvedValue(result);
    const user = userEvent.setup();
    const { client } = renderPanel();
    await screen.findByRole("heading", { name: "Original" });
    await user.click(
      screen.getByRole("button", { name: "skills.document.edit" }),
    );
    await user.clear(screen.getByRole("textbox", { name: "SKILL.md" }));
    await user.type(screen.getByRole("textbox", { name: "SKILL.md" }), "# New");
    await user.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() =>
      expect(notices.warning).toHaveBeenCalledWith(
        "skills.document.syncPartial",
        expect.objectContaining({ description: result.syncErrors[0] }),
      ),
    );
    expect(client.getQueryData(["skills", "document", skill.id])).toEqual(
      result.document,
    );
  });

  it("shows a read failure without exposing an editor or save action", async () => {
    vi.mocked(skillsApi.readDocument).mockRejectedValue(
      new Error("missing document"),
    );
    const user = userEvent.setup();
    renderPanel({ ...original, content: "# Old cache" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "missing document",
    );
    expect(
      screen.queryByRole("button", { name: "common.save" }),
    ).not.toBeInTheDocument();
    vi.mocked(skillsApi.readDocument).mockResolvedValue(original);
    await user.click(
      screen.getByRole("button", { name: "skills.document.retry" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Original" }),
    ).toBeVisible();
  });
});

describe("SkillMarkdownPreview", () => {
  it("renders headings, lists, tables and code while keeping front matter out of the body", () => {
    const { container } = render(
      <SkillMarkdownPreview
        content={
          '---\nname: example\n---\n# Guide\n\n- First\n- **Second**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```python\nprint("hello")\n```'
        }
      />,
    );
    expect(screen.getByRole("heading", { name: "Guide" })).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("columnheader", { name: "A" })).toBeVisible();
    expect(screen.getByRole("cell", { name: "2" })).toBeVisible();
    expect(container.querySelector("pre")).toHaveTextContent('print("hello")');
    expect(container).not.toHaveTextContent("name: example");
  });

  it("renders HTML and unsafe links as text without executing them or fetching images", () => {
    const { container } = render(
      <SkillMarkdownPreview
        content={
          "<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![remote](https://example.com/image.png)"
        }
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container).toHaveTextContent("<script>alert(1)</script>");
  });
});
