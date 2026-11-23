#!/usr/bin/env node
/**
 * Build the self-contained Node.js bundle for shared hosting (Enhance, cPanel, Plesk, any host
 * that can run `node`). Output:
 *
 *   dist/bundle/                 ready-to-run folder (also published to the `dist` branch)
 *     server.mjs                 server + sync worker + all dependencies, one file
 *     admin/                     admin panel
 *     drizzle/                   database migrations
 *     package.json, README.md, LICENSE
 *   dist/mailmcp-node-<version>.zip
 *
 * Usage: node scripts/build-bundle.mjs   (build the admin panel first: pnpm --filter @mailmcp/admin build)
 * Env:   MAILMCP_VERSION, MAILMCP_REVISION, MAILMCP_REPO (set by the release workflow)
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = process.env.MAILMCP_VERSION || `${pkg.version}-local`;
const revision = process.env.MAILMCP_REVISION || "";
const repo = process.env.MAILMCP_REPO || "";
const out = join(root, "dist", "bundle");
const adminDist = join(root, "apps", "admin", "dist");

if (!existsSync(join(adminDist, "index.html"))) {
  console.error("Build the admin panel first: pnpm --filter @mailmcp/admin build");
  process.exit(1);
}
rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Runs before any bundled module: CommonJS shims, install defaults, and a clear Node version check.
const banner = `
import { createRequire as __mm_cr } from "node:module";
import { fileURLToPath as __mm_fu } from "node:url";
import { dirname as __mm_dn } from "node:path";
import * as __mm_zlib from "node:zlib";
const require = __mm_cr(import.meta.url);
const __filename = __mm_fu(import.meta.url);
const __dirname = __mm_dn(__filename);
if (typeof __mm_zlib.zstdCompressSync !== "function") {
  console.error("MailMCP needs Node.js 22.15 or newer (this is " + process.version + "). Choose a newer Node version in your hosting panel.");
  process.exit(1);
}
process.env.MAILMCP_INSTALL ??= "bundle";
process.env.MAILMCP_HOME ??= __dirname;
process.env.NODE_ENV ??= "production";
process.env.MAILMCP_VERSION ??= ${JSON.stringify(version)};
process.env.MAILMCP_REVISION ??= ${JSON.stringify(revision)};
process.env.MAILMCP_REPO ??= ${JSON.stringify(repo)};
`;

const result = await build({
  entryPoints: [join(root, "apps", "server", "src", "index.ts")],
  outfile: join(out, "server.mjs"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  banner: { js: banner },
  // pg's optional native binding is loaded lazily and never used by MailMCP.
  external: ["pg-native"],
  legalComments: "linked",
  logLevel: "warning",
  metafile: true,
});

cpSync(adminDist, join(out, "admin"), { recursive: true });
cpSync(join(root, "packages", "db", "drizzle"), join(out, "drizzle"), { recursive: true });
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));
// CommonJS starter for hosts whose Node integration can't load an ES module directly
// (e.g. Phusion Passenger on cPanel / Plesk). It just loads server.mjs.
writeFileSync(
  join(out, "start.cjs"),
  'import("./server.mjs").catch((err) => {\n  console.error(err);\n  process.exit(1);\n});\n',
);

writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "mailmcp",
      version: version.replace(/^v/, ""),
      private: true,
      description: "MailMCP — self-hosted email server for AI agents (prebuilt Node.js bundle).",
      license: "AGPL-3.0-only",
      type: "module",
      main: "server.mjs",
      scripts: { start: "node server.mjs" },
      engines: { node: ">=22.15" },
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(out, "README.md"),
  `# MailMCP ${version} — Node.js bundle

Ready to run on any host with **Node.js 22.15+** and a **PostgreSQL 13+** database.
No \`npm install\` or build step is needed.

1. Put this folder on the server (or deploy the \`dist\` branch of the repository).
2. Start it with \`node server.mjs\` (or \`npm start\`). It listens on port 8787 (set \`PORT\` to change it).
3. Open the site. The first screen asks for your PostgreSQL connection and a setup code
   (in \`~/mailmcp-data/setup-code.txt\` or the app log), then the setup wizard runs.

Your data, encryption key and saved database connection live in \`~/mailmcp-data\`,
outside this folder, so replacing this folder with a new version keeps everything.
**Back up \`~/mailmcp-data/master.key\`.**

Guides: https://github.com/${repo || "Cloud-Mail-Mcp/mailmcp"}/tree/main/docs/install
`,
);

const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
const zip = join(root, "dist", `mailmcp-node-${version.replace(/^v/, "")}.zip`);
// Zip as a "mailmcp/" folder so extracting in a file manager gives a tidy directory.
cpSync(out, join(root, "dist", "mailmcp"), { recursive: true });
execFileSync("zip", ["-qr", zip, "mailmcp"], { cwd: join(root, "dist") });
rmSync(join(root, "dist", "mailmcp"), { recursive: true, force: true });

console.log(`bundle ${version}: server.mjs ${(bytes / 1024 / 1024).toFixed(1)} MB → ${out}`);
console.log(`zip: ${zip}`);
