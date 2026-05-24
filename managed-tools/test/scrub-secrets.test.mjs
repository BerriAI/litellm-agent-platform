/**
 * Unit tests for scrubSecrets() in src/memory.ts.
 *
 * Runs with the Node built-in test runner (no extra deps). The test imports
 * the COMPILED output, so build first:
 *   npm run build && node --test test/scrub-secrets.test.mjs
 * (the `test` script in package.json does both).
 *
 * All tokens below are obviously-fake placeholders — never put a real secret
 * in a test fixture.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scrubSecrets } from "../dist/memory.js";

const REDACTED = "[REDACTED]";

/** Assert the secret is gone and the redaction marker is present. */
function assertRedacted(input, secret) {
  const out = scrubSecrets(input);
  assert.ok(!out.includes(secret), `expected secret to be scrubbed: ${secret}`);
  assert.ok(out.includes(REDACTED), `expected ${REDACTED} marker in: ${out}`);
}

/** Assert the value passes through untouched. */
function assertKept(input) {
  assert.equal(scrubSecrets(input), input);
}

describe("scrubSecrets — redacts secrets", () => {
  it("OpenAI sk- key", () => {
    assertRedacted(
      "use OPENAI_API_KEY sk-FAKEabc123DEF456ghi789JKL012 then go",
      "sk-FAKEabc123DEF456ghi789JKL012",
    );
  });

  it("Anthropic sk-ant- key", () => {
    assertRedacted(
      "key is sk-ant-FAKE0123456789abcdefABCDEF here",
      "sk-ant-FAKE0123456789abcdefABCDEF",
    );
  });

  it("Slack bot/user/app tokens", () => {
    assertRedacted("xoxb-FAKE-1111-2222-aaaabbbbcccc", "xoxb-FAKE-1111-2222-aaaabbbbcccc");
    assertRedacted("xoxp-FAKE-3333-4444-ddddeeeeffff", "xoxp-FAKE-3333-4444-ddddeeeeffff");
    assertRedacted("xapp-1-FAKE-5555-zzzzwwww0000", "xapp-1-FAKE-5555-zzzzwwww0000");
  });

  it("GitHub classic + fine-grained tokens", () => {
    assertRedacted("ghp_FAKE0123456789abcdefABCDEF0123456", "ghp_FAKE0123456789abcdefABCDEF0123456");
    assertRedacted("gho_FAKE0123456789abcdefABCDEF0123456", "gho_FAKE0123456789abcdefABCDEF0123456");
    assertRedacted(
      "github_pat_FAKE11ABCDEFGHIJ_0123456789abcdefghij",
      "github_pat_FAKE11ABCDEFGHIJ_0123456789abcdefghij",
    );
  });

  it("Render rnd_ key", () => {
    assertRedacted("rnd_FAKE0123456789abcdefABCDEFgh", "rnd_FAKE0123456789abcdefABCDEFgh");
  });

  it("E2B e2b_ key", () => {
    assertRedacted("e2b_FAKE0123456789abcdefABCDEF", "e2b_FAKE0123456789abcdefABCDEF");
  });

  it("AWS access key id", () => {
    assertRedacted("AKIAFAKE1234567890AB rest", "AKIAFAKE1234567890AB");
  });

  it("Bearer token", () => {
    assertRedacted(
      "send header Authorization: Bearer FAKE.eyJhbGci.0123456789abcdef",
      "FAKE.eyJhbGci.0123456789abcdef",
    );
  });

  it("PEM private key block", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIFAKEkeymaterial0123456789==\n-----END RSA PRIVATE KEY-----";
    const out = scrubSecrets(`here is a key\n${pem}\ndone`);
    assert.ok(!out.includes("MIIFAKEkeymaterial"), "PEM body must be scrubbed");
    assert.ok(out.includes(REDACTED));
  });

  it("generic assignment: password=", () => {
    const out = scrubSecrets("connect with password=hunter2supersecret now");
    assert.ok(!out.includes("hunter2supersecret"), "password value scrubbed");
    assert.ok(out.includes("password=[REDACTED]"), `kept key name: ${out}`);
  });

  it("generic assignment: api_key=", () => {
    const out = scrubSecrets('config api_key="FAKEvalue1234567890abc"');
    assert.ok(!out.includes("FAKEvalue1234567890abc"));
    assert.ok(/api_key=\[REDACTED\]/.test(out), out);
  });

  it("long high-entropy mixed-case token", () => {
    assertRedacted(
      "the value FAKEaB3xYz9Qw8Er7Ty6Ui5Op4As2Df1Gh is the token",
      "FAKEaB3xYz9Qw8Er7Ty6Ui5Op4As2Df1Gh",
    );
  });
});

describe("scrubSecrets — preserves non-secrets", () => {
  it("keeps UUIDs", () => {
    assertKept("server_id is 550e8400-e29b-41d4-a716-446655440000 ok");
  });

  it("keeps short alphanumeric ids", () => {
    assertKept("the project_id is litellm-sandbox-mpecoia5-asxmn");
  });

  it("keeps ordinary prose", () => {
    assertKept(
      "Always use antd Tag for labels and never introduce tremor imports in modified files.",
    );
  });

  it("keeps short words and numbers", () => {
    assertKept("priority 5, tags ui, antd, pr, security; version 0.1.0");
  });

  it("empty string passes through", () => {
    assert.equal(scrubSecrets(""), "");
  });
});
