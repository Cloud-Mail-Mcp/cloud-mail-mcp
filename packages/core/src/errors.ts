/** Turn low-level connection/auth errors into messages a person can act on. */
export function friendlyError(err: unknown): { message: string; hint?: string; code?: string } {
  const e = err as {
    code?: string;
    message?: string;
    responseText?: string;
    authenticationFailed?: boolean;
    /** A string from SMTP; IMAP (imapflow) puts the parsed server reply object here. */
    response?: unknown;
    responseCode?: number;
    command?: string;
    /** IMAP: the command the server rejected, with literals masked by imapflow. */
    executedCommand?: string;
    host?: string;
  };
  const raw = [e.message, e.responseText, typeof e.response === "string" ? e.response : undefined]
    .filter(Boolean)
    .join(" — ");
  const code = e.code;

  if (
    e.authenticationFailed ||
    /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|authentication failed/i.test(raw)
  ) {
    return {
      code: "AUTH_FAILED",
      message: "The server rejected the username or password.",
      hint: "iCloud and Gmail need an app-specific password, not your normal password. For cPanel the username is usually the full email address.",
    };
  }
  if (code === "EAUTH") {
    return {
      code: "SMTP_AUTH_FAILED",
      message: "IMAP login worked, but the SMTP (sending) server rejected the login.",
      hint: "Check the SMTP host/port under Advanced. Some hosts need port 587 with TLS off (STARTTLS).",
    };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return {
      code: "HOST_NOT_FOUND",
      message: `Server not found${e.host ? `: ${e.host}` : ""}.`,
      hint: "Check the server name under Advanced.",
    };
  }
  if (code === "ECONNREFUSED") {
    return {
      code: "CONN_REFUSED",
      message: "The server refused the connection.",
      hint: "The port may be wrong or blocked by a firewall.",
    };
  }
  if (code === "ETIMEDOUT" || code === "CONNECT_TIMEOUT" || /timed? ?out/i.test(raw)) {
    return {
      code: "TIMEOUT",
      message: "Timed out connecting to the server.",
      hint: "Check the server name and port, and that this machine can reach it.",
    };
  }
  if (
    code === "ERR_TLS_CERT_ALTNAME_INVALID" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    /certificate/i.test(raw)
  ) {
    return {
      code: "TLS_CERT",
      message: "The server's security certificate didn't match or isn't trusted.",
      hint: "Common on cPanel: use the server's hostname as the IMAP/SMTP host, or enable 'Allow certificate name mismatch' under Advanced.",
    };
  }
  if (/wrong version number|EPROTO|packet length too long/i.test(raw)) {
    return {
      code: "TLS_MISMATCH",
      message: "TLS setting doesn't match the port.",
      hint: "Port 993/465 need TLS on; 143/587 need TLS off (STARTTLS).",
    };
  }
  // Name the IMAP command the server refused (without its tag), so the problem can be traced.
  const cmd = e.executedCommand?.replace(/^\S+\s+/, "").slice(0, 160);
  return {
    code: code ?? "UNKNOWN",
    message: `${raw || "Connection failed."}${cmd ? ` (command: ${cmd})` : ""}`,
  };
}
