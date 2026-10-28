import { beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyStorage } from "@/lib/legacyStorage";

describe("legacy preferences", () => {
  beforeEach(() => localStorage.clear());

  it("keeps themes, filters and update dismissals without deleting old values", () => {
    localStorage.setItem("cc-switch-theme", "dark");
    localStorage.setItem("cc-switch.sessionManager.listViewMode", "grouped");
    localStorage.setItem("ccswitch:update:dismissedVersion", "3.20.4");
    localStorage.setItem("unrelated", "kept");
    migrateLegacyStorage(localStorage);
    expect(localStorage.getItem("mskills-theme")).toBe("dark");
    expect(localStorage.getItem("mskills.sessionManager.listViewMode")).toBe(
      "grouped",
    );
    expect(localStorage.getItem("mskills:update:dismissedVersion")).toBe(
      "3.20.4",
    );
    expect(localStorage.getItem("cc-switch-theme")).toBe("dark");
    expect(localStorage.getItem("unrelated")).toBe("kept");
  });

  it("does not replace a new preference, even when it is empty", () => {
    localStorage.setItem("cc-switch-last-app", "codex");
    localStorage.setItem("mskills-last-app", "");
    migrateLegacyStorage(localStorage);
    migrateLegacyStorage(localStorage);
    expect(localStorage.getItem("mskills-last-app")).toBe("");
  });

  it("does not resurrect legacy snippets after they have been consumed or cleared", () => {
    localStorage.setItem(
      "cc-switch:codex-common-config-snippet",
      "old snippet",
    );
    migrateLegacyStorage(localStorage);
    expect(localStorage.getItem("mskills:codex-common-config-snippet")).toBe(
      "old snippet",
    );
    localStorage.removeItem("mskills:codex-common-config-snippet");
    migrateLegacyStorage(localStorage);
    expect(
      localStorage.getItem("mskills:codex-common-config-snippet"),
    ).toBeNull();
  });
});
