import i18n from "i18next";
import type { DiscoverableSkill } from "@/lib/api/skills";

// Parsed rows are cached per language (see useBestSkillsRanking), so labels are resolved here.
const tr = (
  key: string,
  defaultValue: string,
  options?: Record<string, unknown>,
) => i18n.t(`skills.custom.${key}`, { defaultValue, ...options });

export const BEST_SKILLS_RANKINGS = [
  ["best-100", "综合推荐"],
  ["top-installs", "安装总榜"],
  ["trending-7d", "近七天趋势"],
  ["social-buzz", "社区热议"],
  ["most-active", "活跃更新"],
  ["official-100", "官方技能"],
  ["official-vendors", "官方厂商"],
  ["top-repos", "热门仓库"],
  ["rising-stars", "新秀榜"],
] as const;

export type BestSkillsRanking = (typeof BEST_SKILLS_RANKINGS)[number][0];

export interface BestSkillsRow {
  key: string;
  rank: number;
  name: string;
  description: string;
  metric: BestSkillsMetric;
  platform?: string;
  url?: string;
  skill?: DiscoverableSkill;
}

/** CSV fields can contain commas, doubled quotes, and quoted newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  const pushField = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else field += char;
    } else if (char === '"' && !field && !closed) {
      quoted = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n" || char === "\r") {
      pushField();
      if (row.some(Boolean)) rows.push(row);
      row = [];
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else {
      if (closed || char === '"')
        throw new Error(tr("errors.csvFormat", "榜单 CSV 格式错误"));
      field += char;
    }
  }
  if (quoted) throw new Error(tr("errors.csvQuote", "榜单 CSV 引号未闭合"));
  if (field || row.length || closed) {
    pushField();
    if (row.some(Boolean)) rows.push(row);
  }
  return rows;
}

function safeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      [
        "github.com",
        "skills.sh",
        "www.skills.sh",
        "clawhub.ai",
        "skillhub.cn",
        "api.skillhub.cn",
      ].includes(url.hostname)
    )
      return url.href;
  } catch {
    /* A missing registry link is allowed. */
  }
  return undefined;
}

function githubRepo(value: string): [string, string] | undefined {
  const match = /^([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d_.-]+)$/i.exec(
    value,
  );
  if (!match || [".", ".."].includes(match[2])) return undefined;
  return [match[1], match[2]];
}

