import assert from "node:assert/strict";
import { test } from "node:test";
import { defineModule } from "@cloud-mail-mcp/module-sdk";
import { z } from "zod";
import { AccountDraftService } from "./drafts";
import { ModuleRegistry } from "./registry";

// A stand-in for the IMAP module: only its presets matter here.
const registry = new ModuleRegistry([
  defineModule({
    id: "imap",
    name: "IMAP",
    version: "0",
    auth: "password",
    configSchema: z.object({}),
    capabilities: { folders: true, labels: false, threads: false, push: false, send: true },
    presets: [
      {
        id: "gmail",
        name: "Gmail",
        domains: ["gmail.com"],
        defaults: {
          imap: { host: "imap.gmail.com", port: 993, secure: true },
          smtp: { host: "smtp.gmail.com", port: 465, secure: true },
        },
      },
      {
        id: "cpanel",
        name: "cPanel",
        domains: [],
        defaults: {
          imap: { host: "mail.{domain}", port: 993, secure: true },
          smtp: { host: "mail.{domain}", port: 465, secure: true },
        },
      },
    ],
    create: () => {
      throw new Error("not used");
    },
  } as never),
]);
const svc = new AccountDraftService(
  null as never,
  registry,
  null as never,
  null as never,
  null as never,
  null as never,
);

test("Gmail is recognised by its domain", () => {
  const { config, provider } = svc.configFor({ address: "Someone@Gmail.com" });
  assert.equal(provider, "gmail");
  assert.deepEqual(config, {
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    username: "someone@gmail.com",
  });
});

test("other domains get cPanel-style mail.<domain>, with any overrides on top", () => {
  const { config, provider } = svc.configFor({
    address: "sales@shop.example.com",
    imapPort: 143,
    imapSecure: false,
    username: "sales",
  });
  assert.equal(provider, "cpanel");
  assert.deepEqual(config, {
    imap: { host: "mail.shop.example.com", port: 143, secure: false },
    smtp: { host: "mail.shop.example.com", port: 465, secure: true },
    username: "sales",
  });
});

test('"other" uses only the servers given', () => {
  const { config, provider } = svc.configFor({
    address: "me@example.org",
    provider: "other",
    imapHost: "imap.example.net",
  });
  assert.equal(provider, "other");
  assert.deepEqual(config, {
    imap: { host: "imap.example.net" },
    smtp: {},
    username: "me@example.org",
  });
});
