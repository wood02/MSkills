import { describe, expect, it } from "vitest";
import {
  APP_IDS,
  SKILLS_APP_IDS,
  MCP_APP_IDS,
  DEFAULT_VISIBLE_APPS,
  getAppLabel,
  isAdditiveAppId,
} from "@/config/appConfig";

describe("appConfig provider lifecycle", () => {
  it.each(["opencode", "openclaw", "hermes", "pi", "mcode", "dsh"])(
    "classifies %s as additive",
    (appId) => {
      expect(isAdditiveAppId(appId)).toBe(true);
    },
  );

  it.each(["claude", "claude-desktop", "codex", "gemini", "grokbuild"])(
    "does not classify %s as additive",
    (appId) => {
      expect(isAdditiveAppId(appId)).toBe(false);
    },
  );
});

it("registers dsh for application selection, Skills and MCP", () => {
  expect(APP_IDS).toContain("dsh");
  expect(SKILLS_APP_IDS).toContain("dsh");
  expect(MCP_APP_IDS).toContain("dsh");
  expect(DEFAULT_VISIBLE_APPS.dsh).toBe(true);
  expect(getAppLabel("dsh")).toBe("DeepSeek Harness");
});
