import assert from "node:assert/strict";
import { test } from "node:test";
import { costMicros } from "./ai-usage";

test("cost from list prices, in millionths of a dollar", () => {
  // Haiku 5.5: $0.10 in / $0.50 out per million tokens.
  assert.equal(costMicros("claude-haiku-5-5", { input_tokens: 1_000, output_tokens: 100 }), 150);
  // Over 100K prompt tokens Haiku costs 5x.
  assert.equal(
    costMicros("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 1_000 }),
    200_000 * 0.5 + 1_000 * 2.5,
  );
  // Sonnet 5.5 with caching: reads $0.10, writes 1.25x input.
  assert.equal(
    costMicros("claude-sonnet-5-5", {
      input_tokens: 1_000,
      output_tokens: 1_000,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 2_000,
    }),
    1_000 * 2 + 2_000 * 2.5 + 10_000 * 0.1 + 1_000 * 10,
  );
  assert.equal(costMicros("claude-opus-5-5", { input_tokens: 0, output_tokens: 1_000 }), 20_000);
  assert.equal(costMicros("some-other-model", { input_tokens: 1, output_tokens: 1 }), null);
});
