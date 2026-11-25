/**
 * Dev only: fill a GreenMail test mailbox with realistic mail via IMAP APPEND.
 *   pnpm --filter @cloud-mail-mcp/worker seed -- --count 3000
 * Defaults target the docker-compose GreenMail (alice@example.test).
 */
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";

const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? def) : def;
};
const COUNT = Number(arg("count", "3000"));
const USER = arg("user", "alice@example.test");
const PASS = arg("pass", "alice-pass-123");

const people = [
  ["Dana Whitfield", "dana@acme-corp.test"],
  ["Raj Patel", "raj.patel@northwind.test"],
  ["Billing", "billing@cloudhost.test"],
  ["Maria García", "maria@garcia-design.test"],
  ["Tom Becker", "tom@beckerlaw.test"],
  ["GitHub", "noreply@github.test"],
  ["Sarah Kim", "sarah.kim@acme-corp.test"],
  ["Stripe", "receipts@stripe.test"],
  ["Lena Novak", "lena@novak-consulting.test"],
  ["Support", "support@shopify-store.test"],
] as const;
const topics = [
  [
    "Invoice #{n} for {month}",
    "Please find attached invoice #{n}. Payment is due within 30 days. Total: ${amt}.",
  ],
  [
    "Q{q} planning meeting",
    "Can we meet Thursday at 2pm to go over the Q{q} roadmap? I'd like to cover budget and hiring.",
  ],
  [
    "Website redesign feedback",
    "I reviewed the new homepage mockups. The hero section looks great but the pricing table needs work.",
  ],
  [
    "Contract renewal - {company}",
    "Our agreement with {company} expires next month. Attached is the redlined renewal for review.",
  ],
  [
    "Your order #{n} has shipped",
    "Good news! Your order #{n} is on its way. Tracking number: 1Z{n}US.",
  ],
  [
    "[repo] Pull request #{n}: fix login redirect",
    "A new pull request was opened: fix login redirect loop when session expires.",
  ],
  ["Payment receipt ${amt}", "We received your payment of ${amt}. Thank you for your business."],
  [
    "Server maintenance window",
    "Scheduled maintenance this Saturday 02:00-04:00 UTC. Expect brief downtime on the API.",
  ],
  ["Lunch next week?", "It's been a while! Are you free for lunch next Tuesday or Wednesday?"],
  [
    "Customer complaint about shipping delay",
    "A customer wrote in upset that order #{n} arrived two weeks late. How should we respond?",
  ],
] as const;
const companies = ["Acme Corp", "Northwind", "Globex", "Initech", "Umbrella"];
const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const pick = <T>(a: readonly T[], i: number) => a[i % a.length] as T;
const fill = (s: string, i: number) =>
  s
    .replaceAll("{n}", String(1000 + i))
    .replaceAll("{q}", String((i % 4) + 1))
    .replaceAll("{month}", pick(months, i))
    .replaceAll("{company}", pick(companies, i))
    .replaceAll("{amt}", (((i * 37) % 5000) + 49).toFixed(2));

const client = new ImapFlow({
  host: "127.0.0.1",
  port: 3143,
  secure: false,
  auth: { user: USER, pass: PASS },
  logger: false,
});
await client.connect();
for (const f of ["Projects", "Projects/Acme", "Sent", "Trash", "Archive"]) {
  await client.mailboxCreate(f).catch(() => {});
}

const now = Date.now();
const span = 2 * 365 * 86_400_000;
let threadRoot: { id: string; subject: string } | null = null;
const started = Date.now();

for (let i = 0; i < COUNT; i++) {
  const [name, email] = pick(people, i * 7 + 3);
  const [subj, body] = pick(topics, i * 3 + 1);
  const date = new Date(now - Math.floor(((COUNT - i) / COUNT) * span) - (i % 13) * 3_600_000);
  const messageId = `<seed-${i}-${USER}>`;
  // Every 5th message replies to the previous root, forming threads of up to 5.
  const isReply = i % 5 !== 0 && threadRoot;
  const subject = isReply ? `Re: ${threadRoot!.subject}` : fill(subj, i);
  const text = `Hi,\n\n${fill(body, i)}\n\nBest,\n${name}`;
  const attach = i % 9 === 0;
  const raw = await new MailComposer({
    messageId,
    date,
    from: { name, address: email },
    to: [{ name: "Alice", address: USER }],
    cc: i % 11 === 0 ? [{ name: "Sarah Kim", address: "sarah.kim@acme-corp.test" }] : undefined,
    subject,
    text,
    html: i % 3 === 0 ? `<p>Hi,</p><p>${fill(body, i)}</p><p>Best,<br>${name}</p>` : undefined,
    inReplyTo: isReply ? threadRoot!.id : undefined,
    references: isReply ? [threadRoot!.id] : undefined,
    attachments: attach
      ? [
          {
            filename: `document-${1000 + i}.pdf`,
            content: Buffer.from(`%PDF-1.4 fake pdf ${i}`),
            contentType: "application/pdf",
          },
        ]
      : undefined,
  })
    .compile()
    .build();
  if (!isReply) threadRoot = { id: messageId, subject };

  const folder =
    i % 40 === 0 ? "Trash" : i % 17 === 0 ? "Projects/Acme" : i % 10 === 0 ? "Archive" : "INBOX";
  const flags = [];
  if (date.getTime() < now - 14 * 86_400_000 || i % 4 === 0) flags.push("\\Seen");
  if (i % 23 === 0) flags.push("\\Flagged");
  await client.append(folder, raw, flags, date);

  // Some sent replies from Alice
  if (i % 12 === 0) {
    const sent = await new MailComposer({
      messageId: `<seed-sent-${i}-${USER}>`,
      date: new Date(date.getTime() + 3_600_000),
      from: { name: "Alice", address: USER },
      to: [{ name, address: email }],
      subject: `Re: ${subject.replace(/^Re: /, "")}`,
      text: "Thanks, I'll take a look and get back to you.\n\nAlice",
      inReplyTo: messageId,
      references: [messageId],
    })
      .compile()
      .build();
    await client.append("Sent", sent, ["\\Seen"], new Date(date.getTime() + 3_600_000));
  }
  if (i % 500 === 499) console.log(`  ${i + 1} / ${COUNT}`);
}
await client.logout();
console.log(
  `seeded ${COUNT} messages into ${USER} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
);