function number(value: string | undefined): string {
  return value && Number.isFinite(Number(value))
    ? new Intl.NumberFormat(i18n.language || "zh", {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(Number(value))
    : "—";
}

export type BestSkillsMetricIcon =
  | "award"
  | "download"
  | "trending"
  | "message"
  | "clock"
  | "star"
  | "calendar";

export interface BestSkillsMetric {
  icon: BestSkillsMetricIcon;
  label: string;
  value: string;
  detail?: string;
}

/** Display name for the upstream `platform` column. */
export function bestSkillsPlatformName(platform: string): string {
  return platform === "skillhub-cn"
    ? tr("platform.skillhubCn", "腾讯 SkillHub")
    : platform === "clawhub"
      ? "ClawHub"
      : platform;
}

function metric(
  board: BestSkillsRanking,
  row: Record<string, string>,
): BestSkillsMetric {
  switch (board) {
    case "best-100":
      return {
        icon: "award",
        label: tr("metric.score", "综合分"),
        value: row.wis || "—",
      };
    case "trending-7d":
      return {
        icon: "trending",
        label: tr("metric.weeklyGrowth", "周增长"),
        value: row.growth_pct ? `${row.growth_pct}%` : "—",
      };
    case "social-buzz":
      return {
        icon: "message",
        label: tr("metric.xMentions7d", "X 提及 · 7 天"),
        value: `${number(row.x_mentions_7d)}${row.x_truncated === "true" ? "+" : ""}`,
        detail: `HN ${number(row.hn_hits_7d)} · Bluesky ${number(row.bsky_hits_7d)} · GitHub ${number(row.gh_mentions_7d)}`,
      };
    case "most-active":
      return {
        icon: "clock",
        label: tr("metric.lastUpdate", "最近更新"),
        value: row.last_update || "—",
        detail: tr("metric.versions", "{{value}} 个版本", {
          value: number(row.versions_clawhub),
        }),
      };
    case "official-vendors":
      return {
        icon: "download",
        label: tr("metric.installsOrDownloads", "安装/下载"),
        value: number(row.total_installs_or_downloads),
        detail: tr("metric.skillsCount", "{{value}} 个技能", {
          value: number(row.skills_count),
        }),
      };
    case "top-repos":
      return { icon: "star", label: "Stars", value: number(row.stars) };
    case "rising-stars":
      return {
        icon: "calendar",
        label: tr("metric.firstSeen", "收录"),
        value: row.first_seen_days
          ? tr("metric.days", "{{value}} 天", { value: row.first_seen_days })
          : "—",
      };
    default: {
      const counts = [
        ["skills.sh", "skills.sh", row.installs_skillssh],
        ["clawhub", "ClawHub", row.downloads_clawhub],
        [
          "skillhub-cn",
          tr("platform.tencent", "腾讯"),
          row.downloads_skillhub_cn,
        ],
      ].filter(([, , value]) => value !== undefined && value !== "");
      // The row's own platform leads; other registries become the detail line.
      const primary =
        counts.find(([platform]) => platform === row.platform) ?? counts[0];
      if (!primary)
        return {
          icon: "download",
          label: tr("metric.installsOrDownloads", "安装/下载"),
          value: "—",
        };
      const others = counts.filter((entry) => entry !== primary);
      return {
        icon: "download",
        label:
          primary[0] === "skills.sh"
            ? tr("metric.installs", "安装量")
            : tr("metric.downloads", "下载量"),
        value: number(primary[2]),
        detail: others.length
          ? others
              .map(([, label, value]) => `${label} ${number(value)}`)
              .join(" · ")
          : undefined,
      };
    }
  }
}

export function parseBestSkills(
  text: string,
  board: BestSkillsRanking,
): BestSkillsRow[] {
  const [headers, ...data] = parseCsv(text.replace(/^\uFEFF/, ""));
  const identity =
    board === "top-repos"
      ? "repo"
      : board === "official-vendors"
        ? "vendor"
        : "skill";
  if (
    !headers?.includes("rank") ||
    !headers.includes(identity) ||
    new Set(headers).size !== headers.length
  ) {
    throw new Error(tr("errors.csvFields", "榜单 CSV 缺少必要字段"));
  }
  const keys = new Set<string>();
  return data.map((cells) => {
    if (cells.length !== headers.length)
      throw new Error(tr("errors.csvColumns", "榜单 CSV 列数不一致"));
    const row = Object.fromEntries(
      headers.map((header, i) => [header, cells[i]]),
    );
    const name = row[identity];
    const rank = Number(row.rank);
    // Early snapshots have no skill_key; same-name skills still need their repository identity.
    const key =
      row.skill_key ||
      (row.source_skillssh
        ? `ss:${row.source_skillssh}/${name}`
        : row.slug_clawhub
          ? `ch:${row.slug_clawhub}`
          : `${row.platform || board}:${name}`);
    if (!name || !Number.isSafeInteger(rank) || rank < 1 || keys.has(key))
      throw new Error(tr("errors.rowInvalid", "榜单条目标识或排名无效"));
    keys.add(key);
    const repo = githubRepo(row.source_skillssh || "");
    const url =
      board === "top-repos"
        ? githubRepo(name)
          ? `https://github.com/${name}`
          : undefined
        : board === "official-vendors"
          ? row.platform === "skills.sh" && githubRepo(`${name}/skills`)
            ? `https://skills.sh/${name}`
            : undefined
          : safeUrl(row.url);
    // Only skill-level GitHub coordinates enter the existing installer; CSV commands are never executed.
    const installable =
      identity === "skill" &&
      repo &&
      (!row.repo_url ||
        row.repo_url === `https://github.com/${row.source_skillssh}`) &&
      /^[a-z\d][a-z\d._-]*$/i.test(name) &&
      (row.platform === "skills.sh" ||
        row.skill_key === `ss:${row.source_skillssh}/${name}`);
    return {
      key,
      rank,
      name,
      description:
        row.description_zh ||
        row.description ||
        row.vendor ||
        row.topics?.replace(/\|/g, " · ") ||
        "",
      metric: metric(board, row),
      platform: row.platform || undefined,
      url,
      skill: installable
        ? {
            key: `${row.source_skillssh}/${name}`,
            name,
            description: row.description_zh || row.description || "",
            directory: name,
            repoOwner: repo[0],
            repoName: repo[1],
            repoBranch: "main",
            readmeUrl: `https://github.com/${row.source_skillssh}`,
          }
        : undefined,
    };
  });
}
