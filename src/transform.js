import { helpers } from "@google-cloud/aiplatform";

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

function convertSchema(obj) {
  if (Array.isArray(obj)) {
    return obj.map(convertSchema);
  }
  if (obj !== null && typeof obj === "object") {
    const newObj = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "type" && typeof v === "string") {
        newObj[k] = v.toUpperCase();
      } else {
        newObj[k] = convertSchema(v);
      }
    }
    return newObj;
  }
  return obj;
}

export async function toVertexRequest(body) {
  const { messages, model, tools } = body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error("Invalid request: messages must be a non-empty array");
  }

  const contents = [];
  let systemInstruction = undefined;

  let vertexTools = undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    const functionDeclarations = tools
      .filter((t) => t.type === "function" && t.function)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description || "",
        parameters: convertSchema(t.function.parameters)
      }));
    if (functionDeclarations.length > 0) {
      vertexTools = [{ functionDeclarations }];
    }
  }

  for (const message of messages) {
    if (!message || typeof message !== "object") continue;

    if (message.role === "system") {
      const { textSegments } = extractTextAndImageUrls(message.content);
      if (textSegments.length > 0) {
        const text = textSegments.join("\n");
        if (!systemInstruction) {
          systemInstruction = { parts: [{ text }] };
        } else {
          systemInstruction.parts[0].text += "\n" + text;
        }
      }
      continue;
    }

    const role = message.role === "assistant" ? "model" : "user";
    const parts = [];

    if (message.role === "tool") {
      let responseObj = {};
      try {
        responseObj = JSON.parse(message.content);
      } catch (e) {
        responseObj = { result: message.content };
      }
      
      parts.push({
        functionResponse: {
          name: message.name || message.tool_call_id || "function",
          response: responseObj
        }
      });
      contents.push({ role: "user", parts });
      continue;
    }

    if (message.tool_calls && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        if (tc.type === "function" && tc.function) {
          let args = {};
          try {
            args = typeof tc.function.arguments === "string" 
              ? JSON.parse(tc.function.arguments) 
              : tc.function.arguments;
          } catch (e) {
            // failed to parse args, leave empty
          }
          parts.push({
            functionCall: {
              name: tc.function.name,
              args
            }
          });
        }
      }
    }

    const { textSegments, imageUrls } = extractTextAndImageUrls(message.content);

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

  if (contents.length === 0 && !systemInstruction) {
    throw new Error("Invalid request: no valid message content");
  }

  return {
    model: typeof model === "string" && model.trim() ? model.trim() : undefined,
    contents,
    systemInstruction,
    tools: vertexTools
  };
}

export function toOpenAIResponse({ text, toolCalls }) {
  const message = {
    role: "assistant",
    content: text ?? ""
  };

  let finishReason = "stop";

  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc, index) => {
      const id = `call_${Date.now()}_${index}_${Math.random().toString(36).substring(2, 7)}`;
      return {
        id,
        type: "function",
        function: {
          name: tc.name,
          arguments: typeof tc.args === "object" ? JSON.stringify(helpers.fromValue(tc.args)) : (tc.args || "{}")
        }
      };
    });
    finishReason = "tool_calls";
    if (message.content === "") {
      message.content = null;
    }
  }

  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason
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
