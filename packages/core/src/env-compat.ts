/**
 * Settings were named MAILMCP_* before the product became Cloud Mail MCP. Installs configured
 * with the old names keep working: each one fills in its CLOUD_MAIL_MCP_* counterpart when that
 * isn't set. Imported first, before anything reads the environment.
 */
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("MAILMCP_") || value === undefined) continue;
  const name = `CLOUD_MAIL_MCP_${key.slice("MAILMCP_".length)}`;
  if (process.env[name] === undefined) process.env[name] = value;
}
