import { spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

test("published facility records meet the review and provenance requirements", () => {
  const result = spawnSync(process.execPath, ["scripts/validate-data.mjs"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Validated 15 verified facility records/);
});
