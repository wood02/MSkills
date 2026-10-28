import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkRelease(tag, root = process.cwd()) {
  assert.match(
    tag ?? "",
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
    "Expected a version tag such as v1.0.0 or v1.1.0-beta.1",
  );
  const version = tag.slice(1);
  assert(
    !version
      .slice(version.indexOf("-") + 1)
      .split(".")
      .some((part) => /^0\d+$/.test(part)),
    "Prerelease numbers must not have leading zeroes",
  );
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  const cargo = read("src-tauri/Cargo.toml")
    .split(/^\[package\]\s*$/m)[1]
    ?.split(/^\[/m)[0];
  const locked = read("src-tauri/Cargo.lock")
    .split("[[package]]")
    .find((entry) => /^name = "mskills"$/m.test(entry));
  const versions = {
    "package.json": JSON.parse(read("package.json")).version,
    "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json"))
      .version,
    "src-tauri/Cargo.toml": cargo?.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    "src-tauri/Cargo.lock": locked?.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  };
  for (const [path, actual] of Object.entries(versions)) {
    assert.equal(actual, version, `${path} must match ${tag}`);
  }
  return { version, prerelease: version.includes("-") };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const release = checkRelease(process.argv[2] ?? process.env.GITHUB_REF_NAME);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `prerelease=${release.prerelease}\n`,
    );
  }
  console.log(`Release versions match: ${release.version}`);
}
