import { randomInt } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { runtime } from "@cloud-mail-mcp/core";
import postgres from "postgres";

/**
 * First-run database installer. Runs only when no database is configured (no DATABASE_URL and
 * no saved config). It serves one page that asks for the PostgreSQL connection, tests it, saves
 * it to <dataDir>/config.env, and then hands over to the real app in the same process.
 *
 * A one-time setup code (written to <dataDir>/setup-code.txt and the log) proves the person
 * filling in the form controls the server, so nobody who stumbles on a fresh install can
 * point it at their own database.
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const makeCode = () =>
  Array.from(
    { length: 8 },
    (_, i) => (i === 4 ? "-" : "") + ALPHABET[randomInt(ALPHABET.length)],
  ).join("");

interface DbInput {
  code?: string;
  url?: string;
  host?: string;
  port?: number | string;
  database?: string;
  user?: string;
  password?: string;
  ssl?: "disable" | "require";
}

export function buildDatabaseUrl(i: DbInput): string {
  if (i.url?.trim()) {
    const u = i.url.trim();
    if (!/^postgres(ql)?:\/\//.test(u))
      throw new Error("The connection URL must start with postgres:// or postgresql://");
    return u;
  }
  if (!i.host || !i.database || !i.user)
    throw new Error("Fill in the host, database name and username.");
  const url = new URL("postgres://placeholder");
  url.hostname = i.host.trim();
  url.port = String(i.port || 5432);
  url.pathname = `/${encodeURIComponent(i.database.trim())}`;
  url.username = encodeURIComponent(i.user.trim());
  url.password = encodeURIComponent(i.password ?? "");
  if (i.ssl === "require") url.searchParams.set("sslmode", "require");
  return url.toString();
}

/** Plain-language explanation of a PostgreSQL connection failure. */
export function explainDbError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const msg = e.message ?? String(err);
  if (e.code === "28P01" || /password authentication failed/i.test(msg))
    return "The database rejected the username or password.";
  if (e.code === "3D000" || /does not exist/i.test(msg))
    return "That database doesn't exist. Create it in your hosting panel first, or check the name.";
  if (e.code === "ECONNREFUSED")
    return "Nothing is accepting connections at that host and port. Check both, and that PostgreSQL is running.";
  if (e.code === "ENOTFOUND" || e.code === "EAI_AGAIN") return "That host name couldn't be found.";
  if (e.code === "CONNECT_TIMEOUT" || e.code === "ETIMEDOUT" || /timeout/i.test(msg))
    return "Timed out connecting. The host may be wrong or blocked by a firewall.";
  if (/no pg_hba\.conf entry|SSL|encryption/i.test(msg))
    return "The server requires an encrypted (SSL) connection, or doesn't allow this login from here. Try turning SSL on.";
  if (e.code === "42501" || /permission denied/i.test(msg))
    return "Connected, but this user isn't allowed to create tables in that database. Give it full rights on the database.";
  return msg;
}

/** Connect, check the version and that we can create tables. Throws a friendly error. */
export async function testDatabase(url: string): Promise<{ version: string }> {
  const sql = postgres(url, { max: 1, connect_timeout: 10, idle_timeout: 1, onnotice: () => {} });
  try {
    const [row] = await sql<{ num: number; ver: string }[]>`
      SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS ver`;
    if (!row || row.num < 130000)
      throw Object.assign(
        new Error(
          `PostgreSQL ${row?.ver ?? "?"} is too old; Cloud Mail MCP needs version 13 or newer.`,
        ),
        { friendly: true },
      );
    await sql`CREATE TABLE IF NOT EXISTS cloud_mail_mcp_install_probe (id int)`;
    await sql`DROP TABLE IF EXISTS cloud_mail_mcp_install_probe`;
    return { version: row.ver };
  } catch (err) {
    if ((err as { friendly?: boolean }).friendly) throw err;
    throw new Error(explainDbError(err));
  } finally {
    await sql.end({ timeout: 2 }).catch(() => {});
  }
}

const readJson = (req: IncomingMessage) =>
  new Promise<DbInput>((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 20_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}") as DbInput);
      } catch {
        reject(new Error("Bad request"));
      }
    });
    req.on("error", reject);
  });

