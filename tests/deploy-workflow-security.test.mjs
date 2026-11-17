import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy-atk-recovery.yml", import.meta.url),
  "utf8",
);

test("automatic deployment only consumes a successful push to this repository main", () => {
  assert.match(workflow, /github\.event\.workflow_run\.event\s*==\s*'push'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_branch\s*==\s*'main'/);
  assert.match(workflow, /github\.event\.workflow_run\.head_repository\.full_name\s*==\s*github\.repository/);
  assert.match(workflow, /github\.event\.workflow_run\.conclusion\s*==\s*'success'/);
});

test("manual deployment is restricted to main before deployment steps can run", () => {
  assert.match(workflow, /github\.event_name\s*==\s*'workflow_dispatch'\s*&&\s*github\.ref\s*==\s*'refs\/heads\/main'/);
});

test("automatic deployment refuses a stale commit after main has advanced", () => {
  assert.match(workflow, /git ls-remote origin refs\/heads\/main/);
  assert.match(workflow, /EXPECTED_SHA/);
});
