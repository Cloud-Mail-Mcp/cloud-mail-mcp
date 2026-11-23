import type { ProviderPreset } from "@mailmcp/module-sdk";

export const presets: ProviderPreset[] = [
  {
    id: "icloud",
    name: "Apple iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    defaults: {
      imap: { host: "imap.mail.me.com", port: 993, secure: true },
      smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    },
    help:
      "Use an app-specific password (appleid.apple.com → Sign-In and Security → App-Specific Passwords). " +
      "Username is your full iCloud address.",
  },
  {
    id: "gmail",
    name: "Gmail / Google Workspace (app password)",
    domains: ["gmail.com", "googlemail.com"],
    defaults: {
      imap: { host: "imap.gmail.com", port: 993, secure: true },
      smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    },
    help:
      "Requires 2-Step Verification, then create an app password at myaccount.google.com/apppasswords. " +
      "Note: Gmail limits IMAP downloads to ~2.5 GB/day; MailMCP syncs headers first and backfills bodies within that limit.",
  },
  {
    id: "cpanel",
    name: "cPanel / hosting mailbox",
    domains: [],
    defaults: {
      imap: { host: "mail.{domain}", port: 993, secure: true },
      smtp: { host: "mail.{domain}", port: 465, secure: true },
    },
    help: "Username is the full email address; use the mailbox password from cPanel → Email Accounts.",
  },
];
