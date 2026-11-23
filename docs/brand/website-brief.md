# MailMCP — Brand & Website Brief

**For:** Claude Design (brand identity + marketing website)
**Project:** MailMCP, an open-source, self-hosted email server for AI agents
**Repository:** https://github.com/Cloud-Mail-Mcp/mailmcp
**Status:** v0.1, early but working end to end. Free and open source (AGPL-3.0).

---

## 1. What we need from you

1. **Brand identity:** logo (SVG; full lockup, symbol-only and monochrome versions), favicon (32px + SVG), and color and type tokens for light and dark mode.
2. **One-page marketing website:** responsive, with light and dark mode, accessible (WCAG 2.2 AA), fast, no tracking scripts. Sections are listed in §5.
3. **Social / Open Graph image:** 1200 × 630.
4. **A donate section** that sends people to **Stripe-hosted checkout** (§6). The site never handles card details.

Static HTML/CSS (or a single React page) is fine. No backend is required.

---

## 2. The product in one breath

> **MailMCP connects all your mailboxes, keeps a fast, encrypted local index of your mail, and lets AI agents like Claude read, search, organize and send email with exactly the permissions you give them. You run it on your own server.**

**How it works:**

1. **Connect mailboxes.** Any IMAP/SMTP account: cPanel and other hosting mail, Apple iCloud, Gmail (app password). Microsoft 365 and the native Gmail API are next on the roadmap.
2. **MailMCP indexes them.** Headers first and newest first, so a 100,000-message mailbox is searchable in about 3 minutes. Full message bodies download in the background. Everything is stored encrypted.
3. **Give AI agents access.** Each agent (Claude Desktop, Claude Code, or your own app) gets its own key and its own permissions per mailbox: read only, organize, draft, or send. Sends can wait for your approval, and every action is recorded in an audit log.

**Who it's for:**

- **Primary: people with too much email.** Business owners, agency operators and power users juggling 5 to 20+ mailboxes who want an AI assistant to help with their inbox without handing a third party their mail. Typical frustration: "No tool can handle my email volume."
- **Secondary: developers** adding email to their own AI agents or products. They plug MailMCP into their stack over MCP, a REST API, or the TypeScript SDK.
- **Tertiary: self-hosters and privacy-minded teams** who want the data on their own hardware.

**Proof points (measured, safe to quote):**

- Indexes about **600 messages per second**; a 100k-message mailbox is searchable in roughly **3 minutes**.
- New mail arrives in seconds via IMAP IDLE (the server notifies MailMCP when mail lands).
- Mail and saved passwords are **encrypted (AES-256-GCM)** with a key that's never stored in the database.
- **Per-agent, per-mailbox permissions:** read, organize, draft, send, delete, and permanent delete are separate, plus folder allow/deny lists, recipient allow-lists, and rate limits.
- **Human approval for outgoing mail**, and an **audit log of every action**, including blocked attempts.
- **One-line install** with automatic HTTPS, and **one-click updates** from the admin panel.

**Don't claim:** compliance certifications (SOC 2, HIPAA), a hosted/cloud service (not launched; a "coming later" mention is fine), Outlook/Gmail OAuth sign-in (roadmap), or that it "never makes mistakes". Avoid AI hype words ("revolutionary", "magic").

---

## 3. Brand direction

**Personality:** trustworthy, calm, competent, privacy-first, friendly to non-experts but credible to engineers. Closer to _a well-made tool you own_ than _a startup selling AI_.

**Name:** **MailMCP** (one word, capital M-M-C-P). "MCP" is the Model Context Protocol, the open standard AI apps use to connect to tools. The GitHub organization is "Cloud-Mail-Mcp"; the product name is MailMCP.

**Logo ideas to explore** (your call):

- An envelope whose flap forms a connector or plug: mail meeting AI tools.
- An "M" monogram built from an envelope outline (the current app uses a simple white "M" on a blue rounded square, so feel free to evolve it).
- A small shield or key detail for the "your mail, your rules" idea, kept subtle.
- It must work at 16px (favicon) and in one color.

**Color:** the admin panel uses **blue `#2563EB`** (Tailwind blue-600) as the accent on zinc neutrals. Keep the site close to that so product and website feel like one thing, or propose a refined palette and we'll update the app to match. Supply light and dark values, with AA contrast for text and UI.

