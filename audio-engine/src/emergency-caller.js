const ELEVENLABS_API_URL = "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";

function isConfigured() {
  const missing = [];
  if (!process.env.ELEVENLABS_API_KEY) missing.push("ELEVENLABS_API_KEY");
  if (!process.env.ELEVENLABS_AGENT_ID) missing.push("ELEVENLABS_AGENT_ID");
  if (!process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID) missing.push("ELEVENLABS_AGENT_PHONE_NUMBER_ID");
  if (!process.env.EMERGENCY_CONTACT_PHONE) missing.push("EMERGENCY_CONTACT_PHONE");
  if (missing.length > 0) {
    console.warn(
      `[emergency-caller] not configured — set ${missing.join(", ")} in .env`
    );
    return false;
  }
  return true;
}

export async function placeEmergencyCall({ timestamp }) {
  if (!isConfigured()) return;

  try {
    const response = await fetch(ELEVENLABS_API_URL, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent_id: process.env.ELEVENLABS_AGENT_ID,
        agent_phone_number_id: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID,
        to_number: process.env.EMERGENCY_CONTACT_PHONE,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(
        `[emergency-caller] ElevenLabs API returned ${response.status}: ${body}`
      );
      return;
    }

    const data = await response.json();
    console.log("[emergency-caller] call placed successfully:", JSON.stringify(data));
  } catch (err) {
    console.error("[emergency-caller] network error:", err.message);
  }
}
