import assert from "node:assert/strict";
import { test } from "node:test";
import { redirectAllowed, validRedirectUri } from "./oauth";

test("redirect URIs: https anywhere, http only on loopback, no fragments", () => {
  assert.ok(validRedirectUri("https://claude.ai/api/mcp/auth_callback"));
  assert.ok(validRedirectUri("http://localhost:33418/callback"));
  assert.ok(validRedirectUri("http://127.0.0.1/callback"));
  assert.ok(!validRedirectUri("http://example.com/callback"));
  assert.ok(!validRedirectUri("https://example.com/cb#frag"));
  assert.ok(!validRedirectUri("javascript:alert(1)"));
  assert.ok(!validRedirectUri("not a url"));
});

test("redirect matching: exact, except loopback may change port", () => {
  const reg = [
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "http://localhost/callback",
  ];
  assert.ok(redirectAllowed(reg, "https://chatgpt.com/connector_platform_oauth_redirect"));
  assert.ok(!redirectAllowed(reg, "https://chatgpt.com/connector_platform_oauth_redirect/x"));
  assert.ok(!redirectAllowed(reg, "https://evil.example/connector_platform_oauth_redirect"));
  assert.ok(redirectAllowed(reg, "http://localhost:51234/callback"));
  assert.ok(redirectAllowed(reg, "http://127.0.0.1:51234/callback"));
  assert.ok(!redirectAllowed(reg, "http://localhost:51234/other"));
  assert.ok(!redirectAllowed(["https://a.example/cb"], "http://localhost:1/cb"));
});
