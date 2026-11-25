import { z } from "zod";

/** What happens to a message in the inbox once the sorter gives it this tag. */
export const TAG_ACTIONS = ["none", "mark_read", "archive", "spam", "folder"] as const;
export type TagAction = (typeof TAG_ACTIONS)[number];

export const SorterTagSchema = z
  .object({
    /** Used in search (`tag:social`) and by agents. Lower case letters, digits, - and _. */
    id: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{0,29}$/, "Use lower-case letters, digits, - or _ (up to 30)."),
    name: z.string().trim().min(1).max(40),
    /** Tells the AI what belongs here. */
    description: z.string().trim().max(300).default(""),
    action: z.enum(TAG_ACTIONS).default("none"),
    /** For "folder": where the mail goes, e.g. "Newsletters" (created in each mailbox if missing). */
    folder: z.string().trim().max(200).default(""),
  })
  .refine((t) => t.action !== "folder" || t.folder.length > 0, {
    message: "Name the folder this tag's mail should move to.",
    path: ["folder"],
  });
export type SorterTag = z.infer<typeof SorterTagSchema>;

/** The tags a new install starts with. People can rename, add and remove them in Settings. */
export const DEFAULT_TAGS: SorterTag[] = (
  [
    {
      id: "personal",
      name: "Personal",
      description:
        "Written by a real person to you: friends, family, colleagues, clients and replies to your mail.",
      action: "none",
    },
    {
      id: "solicitation",
      name: "Solicitation",
      description:
        "Unrequested pitches from strangers: cold sales outreach, SEO, web design, marketing or link-building offers, recruiters, 'quick question' and follow-up pitches.",
      action: "none",
    },
    {
      id: "marketing",
      name: "Marketing",
      description: "Promotions, sales, coupons and offers from companies and shops.",
      action: "none",
    },
    {
      id: "newsletter",
      name: "Newsletter",
      description: "Newsletters, digests, blog posts and content updates you subscribed to.",
      action: "none",
    },
    {
      id: "social",
      name: "Social media",
      description:
        "Notifications from social networks: LinkedIn, Facebook, Instagram, X, TikTok, YouTube, Reddit, Nextdoor and similar.",
      action: "none",
    },
    {
      id: "notification",
      name: "Notifications",
      description:
        "Automated messages from apps and services: account activity, system alerts, reminders, shipping updates.",
      action: "none",
    },
    {
      id: "finance",
      name: "Receipts & bills",
      description: "Receipts, orders, invoices, payments, bank and billing messages.",
      action: "none",
    },
    {
      id: "security",
      name: "Security",
      description: "Password resets, sign-in alerts and verification codes.",
      action: "none",
    },
    {
      id: "spam",
      name: "Spam",
      description: "Junk, scams, phishing, fake invoices, impersonation and anything malicious.",
      action: "spam",
    },
  ] as Array<Omit<SorterTag, "folder">>
).map((t) => ({ ...t, folder: "" }));