**Type:** the app uses the system UI stack. For the site, a clean sans (Inter, Geist or similar from Google Fonts) and a mono face for commands.

**Imagery:** real product screenshots (see §7) and simple diagrams. No stock photos of people at laptops, and no glowing robot brains.

**Voice:** plain, specific, short sentences. Say what it does and how. Example: _"Give Claude your inbox — with a leash."_ Lead with the user's problem (too much mail, nervous about AI access), then the mechanism.

---

## 4. Messaging

**Headline options** (pick or improve):

- "Your email, ready for AI. On your server."
- "Give Claude your inbox, with permissions you control."
- "Self-hosted email for AI agents."

**Subheadline:** "MailMCP connects all your mailboxes, indexes them fast, and lets AI agents read, search, organize and send email with exactly the access you allow. Open source. Runs on your own server."

**Primary CTA:** "Install on your server" (scrolls to the install section).
**Secondary CTA:** "View on GitHub" → https://github.com/Cloud-Mail-Mcp/mailmcp

---

## 5. Website: sections and content

Single page; the nav anchors are the section names.

1. **Header:** logo, nav (Features · Security · Install · Docs · Donate), GitHub link with a star icon.
2. **Hero:** headline, subheadline, two CTAs, product screenshot (mail view) in a browser frame. A small line underneath: "Free & open source · AGPL-3.0 · v0.1".
3. **The problem (3 short cards):**
   - "Too many mailboxes, too much mail": tools stall on volume.
   - "AI with full inbox access is scary": all-or-nothing access to your email.
   - "Your mail on someone else's servers": hosted tools copy your data.
4. **How it works (3 steps with icons):** Connect mailboxes → MailMCP indexes them → Agents work within your rules. Use the step text from §2.
5. **Features grid (6 to 8 items):**
   - **Every mailbox in one place:** IMAP/SMTP today: cPanel, iCloud, Gmail. Microsoft 365 and the Gmail API next.
   - **Fast local search:** search across all accounts with `from:`, `subject:`, `has:attachment`, `is:unread`; sort by date, sender or subject.
   - **Permissions per agent, per mailbox:** read, organize, draft, send and delete are separate switches.
   - **Approve before it sends:** outgoing mail can wait for a person to approve it.
   - **Audit log:** every action by people and agents, including blocked attempts.
   - **Encrypted storage:** on your disk or any S3-compatible service.
   - **Works with Claude and any MCP client:** one endpoint and a copy-paste setup.
   - **Admin panel:** setup wizard, mail viewer, agents, approvals, settings, one-click updates.
6. **Security & privacy:** a short, sober list:
   - Self-hosted: your mail stays on your server.
   - Mail and passwords are encrypted (AES-256-GCM); the key is never stored in the database.
   - Agents see only what they're granted; default is no access.
   - Email content is marked to agents as untrusted (a defense against prompt injection).
   - Remote images are blocked in the viewer to prevent tracking.
   - The only outbound call MailMCP makes on its own is an optional update check to GitHub.
7. **For developers:** an MCP tool list (`list_accounts`, `search_messages`, `get_message`, `get_thread`, `send_email`, `reply`, `forward`, `move_messages`, `delete_messages`, …), Streamable HTTP endpoint, REST API, TypeScript. A small code block:

   ```
   claude mcp add --transport http mailmcp https://mail.example.com/mcp \
     --header "Authorization: Bearer mmcp_…"
   ```
8. **Install:** requirements ("a server with Docker"), then a copyable command block:

   ```
   curl -fsSL https://github.com/Cloud-Mail-Mcp/mailmcp/releases/latest/download/install.sh | sh -s -- --domain mail.example.com
   ```

   Then "Open your domain and follow the setup wizard", plus a screenshot of the wizard (`screenshots/setup-wizard.png`). Link: "Full install guide" → https://github.com/Cloud-Mail-Mcp/mailmcp#install-on-your-server
