import type { ProviderPreset } from "@cloud-mail-mcp/module-sdk";

export const presets: ProviderPreset[] = [
  {
    id: "icloud",
    name: "Apple iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    defaults: {
      imap: { host: "imap.mail.me.com", port: 993, secure: true },
      smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
    },
    help: "iCloud needs an app-specific password; your normal Apple Account password won't work.",
    steps: [
      {
        text: "Sign in to your Apple Account and open Sign-In and Security → App-Specific Passwords. Two-factor authentication must be on (it is for most Apple Accounts).",
        link: { label: "Open Apple Account", url: "https://account.apple.com/account/manage" },
      },
      {
        text: 'Create a password named "Cloud Mail MCP". Apple shows it once, as xxxx-xxxx-xxxx-xxxx.',
      },
      {
        text: "Paste it into Password below, dashes included. Use your full iCloud address (…@icloud.com) as the email.",
      },
    ],
  },
  {
    id: "gmail",
    name: "Gmail / Google Workspace (app password)",
    domains: ["gmail.com", "googlemail.com"],
    defaults: {
      imap: { host: "imap.gmail.com", port: 993, secure: true },
      smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    },
    help: "Gmail needs an app password; your normal Google password won't work. Gmail limits IMAP downloads to about 2.5 GB a day, so big mailboxes fill in over a few days (newest mail first).",
    steps: [
      {
        text: "Turn on 2-Step Verification for your Google Account, if it isn't already.",
        link: {
          label: "Open 2-Step Verification",
          url: "https://myaccount.google.com/signinoptions/twosv",
        },
      },
      {
        text: 'Create an app password named "Cloud Mail MCP". Google shows a 16-letter password once. On Google Workspace, if the page says app passwords aren\'t available, ask your admin to allow them.',
        link: { label: "Create an app password", url: "https://myaccount.google.com/apppasswords" },
      },
      { text: "Paste it into Password below (spaces are removed for you)." },
    ],
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
