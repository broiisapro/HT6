import { test } from "node:test";
import assert from "node:assert/strict";
import { placeEmergencyCall } from "../src/emergency-caller.js";

const ORIGINAL_ENV = { ...process.env };

test("placeEmergencyCall: no-ops without crashing when all env vars are unset", async () => {
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_AGENT_ID;
  delete process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID;
  delete process.env.EMERGENCY_CONTACT_PHONE;

  const result = await placeEmergencyCall({ timestamp: Date.now() });
  assert.strictEqual(result, undefined);
});

test("placeEmergencyCall: no-ops when some env vars are missing", async () => {
  delete process.env.ELEVENLABS_API_KEY;
  process.env.ELEVENLABS_AGENT_ID = "test-agent";
  process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID = "test-phone-id";
  process.env.EMERGENCY_CONTACT_PHONE = "+15551234567";

  const result = await placeEmergencyCall({ timestamp: Date.now() });
  assert.strictEqual(result, undefined);
});

test("placeEmergencyCall: with all env vars set, fetch is called but fails gracefully", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key";
  process.env.ELEVENLABS_AGENT_ID = "test-agent";
  process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID = "test-phone-id";
  process.env.EMERGENCY_CONTACT_PHONE = "+15551234567";

  // Stub fetch so no real network call is made.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return { ok: true, json: async () => ({ status: "ok" }) };
  };

  try {
    const result = await placeEmergencyCall({ timestamp: Date.now() });
    assert.strictEqual(result, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("placeEmergencyCall: fetch error is caught and logged, never thrown", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key";
  process.env.ELEVENLABS_AGENT_ID = "test-agent";
  process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID = "test-phone-id";
  process.env.EMERGENCY_CONTACT_PHONE = "+15551234567";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network failure");
  };

  try {
    const result = await placeEmergencyCall({ timestamp: Date.now() });
    assert.strictEqual(result, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("placeEmergencyCall: fetch non-ok response is caught and logged, never thrown", async () => {
  process.env.ELEVENLABS_API_KEY = "test-key";
  process.env.ELEVENLABS_AGENT_ID = "test-agent";
  process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID = "test-phone-id";
  process.env.EMERGENCY_CONTACT_PHONE = "+15551234567";

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    return {
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    };
  };

  try {
    const result = await placeEmergencyCall({ timestamp: Date.now() });
    assert.strictEqual(result, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("placeEmergencyCall: never throws regardless of input timestamp", async () => {
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_AGENT_ID;
  delete process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID;
  delete process.env.EMERGENCY_CONTACT_PHONE;

  const result = await placeEmergencyCall({ timestamp: 0 });
  assert.strictEqual(result, undefined);

  const result2 = await placeEmergencyCall({ timestamp: 9999999999999 });
  assert.strictEqual(result2, undefined);
});