9. **Roadmap:** Microsoft 365 (OAuth), Gmail API, OAuth sign-in for agents, larger-scale search (OpenSearch), more connector modules. Link: https://github.com/Cloud-Mail-Mcp/mailmcp/blob/main/docs/SPEC.md
10. **Open source & donate:** see §6.
11. **FAQ:**
    - _Is it free?_ Yes. Open source under AGPL-3.0, free to self-host.
    - _Do you see my email?_ No. It runs on your server; we never receive your mail.
    - _Which AI can use it?_ Claude Desktop, Claude Code, and any app that speaks MCP.
    - _Can the AI send email without me?_ Only if you allow it. You can require approval for every send, or block sending entirely.
    - _What do I need?_ A server or computer with Docker. A domain is recommended for HTTPS.
    - _Is there a hosted version?_ Not yet. Self-hosting is the way today.
12. **Footer:** GitHub, Releases, Report an issue, License (AGPL-3.0), Donate. "© MailMCP contributors."

**Links (use exactly):**

| Label               | URL                                                              |
| ------------------- | ---------------------------------------------------------------- |
| GitHub repository   | https://github.com/Cloud-Mail-Mcp/mailmcp                        |
| Releases / download | https://github.com/Cloud-Mail-Mcp/mailmcp/releases               |
| Install guide       | https://github.com/Cloud-Mail-Mcp/mailmcp#install-on-your-server |
| Report an issue     | https://github.com/Cloud-Mail-Mcp/mailmcp/issues                 |
| Roadmap / spec      | https://github.com/Cloud-Mail-Mcp/mailmcp/blob/main/docs/SPEC.md |
| License             | https://github.com/Cloud-Mail-Mcp/mailmcp/blob/main/LICENSE      |

---

## 6. Donate section (Stripe)

**Goal:** let people support the project with a one-time or monthly donation, with all payment handled on **Stripe-hosted checkout**. The website collects no card or personal data and needs no backend.

**How it connects to Stripe:** each button links to a **Stripe Payment Link** URL (created in Stripe; payment links let the donor choose the amount). Use these placeholders, which we'll replace with the real URLs:

- `{{STRIPE_DONATE_ONCE_URL}}`: one-time donation, donor chooses the amount
- `{{STRIPE_DONATE_MONTHLY_URL}}`: monthly sponsorship

Optionally, if you'd rather embed Stripe's own button, use Stripe's Buy Button snippet (`<script async src="https://js.stripe.com/v3/buy-button.js">` plus `<stripe-buy-button buy-button-id="{{STRIPE_BUY_BUTTON_ID}}" publishable-key="{{STRIPE_PUBLISHABLE_KEY}}">`). Plain links to the Payment Link URLs are the default because they keep the site script-free.

**Design:**

- Heading: "Support MailMCP." Short copy: "MailMCP is free and open source. Donations fund development: new mail providers, security reviews, and hosting for the project."
- A **One-time / Monthly** toggle, and suggested amounts as visual chips ($5, $10, $25, $50, Custom). All chips lead to the matching Payment Link; the donor confirms the amount on Stripe.
- A primary button: "Donate with Stripe" (or "Become a monthly sponsor").
- Small trust line: "Secure checkout by Stripe. We never see your card details."
- Required fine print: "Donations support an open-source project and are not tax-deductible."
- Secondary non-money ways to help: "Star the repo", "Report a bug", "Contribute" (links above).

---

## 7. Product screenshots

Available now in this folder:

- `screenshots/setup-wizard.png`: the first-run setup wizard (Server step).

To capture with sample data before launch (we'll add them here):

- Mail view: all inboxes, conversation open (hero image)
- Search results with `invoice has:attachment`
- Agent permissions editor
- Approval queue (an agent's email waiting for approval)
- Mail view on a phone, dark mode

Until then, design with placeholders sized for a 16:10 desktop browser frame plus one phone frame.

---

## 8. Constraints checklist

- [ ] Works at 360px width without horizontal scrolling; light and dark mode
- [ ] Text contrast AA; visible focus states; buttons are real buttons and links real links
- [ ] No analytics or trackers; fonts self-hosted or from Google Fonts only
- [ ] Every external link listed in §5 is present and exact
- [ ] Donate buttons go only to the Stripe placeholders; no payment form on the page
- [ ] Copy makes no claims outside §2 "Proof points"
