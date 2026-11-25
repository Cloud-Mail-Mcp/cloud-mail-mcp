/**
 * In-app chat: the streaming tool loop against a fake Anthropic API (no real API calls or cost).
 * The fake streams one tool call (list_accounts), then a text answer; the test checks that the
 * tool ran through the agent's MCP tools and that the conversation comes back for the next turn.
 * Needs Postgres only.  pnpm --filter @cloud-mail-mcp/server test
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { appSettings, createDb, eq, memberships, orgs, users } from "@cloud-mail-mcp/db";
import { prepareTestDatabase } from "@cloud-mail-mcp/db/testing";
import { type AppDeps, buildApp } from "../src/app";
import { hashPassword } from "../src/auth";
import { config } from "../src/config";

const up = await new Promise<boolean>((res) => {
  const s = connect(5433, "127.0.0.1", () => {
    s.destroy();
    res(true);
  }).on("error", () => res(false));
});
const skip = !up && "Postgres not running";

let base = "";
let cookie = "";
let deps: AppDeps;
let closeAll: () => Promise<void>;
let orgId = "";
let ownerEmail = "";
let fake: Server;
const requests: Array<Record<string, any>> = [];

/** Minimal Messages API streaming: turn 1 calls list_accounts, turn 2 answers in text. */
function startFakeAnthropic(): Promise<string> {
  fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const json = JSON.parse(body);
      requests.push(json);
      const sse = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const msg = {
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: json.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      };
      sse("message_start", { type: "message_start", message: msg });
      const sawToolResult = json.messages.some(
        (m: { content: unknown }) =>
          Array.isArray(m.content) &&
          m.content.some((c: { type: string }) => c.type === "tool_result"),
      );
      if (!sawToolResult) {
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_1", name: "list_accounts", input: {} },
        });
        sse("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{}" },
        });
        sse("content_block_stop", { type: "content_block_stop", index: 0 });
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use", stop_sequence: null },
          usage: { output_tokens: 5 },
        });
      } else {
        sse("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        for (const part of ["You have ", "no mailboxes yet."]) {
          sse("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: part },
          });
        }
        sse("content_block_stop", { type: "content_block_stop", index: 0 });
        sse("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 5 },
        });
      }
      sse("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  return new Promise((res) =>
    fake.listen(0, "127.0.0.1", () => {
      res(`http://127.0.0.1:${(fake.address() as { port: number }).port}`);
    }),
  );
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(j)}`);
  return j as T;
}

before(async () => {
  if (!up) return;
  process.env.ANTHROPIC_BASE_URL = await startFakeAnthropic();
  const testUrl = await prepareTestDatabase(config.databaseUrl);
  const d = createDb(testUrl);
  const built = await buildApp({
    db: d.db,
    config: { ...config, databaseUrl: testUrl, dataDir: join(tmpdir(), "cloud-mail-mcp-chat-e2e") },
    masterKey: Buffer.alloc(32, 9),
    masterKeyInfo: { source: "env" },
    logger: false,
  });
  deps = built.deps;
  await d.db.delete(appSettings).where(eq(appSettings.key, "assistant"));
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  closeAll = async () => {
    await built.app.close();
    await d.close();
    fake.close();
  };
  const [org] = await d.db
    .insert(orgs)
    .values({ name: `chat-e2e-${randomUUID()}` })
    .returning();
  orgId = org!.id;
  ownerEmail = `owner-${randomUUID().slice(0, 8)}@example.test`;
  const [u] = await d.db
    .insert(users)
    .values({ email: ownerEmail, passwordHash: await hashPassword("e2e-password-123") })
    .returning();
  await d.db.insert(memberships).values({ orgId, userId: u!.id, role: "owner" });
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ownerEmail, password: "e2e-password-123" }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
});

after(async () => {
  if (!up) return;
  try {
    await deps.db.delete(appSettings).where(eq(appSettings.key, "assistant"));
    await deps.db.delete(orgs).where(eq(orgs.id, orgId));
    await deps.db.delete(users).where(eq(users.email, ownerEmail));
  } finally {
    delete process.env.ANTHROPIC_BASE_URL;
    await closeAll();
  }
});

test("chat: off until a key is saved; then streams tool calls and the answer", {
  skip,
}, async () => {
  const { agent } = await api("POST", "/agents", { name: "Chat agent" });
  assert.equal((await api("GET", "/chat/status")).configured, false);
  const off = await fetch(`${base}/api/v1/chat`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId: agent.id, text: "hi" }),
  });
  assert.equal(off.status, 400);

  await api("PUT", "/settings/assistant", { apiKey: "sk-ant-test", model: "claude-opus-5-5" });
  const pub = await api("GET", "/settings/assistant");
  assert.equal(pub.value.apiKey, undefined, "the key never goes back to the browser");
  assert.equal(pub.secretsSet.apiKey, true);
  assert.equal((await api("GET", "/chat/status")).configured, true);

  const r = await fetch(`${base}/api/v1/chat`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ agentId: agent.id, text: "Which mailboxes do I have?" }),
  });
  assert.equal(r.status, 200);
  const events = (await r.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const types = events.map((e) => e.type);
  assert.deepEqual(
    types.filter((t) => t !== "text"),
    ["tool", "tool_result", "done"],
    JSON.stringify(events),
  );
  assert.equal(events.find((e) => e.type === "tool_result").isError, false);
  const text = events
    .filter((e) => e.type === "text")
    .map((e) => e.delta)
    .join("");
  assert.equal(text, "You have no mailboxes yet.");

  // What Claude was sent: the agent's tools, the key, a tool_result built from the MCP output.
  assert.equal(requests.length, 2);
  assert.ok(requests[0]!.tools.some((t: { name: string }) => t.name === "list_accounts"));
  assert.equal(requests[0]!.model, "claude-opus-5-5");
  const toolResult = requests[1]!.messages.at(-1).content[0];
  assert.equal(toolResult.type, "tool_result");
  assert.match(toolResult.content, /accounts/);

  // The conversation returned for the next turn: user, assistant(tool_use), user(result), assistant(text).
  const history = events.at(-1).history;
  assert.deepEqual(
    history.map((m: { role: string }) => m.role),
    ["user", "assistant", "user", "assistant"],
  );
});
