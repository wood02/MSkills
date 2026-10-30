import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkRelease } from "./check-release.mjs";

// Tauri wraps Minisign public keys/signatures in Base64. Verify both the payload
// and trusted comment with Node's Ed25519 implementation before publishing.
export function verifyUpdateSignature(data, signature, pubkey) {
  const decode = (value) => {
    const decoded = Buffer.from(value, "base64");
    assert.equal(decoded.toString("base64"), value, "Invalid Base64");
    return decoded;
  };
  const keyLines = decode(pubkey.trim()).toString("utf8").trim().split(/\r?\n/);
  const lines = decode(signature.trim()).toString("utf8").trim().split(/\r?\n/);
  assert.equal(keyLines.length, 2, "Invalid public key");
  assert.equal(lines.length, 4, "Invalid signature");
  const key = decode(keyLines[1]);
  const signed = decode(lines[1]);
  assert.equal(key.length, 42, "Invalid public key length");
  assert.equal(
    key.subarray(0, 2).toString(),
    "Ed",
    "Invalid public key algorithm",
  );
  assert.equal(signed.length, 74, "Invalid signature length");
  assert(
    key.subarray(2, 10).equals(signed.subarray(2, 10)),
    "Signing key mismatch",
  );
  const algorithm = signed.subarray(0, 2).toString();
  assert(["Ed", "ED"].includes(algorithm), "Invalid signature algorithm");
  const publicKey = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      key.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  const message =
    algorithm === "ED" ? createHash("blake2b512").update(data).digest() : data;
  assert(
    verify(null, message, publicKey, signed.subarray(10)),
    "Invalid artifact signature",
  );
  assert(lines[2].startsWith("trusted comment: "), "Missing trusted comment");
  assert(
    verify(
      null,
      Buffer.concat([signed.subarray(10), Buffer.from(lines[2].slice(17))]),
      publicKey,
      decode(lines[3]),
    ),
    "Invalid trusted comment signature",
  );
}

export function createUpdaterManifest({
  assetsDir,
  tag,
  repository,
  pubkey,
  notes,
  pubDate = new Date().toISOString(),
}) {
  assert.match(
    tag,
    /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
    "Invalid release tag",
  );
  assert.match(
    repository,
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "Invalid repository",
  );
  const targets = [
    ["macOS.tar.gz", ["darwin-aarch64"]],
    ["Windows.msi", ["windows-x86_64"]],
    ["Windows-arm64.msi", ["windows-aarch64"]],
    ["Linux-x86_64.AppImage", ["linux-x86_64"]],
    ["Linux-arm64.AppImage", ["linux-aarch64"]],
  ];
  const platforms = {};
  for (const [suffix, keys] of targets) {
    const name = `MSkills-${tag}-${suffix}`;
    const path = resolve(assetsDir, name);
    const data = readFileSync(path);
    assert(data.length > 0, `Empty updater artifact: ${name}`);
    const signature = readFileSync(`${path}.sig`, "utf8").trim();
    try {
      verifyUpdateSignature(data, signature, pubkey);
    } catch (error) {
      throw new Error(`${name}: ${error.message}`, { cause: error });
    }
    for (const key of keys) {
      platforms[key] = {
        signature,
        url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
      };
    }
  }
  return {
    version: tag.slice(1),
    notes: notes ?? `MSkills ${tag}`,
    pub_date: pubDate,
    platforms,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [assetsDir, tag, repository] = process.argv.slice(2);
  checkRelease(tag);
  const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  const entry = changelog
    .split(/^## /m)
    .find((section) => section.startsWith(`${tag} - `));
  const notes = entry?.split("\n").slice(1).join("\n").trim();
  const manifest = createUpdaterManifest({
    assetsDir,
    tag,
    repository,
    pubkey: config.plugins.updater.pubkey,
    notes,
  });
  writeFileSync(
    resolve(assetsDir, "latest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `Verified 5 signed updater artifacts; generated ${Object.keys(manifest.platforms).length} platform entries`,
  );
}
