const REQUEST_TIMEOUT_MS = Number(process.env.IMAGE_FETCH_TIMEOUT_MS || 20_000);
const STRICT_IMAGE_MODE = String(process.env.STRICT_IMAGE_MODE || "false").toLowerCase() === "true";
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 10 * 1024 * 1024);

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
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "router2-image-fetch/1.0",
        accept: "image/*,*/*;q=0.8"
      }
    });
    if (!response.ok) {
      throw new Error(`Image fetch failed with status ${response.status}`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `Image fetch failed: content-length ${contentLength} exceeds limit ${MAX_IMAGE_BYTES}`
      );
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

function parseDataUrlImage(url) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(url);
  if (!match) {
    return null;
  }

  const [, mimeType, data] = match;
  return {
    inlineData: {
      mimeType,
      data: data.trim()
    }
  };
}

async function imageUrlToInlineData(url) {
  const dataUrlImage = parseDataUrlImage(url);
  if (dataUrlImage) {
    return dataUrlImage;
  }

  const response = await fetchWithTimeout(url);
  const mimeType = detectMimeType(url, response.headers.get("content-type"));
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image fetch failed: payload ${bytes.byteLength} bytes exceeds limit ${MAX_IMAGE_BYTES}`
    );
  }

  return {
    inlineData: {
      mimeType,
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
          const reason = error instanceof Error ? error.message : "unknown image error";
          throw new Error(
            `Invalid request: image fetch failed. Cannot process vision request (${reason})`
          );
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

function validateOpenAIResponse(response) {
  if (!response?.choices || !Array.isArray(response.choices) || response.choices.length === 0) {
    return { valid: false, error: "Missing or empty choices array", code: "EMPTY_CHOICES" };
  }

  const message = response.choices[0]?.message;
  if (!message) {
    return { valid: false, error: "Missing message in first choice", code: "MISSING_MESSAGE" };
  }

  const hasContent = typeof message.content === "string" && message.content.length > 0;
  const hasToolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
  const contentIsNull = message.content === null;

  if (!hasContent && !hasToolCalls) {
    return { valid: false, error: "Response must have either content or tool_calls", code: "EMPTY_RESPONSE" };
  }

  if (hasContent && hasToolCalls) {
    return { valid: false, error: "Response cannot have both content and tool_calls", code: "BOTH_PRESENT" };
  }

  if (hasToolCalls && !contentIsNull) {
    return { valid: false, error: "tool_calls present but content is not null", code: "CONTENT_NOT_NULL" };
  }

  if (hasContent && message.tool_calls !== undefined) {
    return { valid: false, error: "content present but tool_calls field exists", code: "TOOL_CALLS_FIELD_EXISTS" };
  }

  return { valid: true };
}

export function toOpenAIResponse(text) {
  const response = {
    choices: [
      {
        message: {
          role: "assistant",
          content: text || "No response generated"
        }
      }
    ]
  };

  const validation = validateOpenAIResponse(response);
  if (!validation.valid) {
    console.error("[Router2][ERROR][Validation] Invalid text response:", validation.error, "code:", validation.code);
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: "No response generated"
          },
          finish_reason: "error"
        }
      ],
      isError: true
    };
  }

  console.log("[Router2][Validation Result] Text response validated", { valid: true });
  return response;
}

function generateRandomId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function toOpenAIToolCallsResponse(functionCalls) {
  const toolCalls = functionCalls.map((fc) => ({
    id: `call_${generateRandomId()}`,
    type: "function",
    function: {
      name: fc.name,
      arguments: JSON.stringify(fc.args)
    }
  }));

  const response = {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: toolCalls
        },
        finish_reason: "tool_calls"
      }
    ]
  };

  const validation = validateOpenAIResponse(response);
  if (!validation.valid) {
    console.error("[Router2][ERROR][Validation] Invalid tool_calls response:", validation.error, "code:", validation.code);
    return {
      choices: [
        {
          message: {
            role: "assistant",
            content: "Tool call processing error"
          },
          finish_reason: "error"
        }
      ],
      isError: true
    };
  }

  console.log("[Router2][Validation Result] Tool calls response validated", { valid: true, toolCallCount: toolCalls.length });
  return response;
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
