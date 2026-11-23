/** Canonical blob key layout (docs/SPEC.md §8a). */
export const blobKeys = {
  raw: (orgId: string, accountId: string, sha256: string) =>
    `${orgId}/${accountId}/raw/${sha256.slice(0, 2)}/${sha256}.eml`,
  body: (orgId: string, accountId: string, messageId: number | string) =>
    `${orgId}/${accountId}/body/${messageId}.json`,
  attachment: (orgId: string, accountId: string, sha256: string) =>
    `${orgId}/${accountId}/att/${sha256.slice(0, 2)}/${sha256}`,
  accountPrefix: (orgId: string, accountId: string) => `${orgId}/${accountId}/`,
};
