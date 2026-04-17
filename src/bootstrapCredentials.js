import fs from "node:fs";

const DEFAULT_KEY_PATH = "/tmp/router2-gcp-key.json";

function writeCredentialsFromBase64() {
  const encoded = process.env.GOOGLE_CREDENTIALS_BASE64;
  if (!encoded) {
    return;
  }

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    JSON.parse(decoded);
    fs.writeFileSync(DEFAULT_KEY_PATH, decoded, { encoding: "utf-8", mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = DEFAULT_KEY_PATH;
    console.log("Credentials loaded from GOOGLE_CREDENTIALS_BASE64");
  } catch (error) {
    console.error("Failed to decode GOOGLE_CREDENTIALS_BASE64", error);
    throw new Error(
      "Invalid GOOGLE_CREDENTIALS_BASE64. Ensure it is valid base64-encoded JSON."
    );
  }
}

export function bootstrapGoogleCredentials() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.log("Using GOOGLE_APPLICATION_CREDENTIALS from environment");
    return;
  }

  writeCredentialsFromBase64();

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn(
      "No Google credentials detected. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CREDENTIALS_BASE64."
    );
  }
}
