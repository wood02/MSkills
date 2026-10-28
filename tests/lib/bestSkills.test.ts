import i18n from "i18next";
import { describe, expect, it } from "vitest";
import en from "@/i18n/locales/en.json";
import { BEST_SKILLS_RANKINGS, parseBestSkills } from "@/lib/bestSkills";
// First two rows of each ranking, sampled 2026-10-15 from Best Skills by Linkly AI:
// https://github.com/LinklyAI/best-skills (data: https://creativecommons.org/licenses/by/4.0/).
import fixtures from "../fixtures/best-skills.json";

describe("Best Skills CSV", () => {
  it.each(BEST_SKILLS_RANKINGS)(
    "reads the published %s schema and preserves upstream order",
    (board) => {
      const rows = parseBestSkills(fixtures[board], board);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.rank)).toEqual([1, 2]);
      expect(
        rows.every(
          (row) => row.name && row.metric.label && row.metric.value !== "—",
        ),
      ).toBe(true);
    },
  );

  it("leads install boards with the row's own platform count", () => {
    const [first, second] = parseBestSkills(
      fixtures["top-installs"],
      "top-installs",
    );
    expect(first).toMatchObject({
      platform: "skills.sh",
      metric: { label: "安装量", value: "385.5万" },
    });
    expect(second).toMatchObject({
      platform: "skillhub-cn",
      metric: { label: "下载量", value: "381.1万" },
    });
  });

  it("maps a skill to the existing installer without running the CSV command", () => {
    const row = parseBestSkills(fixtures["best-100"], "best-100")[0];
    expect(row.skill).toMatchObject({
      key: "vercel-labs/agent-browser/agent-browser",
      directory: "agent-browser",
      repoOwner: "vercel-labs",
      repoName: "agent-browser",
    });
  });

  it("keeps vendors, repositories and non-GitHub skills out of the skill installer", () => {
    expect(
      parseBestSkills(fixtures["official-vendors"], "official-vendors").every(
        (row) => !row.skill,
      ),
    ).toBe(true);
    const repo = parseBestSkills(fixtures["top-repos"], "top-repos")[0];
    expect(repo.skill).toBeUndefined();
    expect(repo.url).toMatch(/^https:\/\/github.com\//);
    expect(
      parseBestSkills(fixtures["most-active"], "most-active")[0].skill,
    ).toBeUndefined();
  });

  it("keeps same-name skills from different repositories in snapshots without skill_key", () => {
    const rows = parseBestSkills(
      "rank,skill,platform,source_skillssh\n1,agent-browser,skills.sh,vercel-labs/agent-browser\n51,agent-browser,skills.sh,skills-101/superpowers",
      "trending-7d",
    );
    expect(rows.map((row) => row.key)).toEqual([
      "ss:vercel-labs/agent-browser/agent-browser",
      "ss:skills-101/superpowers/agent-browser",
    ]);
    expect(rows.map((row) => row.rank)).toEqual([1, 51]);
  });

  it("reads BOM, CRLF, quoted commas, quotes and newlines", () => {
    const rows = parseBestSkills(
      '\uFEFFrank,skill,description_zh\r\n2,test,"中文, \'内容\' ""引号""\r\n下一行"\r\n1,other,\r\n',
      "best-100",
    );
    expect(rows.map((row) => row.rank)).toEqual([2, 1]);
    expect(rows[0].description).toBe("中文, '内容' \"引号\"\r\n下一行");
    expect(rows[1].description).toBe("");
  });

  it.each([
    "<html>rate limited</html>",
    'rank,skill\n1,"unfinished',
    'rank,skill\n1,"name"invalid',
    "rank,skill\n1,name,extra",
    "rank,skill\n0,name",
    "rank,skill\n1,name\n2,name",
  ])("rejects invalid upstream data", (csv) => {
    expect(() => parseBestSkills(csv, "best-100")).toThrow();
  });

  it.each([
    "javascript:alert(1)",
    "https://github.com.evil.test/a/b",
    "https://user:pass@github.com/a/b",
    "https://evil.test/a",
  ])("does not open an untrusted registry URL: %s", (url) => {
    expect(
      parseBestSkills(`rank,skill,url\n1,name,${url}`, "best-100")[0].url,
    ).toBeUndefined();
  });

  it("does not accept conflicting GitHub coordinates or skill path traversal", () => {
    for (const line of [
      "1,skill,skills.sh,owner/repo,https://github.com/other/repo",
      "1,../skill,skills.sh,owner/repo,https://github.com/owner/repo",
    ]) {
      expect(
        parseBestSkills(
          `rank,skill,platform,source_skillssh,repo_url\n${line}`,
          "best-100",
        )[0].skill,
      ).toBeUndefined();
    }
  });

  it("uses the active language for labels and number formatting", async () => {
    i18n.addResourceBundle("en", "translation", en, true, true);
    await i18n.changeLanguage("en");
    try {
      const [first] = parseBestSkills(fixtures["top-installs"], "top-installs");
      expect(first.metric).toMatchObject({ label: "Installs", value: "3.9M" });
    } finally {
      await i18n.changeLanguage("zh");
    }
  });
});
