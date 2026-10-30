import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkCi } from "./check-ci.mjs";
import { checkRelease } from "./check-release.mjs";
import {
  createUpdaterManifest,
  verifyUpdateSignature,
} from "./generate-updater-manifest.mjs";

test("macOS standalone signer receives the environment names required by locked CLI 2.8.x", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  const mac = workflow
    .split("- name: Prepare macOS Assets")[1]
    ?.split("run: |")[0];
  assert(mac, "macOS asset preparation step is required");
  assert.match(
    mac,
    /TAURI_PRIVATE_KEY: \$\{\{ env\.TAURI_SIGNING_PRIVATE_KEY \}\}/,
  );
  assert.match(
    mac,
    /TAURI_PRIVATE_KEY_PASSWORD: \$\{\{ env\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/,
  );
});

test("CI gate accepts successful checks and only skips unchanged areas on PRs", () => {
  const results = {
    changes: {
      result: "success",
      outputs: { frontend: "true", backend: "false" },
    },
    frontend: { result: "success" },
    backend: { result: "skipped" },
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

test("updater manifest requires all platforms, valid signatures and the embedded public key", () => {
  const root = mkdtempSync(join(tmpdir(), "mskills-updater-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = randomBytes(8);
  const rawKey = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const pubkey = Buffer.from(
    `untrusted comment: test key\n${Buffer.concat([Buffer.from("Ed"), keyId, rawKey]).toString("base64")}\n`,
  ).toString("base64");
  const data = Buffer.from("signed updater fixture");
  const signFixture = (algorithm = "ED") => {
    const message =
      algorithm === "ED"
        ? createHash("blake2b512").update(data).digest()
        : data;
    const signature = sign(null, message, privateKey);
    const trusted = "timestamp:1\tfile:test";
    return Buffer.from(
      `untrusted comment: test\n${Buffer.concat([Buffer.from(algorithm), keyId, signature]).toString("base64")}\ntrusted comment: ${trusted}\n${sign(null, Buffer.concat([signature, Buffer.from(trusted)]), privateKey).toString("base64")}\n`,
    ).toString("base64");
  };
  const signature = signFixture();
  const tag = "v1.0.2";
  const suffixes = [
    "macOS.tar.gz",
    "Windows.msi",
    "Windows-arm64.msi",
    "Linux-x86_64.AppImage",
    "Linux-arm64.AppImage",
  ];
  const options = {
    assetsDir: root,
    tag,
    repository: "wood02/MSkills",
    pubkey,
    notes: '修复说明 "quoted"\n第二行',
    pubDate: "2026-10-30T00:00:00Z",
  };
  const path = join(root, `MSkills-${tag}-macOS.tar.gz`);
  try {
    for (const suffix of suffixes) {
      const asset = join(root, `MSkills-${tag}-${suffix}`);
      writeFileSync(asset, data);
      writeFileSync(`${asset}.sig`, signature);
    }
    const manifest = createUpdaterManifest(options);
    assert.equal(manifest.version, "1.0.2");
    assert.equal(JSON.parse(JSON.stringify(manifest)).notes, options.notes);
    assert.deepEqual(Object.keys(manifest.platforms).sort(), [
      "darwin-aarch64",
      "linux-aarch64",
      "linux-x86_64",
      "windows-aarch64",
      "windows-x86_64",
    ]);
    assert.equal(
      manifest.platforms["windows-aarch64"].url,
      `https://github.com/wood02/MSkills/releases/download/${tag}/MSkills-${tag}-Windows-arm64.msi`,
    );
    verifyUpdateSignature(data, signFixture("Ed"), pubkey);
    assert.throws(
      () => verifyUpdateSignature(Buffer.from("tampered"), signature, pubkey),
      /artifact signature/,
    );
    const changedComment = Buffer.from(
      Buffer.from(signature, "base64")
        .toString()
        .replace("timestamp:1", "timestamp:2"),
    ).toString("base64");
    assert.throws(
      () => verifyUpdateSignature(data, changedComment, pubkey),
      /trusted comment signature/,
    );
    const foreignKey = Buffer.from(
      `untrusted comment: other\n${Buffer.concat([Buffer.from("Ed"), randomBytes(8), rawKey]).toString("base64")}\n`,
    ).toString("base64");
    assert.throws(
      () => createUpdaterManifest({ ...options, pubkey: foreignKey }),
      /key mismatch/,
    );
    writeFileSync(path, "changed artifact");
    assert.throws(() => createUpdaterManifest(options), /artifact signature/);
    writeFileSync(path, "");
    assert.throws(
      () => createUpdaterManifest(options),
      /Empty updater artifact/,
    );
    writeFileSync(path, data);
    rmSync(`${path}.sig`);
    assert.throws(() => createUpdaterManifest(options), /ENOENT/);
    writeFileSync(`${path}.sig`, "invalid signature");
    assert.throws(() => createUpdaterManifest(options), /Invalid Base64/);
    writeFileSync(`${path}.sig`, signature);
    rmSync(join(root, `MSkills-${tag}-Windows-arm64.msi`));
    assert.throws(() => createUpdaterManifest(options), /ENOENT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
