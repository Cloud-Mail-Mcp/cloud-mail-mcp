import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDatabaseUrl, explainDbError } from "../src/installer";

test("builds a safe connection URL from form fields", () => {
  const url = buildDatabaseUrl({
    host: " db.example.com ",
    port: "6543",
    database: "mail db",
    user: "user@x",
    password: "p@ss:w/rd#1",
  });
  const u = new URL(url);
  assert.equal(u.hostname, "db.example.com");
  assert.equal(u.port, "6543");
  assert.equal(decodeURIComponent(u.pathname.slice(1)), "mail db");
  assert.equal(decodeURIComponent(u.username), "user@x");
  assert.equal(decodeURIComponent(u.password), "p@ss:w/rd#1", "special characters survive");
  assert.equal(u.searchParams.get("sslmode"), null);
  assert.equal(
    new URL(
      buildDatabaseUrl({ host: "h", database: "d", user: "u", ssl: "require" }),
    ).searchParams.get("sslmode"),
    "require",
  );
  assert.equal(
    new URL(buildDatabaseUrl({ host: "h", database: "d", user: "u" })).port,
    "5432",
    "default port",
  );
});

test("accepts a pasted URL and rejects incomplete input", () => {
  assert.equal(
    buildDatabaseUrl({ url: " postgres://a:b@h/d?sslmode=require " }),
    "postgres://a:b@h/d?sslmode=require",
  );
  assert.throws(() => buildDatabaseUrl({ url: "mysql://a@h/d" }), /postgres:\/\//);
  assert.throws(() => buildDatabaseUrl({ host: "h", user: "u" }), /Fill in/);
});

test("explains common connection failures in plain language", () => {
  assert.match(
    explainDbError({ code: "28P01", message: "password authentication failed" }),
    /username or password/,
  );
  assert.match(
    explainDbError({ code: "3D000", message: 'database "x" does not exist' }),
    /doesn't exist/,
  );
  assert.match(explainDbError({ code: "ECONNREFUSED" }), /host and port/);
  assert.match(explainDbError({ code: "ENOTFOUND" }), /host name/);
  assert.match(explainDbError({ message: "no pg_hba.conf entry for host, no encryption" }), /SSL/);
  assert.match(
    explainDbError({ code: "42501", message: "permission denied for schema public" }),
    /create tables/,
  );
});
