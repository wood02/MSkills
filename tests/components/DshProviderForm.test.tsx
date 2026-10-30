import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DshProviderForm } from "@/components/providers/forms/DshProviderForm";

vi.mock("@/components/JsonEditor", () => ({
  default: ({
    id,
    value,
    onChange,
  }: {
    id: string;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const native = {
  api: "openai-responses",
  baseURL: "https://example.com/v1",
  apiKeyEnv: "SAVED_KEY",
  models: [
    { id: "model", contextWindow: 200000, reasoningEfforts: { high: "high" } },
  ],
  compat: { supportsMaxOutputTokens: false },
};

describe("DshProviderForm", () => {
  it("preserves native model settings and credential references while renaming", async () => {
    const submit = vi.fn();
    render(
      <DshProviderForm
        appId="dsh"
        providerId="existing"
        initialData={{ name: "Existing", settingsConfig: native }}
        onSubmit={submit}
        onCancel={() => {}}
        submitLabel="Save"
      />,
    );
    fireEvent.change(screen.getByLabelText("provider.name"), {
      target: { value: "Renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(JSON.parse(submit.mock.calls[0][0].settingsConfig)).toEqual({
      ...native,
      displayName: "Renamed",
    });
    expect(submit.mock.calls[0][0].providerKey).toBe("existing");
    expect(screen.getByLabelText("dsh.providerId")).toBeDisabled();
  });
  it("sends an explicitly entered key and keeps rejected saves open", async () => {
    const submit = vi
      .fn()
      .mockRejectedValue(new Error("DSH configuration is busy"));
    render(
      <DshProviderForm
        appId="dsh"
        providerId="existing"
        initialData={{ name: "Existing", settingsConfig: native }}
        onSubmit={submit}
        onCancel={() => {}}
        submitLabel="Save"
      />,
    );
    fireEvent.change(screen.getByLabelText("provider.apiKey"), {
      target: { value: "test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "DSH configuration is busy",
    );
    expect(JSON.parse(submit.mock.calls[0][0].settingsConfig).apiKey).toBe(
      "test-key",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByLabelText("provider.apiKey")).toHaveAttribute(
      "type",
      "password",
    );
  });
  it("blocks reserved IDs and malformed JSON", () => {
    render(
      <DshProviderForm
        appId="dsh"
        onSubmit={vi.fn()}
        onCancel={() => {}}
        submitLabel="Save"
      />,
    );
    fireEvent.change(screen.getByLabelText("provider.name"), {
      target: { value: "Test" },
    });
    fireEvent.change(screen.getByLabelText("dsh.providerId"), {
      target: { value: "deepseek" },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("dsh.providerId"), {
      target: { value: "gateway" },
    });
    fireEvent.change(screen.getByLabelText("provider.configJson"), {
      target: { value: "{" },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
