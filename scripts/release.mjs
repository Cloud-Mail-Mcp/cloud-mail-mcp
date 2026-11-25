#!/usr/bin/env node
/**
 * Cut a Cloud Mail MCP release. One command updates every install method together:
 *
 *   pnpm release 0.2.0            bump versions, check, commit, tag v0.2.0, push
 *   pnpm release 0.2.0 --dry-run  show what would happen, change nothing
 *
 * Pushing the tag starts .github/workflows/release.yml, which builds the Docker image and the
 * Node.js bundle and then publishes them all at once: image tags (:0.2.0, :0.2, :latest), the
 * `dist` branch (Enhance / git-deploy hosts) and the GitHub release (installer, compose, zip).
 *
 * Before releasing, describe the changes under "## [Unreleased]" in CHANGELOG.md; that section
 * becomes this version's entry and its GitHub release notes.
 *
 * Safety checks: on `main`, nothing uncommitted, in sync with origin, version newer than the
 * last release, and CI green on GitHub for this exact commit (skip with --skip-ci-check).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const skipCi = args.includes("--skip-ci-check");
const version = args.find((a) => !a.startsWith("--"))?.replace(/^v/, "");

const sh = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();
const step = (msg) => console.log(`\n▶ ${msg}`);
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};
const cmp = (a, b) => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

if (!version || !/^\d+\.\d+\.\d+$/.test(version))
  fail("Usage: pnpm release <major.minor.patch> [--dry-run]");
const tag = `v${version}`;

step("Checking the repository");
if (sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main")
  fail("Switch to the main branch first.");
const dirty = sh("git", ["status", "--porcelain", "--untracked-files=no"]);
if (dirty) fail(`Commit or stash these changes first:\n${dirty}`);
sh("git", ["fetch", "--quiet", "--tags", "origin"]);
const [behind, ahead] = sh("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"])
  .split(/\s+/)
  .map(Number);
if (behind) fail(`main is ${behind} commit(s) behind origin/main. Pull first.`);
if (ahead) fail(`main has ${ahead} unpushed commit(s). Push them and let CI pass first.`);
const tags = sh("git", ["tag", "--list", "v*.*.*"])
  .split("\n")
  .filter(Boolean)
  .map((t) => t.slice(1));
const last = tags.sort(cmp).at(-1);
if (tags.includes(version)) fail(`${tag} already exists.`);
if (last && cmp(version, last) <= 0)
  fail(`${version} must be newer than the last release (${last}).`);
console.log(
  `  main is clean and in sync · last release: ${last ? `v${last}` : "none"} → new: ${tag}`,
);

if (!skipCi) {
  step("Checking CI for this commit on GitHub");
  const sha = sh("git", ["rev-parse", "HEAD"]);
  let runs;
  try {
    runs = JSON.parse(
      sh("gh", [
        "run",
        "list",
        "--workflow",
        "CI",
        "--commit",
        sha,
        "--json",
        "status,conclusion,url",
        "--limit",
        "1",
      ]),
    );
  } catch {
    fail(
      "Couldn't ask GitHub about CI (is the gh CLI installed and logged in?). Use --skip-ci-check to skip.",
    );
  }
  const run = runs[0];
  if (!run) fail("No CI run found for this commit yet. Wait for it, or use --skip-ci-check.");
  if (run.status !== "completed") fail(`CI is still running: ${run.url}`);
  if (run.conclusion !== "success") fail(`CI didn't pass (${run.conclusion}): ${run.url}`);
  console.log(`  CI passed: ${run.url}`);
}

step(`Bumping versions to ${version}`);
const today = new Date().toISOString().slice(0, 10);
const edits = [
  {
    file: "package.json",
    apply: (s) => s.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
  },
  {
    // Easypanel requires pinned image versions in its template.
    file: "deploy/panels/easypanel/meta.yaml",
    apply: (s) =>
      s
        .replace(/(default:\s*ghcr\.io\/[^\s:]+:)\S+/, `$1${version}`)
        .replace(
          /changeLog:\n/,
          `changeLog:\n  - date: ${today}\n    description: Cloud Mail MCP ${tag}\n`,
        ),
  },
  {
    // What's new: the Unreleased section becomes this version (and its GitHub release notes).
    file: "CHANGELOG.md",
    apply: (s) => {
      const body = s
        .split("## [Unreleased]")[1]
        ?.split(/\n## \[/)[0]
        ?.trim();
      if (!body) fail("CHANGELOG.md has nothing under ## [Unreleased]. Describe what's new first.");
      const repoUrl = s.match(
        /\[Unreleased\]: (https:\/\/github\.com\/[^/]+\/[^/]+)\/compare\//,
      )?.[1];
      let out = s.replace("## [Unreleased]", `## [Unreleased]\n\n## [${version}] - ${today}`);
      if (repoUrl) {
        out = out.replace(
          /\[Unreleased\]: .*\n/,
          `[Unreleased]: ${repoUrl}/compare/${tag}...HEAD\n[${version}]: ${repoUrl}/releases/tag/${tag}\n`,
        );
      }
      return out;
    },
  },
];
for (const e of edits) {
  const path = join(root, e.file);
  const before = readFileSync(path, "utf8");
  const after = e.apply(before);
  if (after === before) fail(`Nothing to change in ${e.file}; check its format.`);
  console.log(`  ${e.file}`);
  if (!dry) writeFileSync(path, after);
}

step("Running checks (lint, typecheck)");
if (dry) {
  console.log("  (skipped in dry run)");
} else {
  try {
    sh("pnpm", ["exec", "biome", "ci", ".", "--colors=off"]);
    sh("pnpm", ["-s", "typecheck"]);
  } catch (err) {
    sh("git", ["checkout", "--", ...edits.map((e) => e.file)]);
    fail(
      `Checks failed; version bump undone.\n${(err.stdout || "") + (err.stderr || "")}`.slice(
        0,
        4000,
      ),
    );
  }
  console.log("  passed");
}

step(`Committing, tagging ${tag} and pushing`);
if (dry) {
  console.log(
    `  would run: git commit -m "Release ${tag}" · git tag -a ${tag} · git push --atomic origin main ${tag}`,
  );
  console.log("\nDry run complete. Nothing was changed.");
  process.exit(0);
}
sh("git", ["add", ...edits.map((e) => e.file)]);
sh("git", ["commit", "-q", "-m", `Release ${tag}`]);
sh("git", ["tag", "-a", tag, "-m", `Cloud Mail MCP ${tag}`]);
sh("git", ["push", "--atomic", "-q", "origin", "main", tag], { stdio: "inherit" });

const repo = sh("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
console.log(`
✔ ${tag} is on its way. GitHub Actions now builds the Docker image and the Node.js bundle,
  then publishes everything together:
    • Docker:   ghcr.io/${repo.toLowerCase()}:${version} (+ :latest)
    • Enhance:  branch "dist"
    • Release:  https://github.com/${repo}/releases/tag/${tag}  (installer, compose, zip)
  Follow along: https://github.com/${repo}/actions
`);
