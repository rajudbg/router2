const REQUEST_TIMEOUT_MS = 10_000;
const STRICT_IMAGE_MODE = String(process.env.STRICT_IMAGE_MODE || "false").toLowerCase() === "true";

function detectMimeType(url, contentTypeHeader) {
  if (contentTypeHeader) {
    return contentTypeHeader.split(";")[0].trim();
  }

  const lowerUrl = url.toLowerCase();
  if (lowerUrl.endsWith(".png")) return "image/png";
  if (lowerUrl.endsWith(".webp")) return "image/webp";
  if (lowerUrl.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

async function fetchWithTimeout(url, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Image fetch failed with status ${response.status}`);
    }
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function imageUrlToInlineData(url) {
  const response = await fetchWithTimeout(url);
  const mimeType = detectMimeType(url, response.headers.get("content-type"));
  const bytes = Buffer.from(await response.arrayBuffer());

  return {
    inline_data: {
      mime_type: mimeType,
      data: bytes.toString("base64")
    }
  };
}

function extractTextAndImageUrls(content) {
  const textSegments = [];
  const imageUrls = [];

  if (typeof content === "string") {
    textSegments.push(content);
    return { textSegments, imageUrls };
  }

  if (Array.isArray(content)) {
    for (const part of content) {
      if (!part || typeof part !== "object") continue;

      if (part.type === "text" && typeof part.text === "string") {
        textSegments.push(part.text);
      }

      if (
        part.type === "image_url" &&
        part.image_url &&
        typeof part.image_url.url === "string"
      ) {
        imageUrls.push(part.image_url.url);
      }
    }
  }

  return { textSegments, imageUrls };
}

export async function toVertexRequest(body) {
  const { messages, model } = body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Invalid request: messages must be a non-empty array");
  }

  const contents = [];

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    const role = message.role === "assistant" ? "model" : "user";
    const { textSegments, imageUrls } = extractTextAndImageUrls(message.content);
    const parts = [];

    if (textSegments.length > 0) {
      parts.push({ text: textSegments.join("\n") });
    }

    for (const url of imageUrls) {
      try {
        const imagePart = await imageUrlToInlineData(url);
        parts.push(imagePart);
      } catch (error) {
        if (STRICT_IMAGE_MODE) {
          throw new Error("Invalid request: image fetch failed. Cannot process vision request");
        }
      }
    }

    if (parts.length > 0) {
      contents.push({ role, parts });
    }
  }

  if (contents.length === 0) {
    throw new Error("Invalid request: no valid message content");
  }

  return {
    model: typeof model === "string" && model.trim() ? model.trim() : undefined,
    contents
  };
}

export function toOpenAIResponse(text) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: text ?? ""
        }
      }
    ]
  };
}

export function toOpenAIImagesRequest(body) {
  const { prompt, model, n } = body ?? {};
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("Invalid request: prompt must be a non-empty string");
  }

  const imageCount = n == null ? 1 : Number(n);
  if (!Number.isInteger(imageCount) || imageCount < 1 || imageCount > 4) {
    throw new Error("Invalid request: n must be an integer between 1 and 4");
  }

  return {
    prompt: prompt.trim(),
    n: imageCount,
    model: typeof model === "string" && model.trim() ? model.trim() : undefined
  };
}

export function toOpenAIImagesResponse(imagesBase64) {
  return {
    created: Math.floor(Date.now() / 1000),
    data: imagesBase64.map((b64) => ({ b64_json: b64 }))
  };
}
