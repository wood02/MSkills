import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Windows timings from run 41766031689; new targets join the lightest shard.
const seconds = {
  provider_service: 70,
  mcp_commands: 37,
  profile_roundtrip: 15,
  provider_commands: 15,
  skill_document: 14,
  skill_sync: 11,
};

export function testArgs(suite, targets) {
  if (suite === "all") return [];
  if (suite === "unit") return ["--lib"];
  if (suite === "integration") {
    return ["--bins", ...targets.flatMap((name) => ["--test", name])];
  }
  assert.match(suite, /^[1-3]\/3$/, "Expected all, unit or 1/3..3/3");
  const shards = Array.from({ length: 3 }, () => ({ names: [], seconds: 0 }));
  for (const name of [...targets].sort(
    (a, b) => (seconds[b] ?? 1) - (seconds[a] ?? 1) || a.localeCompare(b),
  )) {
    const shard = shards.reduce((a, b) => (a.seconds <= b.seconds ? a : b));
    shard.names.push(name);
    shard.seconds += seconds[name] ?? 1;
  }
  const names = shards[Number(suite[0]) - 1].names;
  assert(names.length, "Empty shard would fall back to running every test");
  // Integration tests already build the normal library; keep binary tests there.
  return [
    ...(suite === "3/3" ? ["--bins"] : []),
    ...names.flatMap((name) => ["--test", name]),
  ];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const metadata = JSON.parse(
    execFileSync("cargo", [
      "metadata",
      "--locked",
      "--no-deps",
      "--format-version",
      "1",
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ]),
  );
  const pkg = metadata.packages.find((pkg) => pkg.name === "mskills");
  const targets = pkg.targets
    .filter((t) => t.kind.includes("test"))
    .map((t) => t.name);
  console.log(testArgs(process.argv[2], targets).join(" "));
}