const send = (res: ServerResponse, status: number, body: unknown, type = "application/json") => {
  res.writeHead(status, {
    "content-type": `${type}; charset=utf-8`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

/**
 * Serve the installer until a working database is saved. Resolves with the database URL
 * (also set as process.env.DATABASE_URL) once the listening port has been released.
 */
export async function runInstaller(opts: { host: string; port: number }): Promise<string> {
  await mkdir(runtime.dataDir, { recursive: true });
  const code = makeCode();
  const codeFile = join(runtime.dataDir, "setup-code.txt");
  await writeFile(codeFile, `${code}\n`, { mode: 0o600 });
  console.warn(
    [
      "",
      "  Cloud Mail MCP needs a database. Open this site in your browser to connect one.",
      `  Setup code: ${code}`,
      `  (also saved in ${codeFile})`,
      "",
    ].join("\n"),
  );

  let failures = 0;
  let lockedUntil = 0;

  return new Promise<string>((resolve) => {
    const server = createServer(async (req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (req.method === "GET" && path === "/healthz")
        return send(res, 503, { ok: false, installer: true });
      if (req.method === "POST" && (path === "/install/test" || path === "/install/save")) {
        if (Date.now() < lockedUntil)
          return send(res, 429, { error: "Too many wrong codes. Wait a minute and try again." });
        let input: DbInput;
        try {
          input = await readJson(req);
        } catch {
          return send(res, 400, { error: "Bad request" });
        }
        if ((input.code ?? "").trim().toUpperCase() !== code) {
          if (++failures >= 5) {
            lockedUntil = Date.now() + 60_000;
            failures = 0;
          }
          return send(res, 403, {
            error:
              "That setup code isn't right. Find it in cloud-mail-mcp-data/setup-code.txt or the app log.",
          });
        }
        let url: string;
        try {
          url = buildDatabaseUrl(input);
          const { version } = await testDatabase(url);
          if (path === "/install/test") return send(res, 200, { ok: true, version });
        } catch (err) {
          return send(res, 422, { error: (err as Error).message });
        }
        // Save, then switch to the real app in this same process.
        await writeFile(
          runtime.configFile,
          `# Saved by the Cloud Mail MCP installer. Keep this file private.\nDATABASE_URL=${JSON.stringify(url)}\n`,
          { mode: 0o600 },
        );
        await chmod(runtime.configFile, 0o600);
        await rm(codeFile, { force: true });
        process.env.DATABASE_URL = url;
        send(res, 200, { ok: true });
        server.close(() => resolve(url));
        server.closeAllConnections?.();
        return;
      }
      if (req.method === "GET") return send(res, 200, PAGE, "text/html");
      return send(res, 404, { error: "Not found" });
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      console.error(
        err.code === "EADDRINUSE"
          ? `Port ${opts.port} is already in use. Stop the other program or set PORT to a free port.`
          : `Couldn't start the installer: ${err.message}`,
      );
      process.exit(1);
    });
    server.listen(opts.port, opts.host);
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect a database · Cloud Mail MCP</title>
<style>
:root{color-scheme:light dark;--bg:#fafafa;--card:#fff;--text:#18181b;--muted:#71717a;--border:#d4d4d8;--accent:#2563eb;--err-bg:#fef2f2;--err:#991b1b;--ok-bg:#f0fdf4;--ok:#166534}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--card:#18181b;--text:#f4f4f5;--muted:#a1a1aa;--border:#3f3f46;--err-bg:#450a0a;--err:#fecaca;--ok-bg:#052e16;--ok:#bbf7d0}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px}.logo{display:flex;gap:12px;align-items:center;margin-bottom:24px}
.mark{width:36px;height:36px;border-radius:8px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:700;font-size:18px}
h1{font-size:20px;margin:0}p.sub{margin:2px 0 0;color:var(--muted);font-size:14px}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:20px;margin-top:16px}
label{display:block;font-weight:500;font-size:14px;margin:14px 0 6px}label:first-child{margin-top:0}
input,select{width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);font:inherit}
input:focus,select:focus,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.row{display:grid;grid-template-columns:2fr 1fr;gap:12px}.hint{color:var(--muted);font-size:12.5px;margin-top:4px}
button{font:inherit;font-weight:500;border-radius:6px;padding:8px 14px;cursor:pointer;border:1px solid var(--border);background:var(--card);color:var(--text)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}button:disabled{opacity:.6;cursor:wait}
.actions{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}.msg{border-radius:6px;padding:10px 12px;margin-top:14px;font-size:14px}
.msg.err{background:var(--err-bg);color:var(--err)}.msg.ok{background:var(--ok-bg);color:var(--ok)}
.toggle{background:none;border:0;padding:0;color:var(--accent);text-decoration:underline;cursor:pointer;font-size:13.5px}
code{font-family:ui-monospace,Menlo,monospace;font-size:13px}
</style></head><body><main>
<div class="logo"><div class="mark" aria-hidden="true">M</div><div><h1>Connect a database</h1><p class="sub">Step 1 of setup. Cloud Mail MCP stores its index and settings in PostgreSQL.</p></div></div>
<form class="card" id="f" novalidate>
<label for="code">Setup code</label>
<input id="code" name="code" autocomplete="off" required placeholder="XXXX-XXXX" autocapitalize="characters">
<div class="hint">In your hosting file manager, open <code>cloud-mail-mcp-data/setup-code.txt</code> (or check the app's log).</div>
</form>
<form class="card" id="db" novalidate>
<div id="parts">
<div class="row"><div><label for="host">Host</label><input id="host" name="host" value="localhost" required></div>
<div><label for="port">Port</label><input id="port" name="port" value="5432" inputmode="numeric"></div></div>
<label for="database">Database name</label><input id="database" name="database" required>
<div class="hint">Create an empty PostgreSQL database and user in your hosting panel first.</div>
<label for="user">Username</label><input id="user" name="user" autocomplete="off" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password">
<label for="ssl">Encrypted connection (SSL)</label>
<select id="ssl" name="ssl"><option value="disable">Off (database on this server)</option><option value="require">Required (remote/managed database)</option></select>
</div>
<div id="urlbox" hidden><label for="url">Connection URL</label><input id="url" name="url" placeholder="postgres://user:password@host:5432/database" autocomplete="off">
<div class="hint">From Neon, Supabase, your host, etc. Add <code>?sslmode=require</code> if the provider needs SSL.</div></div>
<p><button type="button" class="toggle" id="mode">Paste a connection URL instead</button></p>
<div id="out" role="status" aria-live="polite"></div>
<div class="actions"><button type="button" id="test">Test connection</button><button type="submit" class="primary" id="save">Save and continue</button></div>
</form>
</main>
<script>
const $=(id)=>document.getElementById(id);let urlMode=false;
$("mode").onclick=()=>{urlMode=!urlMode;$("parts").hidden=urlMode;$("urlbox").hidden=!urlMode;$("mode").textContent=urlMode?"Enter details separately instead":"Paste a connection URL instead";};
function body(){const d=urlMode?{url:$("url").value}:{host:$("host").value,port:$("port").value,database:$("database").value,user:$("user").value,password:$("password").value,ssl:$("ssl").value};d.code=$("code").value;return JSON.stringify(d);}
function show(kind,text){const o=$("out");o.className="msg "+kind;o.textContent=text;}
async function go(path){$("test").disabled=$("save").disabled=true;show("ok","Connecting…");
try{const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:body()});const j=await r.json().catch(()=>({}));
if(!r.ok){show("err",j.error||"Something went wrong.");return false;}
if(path.endsWith("test")){show("ok","Connected to PostgreSQL "+j.version+". Everything looks good.");return true;}
show("ok","Saved. Starting Cloud Mail MCP…");
for(let i=0;i<90;i++){await new Promise(r=>setTimeout(r,1000));try{const h=await fetch("/healthz",{cache:"no-store"});if(h.ok){location.href="/admin/";return true;}}catch(e){}}
show("err","Cloud Mail MCP is taking a while to start. Refresh this page in a minute.");return true;
}catch(e){show("err","Couldn't reach the server.");return false;}finally{$("test").disabled=$("save").disabled=false;}}
$("test").onclick=()=>go("/install/test");$("db").onsubmit=(e)=>{e.preventDefault();go("/install/save");};
</script></body></html>`;
