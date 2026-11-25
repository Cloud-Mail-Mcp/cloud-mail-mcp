import type { FolderRole, RemoteFolder } from "@cloud-mail-mcp/module-sdk";

/** Fallback role detection for servers without SPECIAL-USE (common on older cPanel). */
const NAME_ROLES: Array<[FolderRole, RegExp, RegExp]> = [
  // role, the usual name (preferred), and other names it goes by
  ["inbox", /^inbox$/i, /^inbox$/i],
  ["sent", /^sent$/i, /^(sent( items| messages| mail)?|gesendet|envoy[ée]s?)$/i],
  ["drafts", /^drafts$/i, /^(drafts?|entw[üu]rfe|brouillons)$/i],
  ["trash", /^trash$/i, /^(trash|deleted( items| messages)?|bin|papierkorb|corbeille)$/i],
  ["spam", /^(spam|junk)$/i, /^(spam|junk( e-?mail)?|bulk mail)$/i],
  ["archive", /^archive$/i, /^archives?$/i],
];

/**
 * Give roles to folders the server didn't mark, by name, for roles nobody has yet. When several
 * folders could be Trash (say "Trash" and "Deleted Messages"), the usual name wins, then the
 * shallowest folder.
 */
export function assignNameRoles(folders: RemoteFolder[]): void {
  const taken = new Set(folders.map((f) => f.role).filter(Boolean));
  const leaf = (f: RemoteFolder) => f.path.split(f.delimiter || "/").at(-1) ?? f.path;
  const depth = (f: RemoteFolder) => f.path.split(f.delimiter || "/").length;
  for (const [role, usual, any] of NAME_ROLES) {
    if (taken.has(role)) continue;
    const candidates = folders
      .filter((f) => !f.role && f.selectable && any.test(leaf(f)))
      .sort(
        (a, b) => Number(usual.test(leaf(b))) - Number(usual.test(leaf(a))) || depth(a) - depth(b),
      );
    const pick = candidates[0];
    if (pick) {
      pick.role = role;
      taken.add(role);
    }
  }
}
