import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCi } from "./check-ci.mjs";
import { checkRelease } from "./check-release.mjs";

test("CI gate accepts successful checks and only skips unchanged areas on PRs", () => {
  const results = {
    changes: {
      result: "success",
      outputs: { frontend: "true", backend: "false" },
    },
    frontend: { result: "success" },
    backend: { result: "skipped" },
    "backend-windows-wsl2": { result: "skipped" },
  };
  checkCi(results, "pull_request");
  assert.throws(() => checkCi(results, "push"), /backend must succeed/);
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.throws(
      () => checkCi({ ...results, frontend: { result } }, "pull_request"),
      /frontend must succeed/,
    );
  }
  assert.throws(
    () =>
      checkCi({ ...results, changes: { result: "failure" } }, "pull_request"),
    /detection must succeed/,
  );
  assert.throws(
    () =>
      checkCi({ ...results, backend: { result: "cancelled" } }, "pull_request"),
    /backend must succeed/,
  );
  checkCi(
    Object.fromEntries(
      Object.keys(results).map((key) => [
        key,
        { ...results[key], result: "success" },
      ]),
    ),
    "push",
  );
});

test("release validates every version file and distinguishes stable from prerelease", () => {
  const root = mkdtempSync(join(tmpdir(), "mskills-release-"));
  const write = (path, content) => writeFileSync(join(root, path), content);
  const seed = (version) => {
    write("package.json", JSON.stringify({ version }));
    write("src-tauri/tauri.conf.json", JSON.stringify({ version }));
    write(
      "src-tauri/Cargo.toml",
      `[package]\nname = "mskills"\nversion = "${version}"\n\n[dependencies]\nother = "0.1.0"\n`,
    );
    write(
      "src-tauri/Cargo.lock",
      `version = 4\n\n[[package]]\nname = "other"\nversion = "0.1.0"\n\n[[package]]\nname = "mskills"\nversion = "${version}"\n`,
    );
  };
  try {
    mkdirSync(join(root, "src-tauri"));
    seed("1.0.0");
    assert.deepEqual(checkRelease("v1.0.0", root), {
      version: "1.0.0",
      prerelease: false,
    });
    for (const tag of [
      "",
      "1.0.0",
      "v1",
      "v01.0.0",
      "v1.0.0-",
      "v1.0.0/extra",
    ]) {
      assert.throws(() => checkRelease(tag, root), /Expected a version tag/);
    }
    for (const path of [
      "package.json",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
    ]) {
      seed("1.0.0");
      write(
        path,
        path.endsWith(".json")
          ? '{"version":"1.0.1"}'
          : path.endsWith(".toml")
            ? '[package]\nversion = "1.0.1"\n'
            : '[[package]]\nname = "mskills"\nversion = "1.0.1"\n',
      );
      assert.throws(() => checkRelease("v1.0.0", root), /must match v1.0.0/);
    }
    seed("1.1.0-beta.1");
    assert.equal(checkRelease("v1.1.0-beta.1", root).prerelease, true);
    assert.throws(() => checkRelease("v1.1.0-beta.01", root), /leading zeroes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
