import { defineModule, MODULE_API_VERSION } from "@mailmcp/module-sdk";
import { imapConfigSchema } from "./config";
import { ImapConnector } from "./connector";
import { presets } from "./presets";

export default defineModule({
  id: "imap",
  name: "IMAP / SMTP",
  version: "0.1.0",
  apiVersion: MODULE_API_VERSION,
  kind: "connector",
  description:
    "Any IMAP/SMTP mailbox: cPanel and hosting mail, Apple iCloud, Gmail (app password), and more.",
  auth: [{ type: "password", help: "Mailbox password or app-specific password." }],
  configSchema: imapConfigSchema,
  presets,
  ui: {
    secretFields: ["password"],
    advancedFields: ["imap", "smtp", "username", "maxConnections", "allowInvalidCerts"],
    usernameField: "username",
    labels: {
      password: "Password (or app-specific password)",
      username: "Login username",
      "imap.host": "IMAP server",
      "imap.port": "IMAP port",
      "imap.secure": "IMAP uses TLS (port 993)",
      "smtp.host": "SMTP server",
      "smtp.port": "SMTP port",
      "smtp.secure": "SMTP uses TLS (port 465; off = STARTTLS on 587)",
      maxConnections: "Max parallel connections",
      allowInvalidCerts: "Allow certificate name mismatch (some cPanel servers)",
    },
  },
  capabilities: {
    folders: true,
    labels: false,
    threads: false, // threads are built by the core from Message-ID / References
    serverSearch: true,
    push: "idle",
    send: true,
    drafts: true,
    deleteModes: ["trash", "permanent"],
  },
  create: (ctx) => new ImapConnector(ctx),
});
