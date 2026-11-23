import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtime } from "@mailmcp/core";

/**
 * Build/version info and self-update plumbing.
 *
 * Installs from the public repo run the published Docker image, which has MAILMCP_VERSION,
 * MAILMCP_REVISION and MAILMCP_REPO baked in by the release workflow. Forks publish under their
 * own repo, so each install checks for updates from the repo its image was built from.
 *
 * Updating is done by the small `updater` container (deploy/compose.yml): the server drops a
 * request file into a shared folder; the updater pulls the new image and recreates MailMCP.
 */

const pkgVersion = (() => {
  try {
    return (
      (
        JSON.parse(readFileSync(join(runtime.repoRoot, "package.json"), "utf8")) as {
          version?: string;
        }
      ).version ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
})();

export const build = {
  version: process.env.MAILMCP_VERSION || `${pkgVersion}-dev`,
  revision: process.env.MAILMCP_REVISION || null,
  /** "owner/name" on GitHub. Empty for source checkouts without a published image. */
  repo: (process.env.MAILMCP_REPO || "").toLowerCase(),
  /** Image tag this install follows: "latest" (stable releases) or "edge" (every change on main). */
  channel:
    (process.env.MAILMCP_TAG || "latest") === "edge" ? ("edge" as const) : ("stable" as const),
  controlDir: process.env.MAILMCP_CONTROL_DIR || null,
};

export interface UpdateCheck {
  channel: "stable" | "edge";
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  notes: string | null;
  url: string | null;
  publishedAt: string | null;
  checkedAt: string;
  error?: string;
}

/** Compare dotted versions, ignoring a leading "v" and pre-release suffixes. */
export function newerThan(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, "")
      .split(/[-+]/)[0]!
      .split(".")
      .map((n) => Number(n) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

let cache: { at: number; channel: string; value: UpdateCheck } | null = null;

async function gh<T>(path: string): Promise<T> {
  const r = await fetch(`https://api.github.com/repos/${build.repo}${path}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "MailMCP-update-check" },
    signal: AbortSignal.timeout(10_000),
  });
  if (r.status === 404) throw new Error("No published releases found for this repository yet.");
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return (await r.json()) as T;
}

export async function checkForUpdates(force = false): Promise<UpdateCheck> {
  const now = new Date().toISOString();
  const base: UpdateCheck = {
    channel: build.channel,
    current:
      build.channel === "edge" ? (build.revision?.slice(0, 7) ?? build.version) : build.version,
    latest: null,
    updateAvailable: false,
    notes: null,
    url: null,
    publishedAt: null,
    checkedAt: now,
  };
  if (!build.repo)
    return {
      ...base,
      error: "This copy wasn't installed from a published image, so there is nothing to check.",
    };
  if (!force && cache && cache.channel === build.channel && Date.now() - cache.at < 30 * 60_000)
    return cache.value;
  try {
    let value: UpdateCheck;
    if (build.channel === "stable") {
      const r = await gh<{
        tag_name: string;
        html_url: string;
        body: string | null;
        published_at: string;
      }>("/releases/latest");
      value = {
        ...base,
        latest: r.tag_name.replace(/^v/, ""),
        updateAvailable: newerThan(r.tag_name, build.version),
        notes: r.body,
        url: r.html_url,
        publishedAt: r.published_at,
      };
    } else {
      const r = await gh<{
        sha: string;
        html_url: string;
        commit: { message: string; committer: { date: string } };
      }>("/commits/main");
      value = {
        ...base,
        latest: r.sha.slice(0, 7),
        updateAvailable: !!build.revision && !r.sha.startsWith(build.revision.slice(0, 7)),
        notes: r.commit.message,
        url: r.html_url,
        publishedAt: r.commit.committer.date,
      };
    }
    cache = { at: Date.now(), channel: build.channel, value };
    return value;
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
}

export interface UpdaterState {
  /** A control folder is configured (running under the production compose file). */
  available: boolean;
  /** The updater container has checked in within the last 2 minutes. */
  online: boolean;
  status: {
    id?: string;
    state: "idle" | "pending" | "pulling" | "restarting" | "done" | "failed";
    message?: string;
    at?: string;
  } | null;
}

export async function updaterState(): Promise<UpdaterState> {
  if (!build.controlDir) return { available: false, online: false, status: null };
  const beat = await stat(join(build.controlDir, "updater-heartbeat")).catch(() => null);
  const online = !!beat && Date.now() - beat.mtimeMs < 2 * 60_000;
  const status = await readFile(join(build.controlDir, "update-status.json"), "utf8")
    .then((s) => JSON.parse(s) as UpdaterState["status"])
    .catch(() => null);
  const pending = await stat(join(build.controlDir, "update-request.json")).catch(() => null);
  return {
    available: true,
    online,
    status: pending && status?.state !== "pulling" ? { state: "pending" } : status,
  };
}

/** Ask the updater to pull and restart, optionally switching channel ("latest" | "edge"). */
export async function requestUpdate(by: string, tag?: "latest" | "edge") {
  if (!build.controlDir)
    throw Object.assign(
      new Error("In-app updates need the updater container (see the install guide)."),
      { statusCode: 409 },
    );
  await mkdir(build.controlDir, { recursive: true });
  const id = randomUUID();
  // Written atomically-enough for a single small file; the updater deletes it when it starts.
  await writeFile(
    join(build.controlDir, "update-request.json"),
    JSON.stringify({ id, by, tag: tag ?? null, requestedAt: new Date().toISOString() }),
  );
  return { id };
}
