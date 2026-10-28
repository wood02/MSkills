import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { SkillGroupSwitcher } from "@/components/skills/SkillGroupSwitcher";
import { server } from "../msw/server";

describe("SkillGroupSwitcher", () => {
  it("keeps the explicitly selected group when two groups contain the same skills", async () => {
    let current = "a";
    const applied: string[] = [];
    server.use(
      http.post("http://tauri.local/list_skill_groups", () =>
        HttpResponse.json([
          { id: "a", name: "Group A", skills: ["local:a"] },
          { id: "b", name: "Group B", skills: ["local:a"] },
        ]),
      ),
      http.post("http://tauri.local/get_current_skill_group", () =>
        HttpResponse.json(current),
      ),
      http.post("http://tauri.local/get_installed_skills", () =>
        HttpResponse.json([
          {
            id: "local:a",
            name: "a",
            directory: "a",
            installedAt: 1,
            apps: { codex: true },
          },
        ]),
      ),
      http.post("http://tauri.local/apply_skill_group", async ({ request }) => {
        current = ((await request.json()) as { id: string }).id;
        applied.push(current);
        return HttpResponse.json([]);
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <SkillGroupSwitcher app="codex" />
      </QueryClientProvider>,
    );
    const trigger = await screen.findByRole("combobox", {
      name: "skills.group.ariaLabel",
    });
    await waitFor(() => expect(trigger).toHaveTextContent("Group A"));
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByText("Group B"));
    await waitFor(() => expect(applied).toEqual(["b"]));
    await waitFor(() => expect(trigger).toHaveTextContent("Group B"));
    view.unmount();
    render(
      <QueryClientProvider client={client}>
        <SkillGroupSwitcher app="codex" />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("combobox", { name: "skills.group.ariaLabel" }),
    ).toHaveTextContent("Group B");
    client.clear();
  });

  it("does not guess a current group from the enabled set before one has been selected", async () => {
    server.use(
      http.post("http://tauri.local/list_skill_groups", () =>
        HttpResponse.json([{ id: "a", name: "Group A", skills: [] }]),
      ),
      http.post("http://tauri.local/get_current_skill_group", () =>
        HttpResponse.json(null),
      ),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SkillGroupSwitcher app="codex" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(client.getQueryData(["skillGroups"])).toBeDefined(),
    );
    expect(
      screen.getByRole("combobox", { name: "skills.group.ariaLabel" }),
    ).toHaveTextContent("skills.group.none");
    client.clear();
  });
});
