import assert from "node:assert/strict";
import test from "node:test";
import { testArgs } from "./backend-test-args.mjs";

test("Windows shards cover every integration target exactly once, including new targets", () => {
  const targets = [
    "provider_service",
    "mcp_commands",
    "profile_roundtrip",
    "provider_commands",
    "skill_document",
    "skill_sync",
    "new_test_target",
    "support",
  ];
  const assigned = ["1/3", "2/3", "3/3"].flatMap((suite) => {
    const args = testArgs(suite, targets).filter((arg) => arg !== "--bins");
    assert(args.length > 0);
    return args.filter((_, index) => index % 2 === 1);
  });
  assert.deepEqual(assigned.sort(), targets.sort());
  assert.deepEqual(testArgs("unit", targets), ["--lib"]);
  assert.deepEqual(
    testArgs("integration", targets)
      .filter((arg) => !arg.startsWith("--"))
      .sort(),
    targets.sort(),
  );
  assert.equal(
    ["1/3", "2/3", "3/3"]
      .flatMap((suite) => testArgs(suite, targets))
      .filter((arg) => arg === "--bins").length,
    1,
  );
  assert.deepEqual(testArgs("all", targets), []);
  assert.throws(() => testArgs("4/3", targets));
  assert.throws(() => testArgs("1/3", []), /Empty shard/);
});
