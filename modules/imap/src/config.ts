import { z } from "zod";

export const imapConfigSchema = z.object({
  imap: z.object({
    host: z.string().min(1),
    port: z.number().int().default(993),
    secure: z.boolean().default(true), // implicit TLS (993); false = STARTTLS
  }),
  smtp: z.object({
    host: z.string().min(1),
    port: z.number().int().default(465),
    secure: z.boolean().default(true), // 465 implicit TLS; 587 = false (STARTTLS)
  }),
  username: z.string().min(1),
  password: z.string().min(1), // app password for iCloud / Gmail
  /** Max parallel IMAP connections for this account (providers cap this; iCloud/Gmail ~10-15). */
  maxConnections: z.number().int().min(1).max(10).default(3),
  /**
   * Accept certificates that don't match the host (common on cPanel, where the cert is
   * issued for the server hostname rather than mail.yourdomain.com). Off by default.
   */
  allowInvalidCerts: z.boolean().default(false),
});

export type ImapConfig = z.infer<typeof imapConfigSchema>;
