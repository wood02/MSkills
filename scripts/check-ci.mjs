import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export function checkCi(results, event) {
  assert.equal(
    results.changes?.result,
    "success",
    "Changed-area detection must succeed",
  );
  for (const name of ["frontend", "backend", "backend-windows-wsl2"]) {
    const area = name === "frontend" ? "frontend" : "backend";
    const required =
      event === "push" || results.changes.outputs[area] === "true";
    const result = results[name]?.result;
    assert(
      result === "success" || (!required && result === "skipped"),
      `${name} must succeed${required ? "" : " or be skipped"}; received ${result}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  checkCi(JSON.parse(process.env.CI_RESULTS), process.env.GITHUB_EVENT_NAME);
  console.log("All required CI checks passed");
}
