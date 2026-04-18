import { helpers, v1 } from "@google-cloud/aiplatform";

const REQUEST_TIMEOUT_MS = 15_000;
const RETRYABLE_ERROR_CODES = new Set([4, 8, 13, 14]);
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const SAFE_FALLBACK_TEXT = "No response generated";
const ERROR_FALLBACK_TEXT = "Model temporarily unavailable, please retry";
const ENABLE_SMART_ROUTING = String(process.env.ENABLE_SMART_ROUTING || "true").toLowerCase() === "true";
const SMART_ROUTING_FALLBACK_DELAY_MS = 500;

const MODEL_FALLBACK_CHAINS = {
  "gemini-3-flash-preview": ["gemini-3-flash-preview", "gemini-3.1-pro-preview"],
  "gemini-3.1-pro-preview": ["gemini-3.1-pro-preview", "gemini-3-flash-preview"]
};

const { PredictionServiceClient } = v1;

function getGcpLocation() {
  const raw = process.env.GOOGLE_CLOUD_LOCATION || process.env.LOCATION;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Vertex Prediction API host. For location "global" this must be
 * aiplatform.googleapis.com — not global-aiplatform.googleapis.com.
 */
function getVertexApiHostname() {
  const raw = process.env.VERTEX_API_ENDPOINT?.trim();
  if (raw) {
    try {
      const withProto = raw.includes("://") ? raw : `https://${raw}`;
      const { hostname } = new URL(withProto);
      if (!hostname) {
        throw new Error("VERTEX_API_ENDPOINT must include a hostname");
      }
      return hostname;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid VERTEX_API_ENDPOINT: ${detail}`);
    }
  }

  const location = getGcpLocation();
  if (!location) {
    throw new Error(
      "Missing GOOGLE_CLOUD_LOCATION or LOCATION environment variable"
    );
  }

  if (location === "global") {
    return "aiplatform.googleapis.com";
  }

  return `${location}-aiplatform.googleapis.com`;
}

export class VertexRequestError extends Error {
  constructor(message, statusCode, providerCode) {
    super(message);
    this.name = "VertexRequestError";
    this.statusCode = statusCode;
    this.providerCode = providerCode;
  }
}

function getModelPath(model) {
  const projectId = process.env.PROJECT_ID;
  const location = getGcpLocation();
  const defaultModel = process.env.GEMINI_FLASH_MODEL || "gemini-2.0-flash-001";

  if (!projectId || !location) {
    throw new Error(
      "Missing PROJECT_ID or GOOGLE_CLOUD_LOCATION/LOCATION environment variables"
    );
  }

  const chosenModel = model || defaultModel;
  return `projects/${projectId}/locations/${location}/publishers/google/models/${chosenModel}`;
}

function createClient() {
  return new PredictionServiceClient({
    apiEndpoint: getVertexApiHostname()
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toVertexRequestError(error) {
  const providerCode = error?.code;
  const statusCode = providerCode === 8 ? 429 : 503;
  const details =
    typeof error?.details === "string" && error.details.trim()
      ? error.details.trim()
      : error instanceof Error
        ? error.message
        : "Vertex request failed";

  return new VertexRequestError(details, statusCode, providerCode);
}

async function withRetry(operation) {
  let lastError;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const code = error?.code;
      const retryable = RETRYABLE_ERROR_CODES.has(code);
      if (!retryable || attempt === MAX_RETRIES) {
        break;
      }

      const jitter = Math.floor(Math.random() * 150);
      const backoff = BASE_BACKOFF_MS * 2 ** attempt + jitter;
      await sleep(backoff);
    }
  }

  throw toVertexRequestError(lastError);
}

function getFinishReason(response) {
  const candidates = response?.candidates ?? [];
  const firstCandidate = candidates[0];
  return firstCandidate?.finishReason || "";
}

function getFinishMessage(response) {
  const candidates = response?.candidates ?? [];
  const firstCandidate = candidates[0];
  return firstCandidate?.finishMessage || "";
}

function isRetryableFinishReason(finishReason) {
  return finishReason === "MALFORMED_FUNCTION_CALL";
}

function isErrorFinishReason(finishReason) {
  const errorReasons = [
    "RECITATION",
    "SAFETY",
    "OTHER"
  ];
  return errorReasons.includes(finishReason);
}

function extractResponseText(response) {
  const candidates = response?.candidates ?? [];
  const firstCandidate = candidates[0];
  const parts = firstCandidate?.content?.parts ?? [];

  let text = "";
  for (const part of parts) {
    if (part.text) {
      text += part.text;
    }
  }

  const finishReason = getFinishReason(response);
  if (isErrorFinishReason(finishReason)) {
    return ERROR_FALLBACK_TEXT;
  }

  return text || SAFE_FALLBACK_TEXT;
}

function logStructured(level, component, message, data) {
  const timestamp = new Date().toISOString();
  const logLine = `[Router2][${timestamp}][${level}][${component}] ${message}${data ? " " + JSON.stringify(data) : ""}`;
  console.log(logLine);
}

function getFallbackChain(model) {
  const normalizedModel = model?.toLowerCase().trim() || "";
  for (const [key, chain] of Object.entries(MODEL_FALLBACK_CHAINS)) {
    if (normalizedModel.includes(key.toLowerCase())) {
      return chain;
    }
  }
  return [model];
}

function isRetryableError(error) {
  const code = error?.code;
  const statusCode = error?.statusCode;

  if (error.name === "AbortError") return true;
  if (code === 4 || code === 8 || code === 13 || code === 14) return true;
  if (statusCode === 503 || statusCode === 429) return true;

  return false;
}


function truncateForLog(obj, maxLength = 1000) {
  const str = JSON.stringify(obj);
  if (str.length <= maxLength) return obj;
  return str.substring(0, maxLength) + "...[truncated]";
}

function extractTextToolCalls(text) {
  if (!text || typeof text !== "string") return null;

  const hasToolCall = text.includes("<tool_call>");
  const hasBotToolCall = text.includes("<bot_tool_call>");
  const hasCallFormat = text.includes("call:") || text.match(/call\s*\{/);

  if (!hasToolCall && !hasBotToolCall && !hasCallFormat) return null;

  const toolCalls = [];
  let format = null;

  // Format 1: <tool_call> or <bot_tool_call> tags
  if (hasToolCall || hasBotToolCall) {
    format = hasToolCall ? "tool_call" : "bot_tool_call";
    const regex = hasToolCall
      ? /<tool_call>([\s\S]*?)<\/tool_call>/g
      : /<bot_tool_call>([\s\S]*?)<\/bot_tool_call>/g;

    let match;
    while ((match = regex.exec(text)) !== null) {
      try {
        const jsonContent = match[1].trim();
        const parsed = JSON.parse(jsonContent);

        if (parsed.name) {
          toolCalls.push({
            name: parsed.name,
            args: parsed.arguments || parsed.args || {}
          });
        } else {
          logStructured("WARN", "ToolCall", "Parsed tool call missing required 'name' field", { parsed: truncateForLog(parsed, 500) });
        }
      } catch (e) {
        logStructured("WARN", "ToolCall", `Failed to parse ${format} JSON`, { error: e?.message, content: match[1]?.substring(0, 200) });
      }
    }
  }

  // Format 2: call:name{args} format (e.g., "call:read{path:\"/app/SKILL.md\"}")
  if (toolCalls.length === 0 && hasCallFormat) {
    const callRegex = /call:(\w+)\s*\{([^}]*)\}/g;
    let match;
    while ((match = callRegex.exec(text)) !== null) {
      try {
        const name = match[1];
        const argsStr = match[2];

        // Parse simple key:value pairs
        const args = {};
        const pairs = argsStr.match(/(\w+):\s*([^,]+)/g);
        if (pairs) {
          for (const pair of pairs) {
            const [key, val] = pair.split(/:\s*/);
            // Remove quotes if present
            args[key] = val.replace(/^["']|["']$/g, "");
          }
        }

        toolCalls.push({ name, args });
        format = "call:name{}";
      } catch (e) {
        logStructured("WARN", "ToolCall", "Failed to parse call:name{} format", { error: e?.message, match: match[0]?.substring(0, 100) });
      }
    }

    // Format 3: call{name, args} or call{name:..., args:...} JSON-like format
    if (toolCalls.length === 0) {
      const callJsonRegex = /call\s*\{(\s*["']?name["']?\s*[:=]\s*["']?([^"'\s,}]+)["']?[^}]*)\}/g;
      let jsonMatch;
      while ((jsonMatch = callJsonRegex.exec(text)) !== null) {
        try {
          const jsonStr = "{" + jsonMatch[1] + "}";
          // Normalize to valid JSON
          const normalized = jsonStr
            .replace(/(\w+):/g, '"$1":')
            .replace(/'/g, '"');
          const parsed = JSON.parse(normalized);

          if (parsed.name) {
            toolCalls.push({
              name: parsed.name,
              args: parsed.arguments || parsed.args || {}
            });
            format = "call{}";
          }
        } catch (e) {
          logStructured("WARN", "ToolCall", "Failed to parse call{} JSON format", { error: e?.message, match: jsonMatch[0]?.substring(0, 100) });
        }
      }
    }
  }

  return toolCalls.length > 0 ? { toolCalls, format } : null;
}

function extractFunctionCalls(response) {
  const candidates = response?.candidates ?? [];
  const firstCandidate = candidates[0];
  const parts = firstCandidate?.content?.parts ?? [];

  const functionCalls = [];
  for (const part of parts) {
    if (part?.functionCall?.name) {
      functionCalls.push({
        name: part.functionCall.name,
        args: part.functionCall.args || {}
      });
    }
  }
  return functionCalls;
}

export async function generateFromVertex(contents) {
  const client = createClient();

  const request = {
    model: getModelPath(),
    contents
  };

  const [response] = await withRetry(() =>
    client.generateContent(request, {
      timeout: REQUEST_TIMEOUT_MS
    })
  );

  return extractResponseText(response);
}

function extractResponseImages(response) {
  const candidates = response?.candidates ?? [];
  const firstCandidate = candidates[0];
  const parts = firstCandidate?.content?.parts ?? [];

  return parts
    .map((part) => part?.inlineData?.data || part?.inline_data?.data)
    .filter((value) => typeof value === "string" && value.length > 0);
}

function isImagenModel(model) {
  if (typeof model !== "string") return false;
  return model.toLowerCase().startsWith("imagen");
}

function isGeminiFamilyModel(model) {
  if (typeof model !== "string") return false;
  const normalized = model.toLowerCase();
  return normalized.includes("flash") || normalized.includes("gemini");
}

export function modelSupportsVisionInput(model) {
  if (!model) {
    return true;
  }

  if (isImagenModel(model)) {
    return false;
  }

  return isGeminiFamilyModel(model);
}

export function modelSupportsImageGeneration(model) {
  return isImagenModel(model) || isGeminiFamilyModel(model);
}

async function attemptSingleRequest(contents, model, attemptNum) {
  const client = createClient();
  const request = {
    model: getModelPath(model),
    contents
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const startTime = Date.now();
  let response;
  let error;

  try {
    [response] = await client.generateContent(request, {
      timeout: REQUEST_TIMEOUT_MS,
      abortSignal: controller.signal
    });
  } catch (err) {
    error = err;
  } finally {
    clearTimeout(timeoutId);
  }

  const latencyMs = Date.now() - startTime;
  logStructured("INFO", "Latency", "Request latency", { model, ms: latencyMs, attempt: attemptNum, success: !error });

  if (error) {
    const isRetryable = isRetryableError(error);
    logStructured("WARN", "Retry", "Request failed", { attempt: attemptNum, model, error: error?.message, code: error?.code, retryable: isRetryable });
    throw { error, isRetryable, model, attempt: attemptNum };
  }

  const finishReason = getFinishReason(response);
  const finishMessage = getFinishMessage(response);

  // Try to parse malformed function call from finishMessage
  if (finishReason === "MALFORMED_FUNCTION_CALL" && finishMessage) {
    const extractedCalls = extractTextToolCalls(finishMessage);
    if (extractedCalls && extractedCalls.toolCalls.length > 0) {
      logStructured("INFO", "ToolCall", `Parsed from MALFORMED_FUNCTION_CALL message using ${extractedCalls.format}`, { model, count: extractedCalls.toolCalls.length, names: extractedCalls.toolCalls.map(tc => tc.name) });
      // Return response with injected tool calls for later processing
      return { response: { ...response, _extractedToolCalls: extractedCalls.toolCalls }, model, latencyMs };
    }

    // Failed to parse - treat as retryable
    const retryableError = new Error(`Retryable finish reason: ${finishReason}. ${finishMessage}`);
    retryableError.code = "MALFORMED_FUNCTION_CALL";
    logStructured("WARN", "Retry", `Retryable finish reason: ${finishReason} (parsing failed)`, { attempt: attemptNum, model, finishReason, finishMessage });
    throw { error: retryableError, isRetryable: true, model, attempt: attemptNum };
  }

  if (isRetryableFinishReason(finishReason)) {
    const retryableError = new Error(`Retryable finish reason: ${finishReason}. ${finishMessage}`);
    retryableError.code = finishReason;
    logStructured("WARN", "Retry", `Retryable finish reason: ${finishReason}`, { attempt: attemptNum, model, finishReason, finishMessage });
    throw { error: retryableError, isRetryable: true, model, attempt: attemptNum };
  }

  return { response, model, latencyMs };
}

async function attemptWithRetryAndFallback(contents, primaryModel) {
  const fallbackChain = ENABLE_SMART_ROUTING ? getFallbackChain(primaryModel) : [primaryModel];

  logStructured("INFO", "SmartRouting", "Starting request with same-location fallback chain", { primary: primaryModel, chain: fallbackChain, enabled: ENABLE_SMART_ROUTING, location: "global" });

  for (let chainIndex = 0; chainIndex < fallbackChain.length; chainIndex++) {
    const currentModel = fallbackChain[chainIndex];

    if (chainIndex > 0) {
      const fromShort = fallbackChain[chainIndex - 1].replace("gemini-3.0-", "").replace("gemini-3.1-", "").replace("-preview", "");
      const toShort = currentModel.replace("gemini-3.0-", "").replace("gemini-3.1-", "").replace("-preview", "");
      logStructured("INFO", "Fallback", `from ${fromShort} → ${toShort}`, { from: fallbackChain[chainIndex - 1], to: currentModel, fallbackNum: chainIndex, location: "global" });
    }

    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await attemptSingleRequest(contents, currentModel, attempt);
        logStructured("INFO", "SmartRouting", "Request successful", { model: currentModel, attempts: attempt, fallbackUsed: chainIndex > 0 });
        return result;
      } catch (attemptError) {
        const { error, isRetryable, model, attempt: attemptNum } = attemptError;

        if (!isRetryable) {
          logStructured("ERROR", "SmartRouting", "Non-retryable error", { model, error: error?.message, code: error?.code });
          throw error;
        }

        if (attempt < maxAttempts) {
          const delayMs = attempt * SMART_ROUTING_FALLBACK_DELAY_MS;
          logStructured("INFO", "Retry", `Waiting ${delayMs}ms before same-model retry`, { model, attempt: attemptNum, nextAttempt: attempt + 1 });
          await sleep(delayMs);
        } else {
          logStructured("WARN", "Retry", "Max retries exceeded for model", { model, attempts: attempt });
        }
      }
    }
  }

  logStructured("ERROR", "SmartRouting", "All same-location fallback models exhausted", { primary: primaryModel, chain: fallbackChain, location: "global" });
  throw new Error("All models unavailable after retries and fallbacks");
}

export async function generateTextFromVertex(contents, model) {
  const resolvedModel = model || process.env.GEMINI_FLASH_MODEL || "gemini-2.0-flash-001";
  logStructured("INFO", "Vertex", "Request start", { model: resolvedModel, contentCount: contents.length, smartRouting: ENABLE_SMART_ROUTING });

  let result;
  try {
    result = await attemptWithRetryAndFallback(contents, resolvedModel);
  } catch (error) {
    const isTimeout = error.name === "AbortError" || error?.code === 4;
    if (isTimeout) {
      logStructured("ERROR", "Vertex", "Request timeout/aborted after all retries", { model: resolvedModel, error: error?.message });
    } else {
      logStructured("ERROR", "Vertex", "Request failed after all retries/fallbacks", { model: resolvedModel, error: error?.message, code: error?.code });
    }
    return { type: "text", text: ERROR_FALLBACK_TEXT, isError: true, model: resolvedModel };
  }

  const { response, model: actualModel, latencyMs } = result;
  const fallbackUsed = actualModel !== resolvedModel;

  logStructured("DEBUG", "Gemini Raw", "Response received", { model: actualModel, requestedModel: resolvedModel, fallbackUsed, latencyMs, raw: truncateForLog(response) });

  const finishReason = getFinishReason(response);
  const finishMessage = getFinishMessage(response);

  if (isErrorFinishReason(finishReason)) {
    logStructured("ERROR", "Vertex", `Error finish reason: ${finishReason}`, { model: actualModel, requestedModel: resolvedModel, finishReason, finishMessage, fallbackUsed });
    return { type: "text", text: `Model error: ${finishReason}. ${finishMessage || ERROR_FALLBACK_TEXT}`, isError: true, model: actualModel, fallbackUsed };
  }

  // Check for tool calls extracted from MALFORMED_FUNCTION_CALL
  if (response?._extractedToolCalls && response._extractedToolCalls.length > 0) {
    logStructured("INFO", "Tool Calls Extracted", `Using ${response._extractedToolCalls.length} tool call(s) from MALFORMED_FUNCTION_CALL parsing`, { model: actualModel, requestedModel: resolvedModel, names: response._extractedToolCalls.map(fc => fc.name), count: response._extractedToolCalls.length });
    return { type: "functionCalls", functionCalls: response._extractedToolCalls, model: actualModel, fallbackUsed };
  }

  const functionCalls = extractFunctionCalls(response);
  if (functionCalls.length > 0) {
    logStructured("INFO", "Tool Calls Extracted", `Found ${functionCalls.length} function call(s)`, { model: actualModel, requestedModel: resolvedModel, names: functionCalls.map(fc => fc.name), count: functionCalls.length });
    return { type: "functionCalls", functionCalls, model: actualModel, fallbackUsed };
  }

  const text = extractResponseText(response);

  const textToolCalls = extractTextToolCalls(text);
  if (textToolCalls && textToolCalls.toolCalls.length > 0) {
    logStructured("INFO", "ToolCall Parsed", `format: ${textToolCalls.format}`, { model: actualModel, count: textToolCalls.toolCalls.length, names: textToolCalls.toolCalls.map(tc => tc.name), format: textToolCalls.format });
    return { type: "functionCalls", functionCalls: textToolCalls.toolCalls, model: actualModel, fallbackUsed };
  }

  logStructured("INFO", "Vertex", "Text response", { model: actualModel, requestedModel: resolvedModel, fallbackUsed, textLength: text.length, isFallback: text === SAFE_FALLBACK_TEXT });
  return { type: "text", text, model: actualModel, fallbackUsed };
}

async function generateWithGeminiImage(client, prompt, n, model) {
  if (!model) {
    throw new Error("Invalid request: GEMINI_IMAGE_MODEL is required for Gemini image generation");
  }

  const request = {
    model: getModelPath(model),
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      candidateCount: n
    }
  };

  const [response] = await client.generateContent(request, {
    timeout: REQUEST_TIMEOUT_MS
  });

  return extractResponseImages(response);
}

async function generateWithImagen(client, prompt, n, model) {
  const projectId = process.env.PROJECT_ID;
  const location = getGcpLocation();
  const imagenModel = model || process.env.IMAGEN_MODEL || "imagen-3.0-generate-002";

  const endpoint = `projects/${projectId}/locations/${location}/publishers/google/models/${imagenModel}`;
  const request = {
    endpoint,
    instances: [helpers.toValue({ prompt })],
    parameters: helpers.toValue({ sampleCount: n })
  };

  const [response] = await withRetry(() =>
    client.predict(request, {
      timeout: REQUEST_TIMEOUT_MS
    })
  );

  const predictions = response?.predictions ?? [];
  return predictions
    .map((prediction) => helpers.fromValue(prediction))
    .map((prediction) => prediction?.bytesBase64Encoded)
    .filter((value) => typeof value === "string" && value.length > 0);
}

export async function generateImagesFromVertex({ prompt, n, model }) {
  const client = createClient();
  const resolvedModel =
    model ||
    process.env.GEMINI_IMAGE_MODEL ||
    process.env.IMAGEN_MODEL;

  if (!resolvedModel) {
    throw new Error(
      "Invalid request: set model in request or configure GEMINI_IMAGE_MODEL / IMAGEN_MODEL"
    );
  }

  if (isImagenModel(resolvedModel)) {
    return generateWithImagen(client, prompt, n, resolvedModel);
  }

  if (isGeminiFamilyModel(resolvedModel)) {
    return generateWithGeminiImage(client, prompt, n, resolvedModel);
  }

  throw new Error("Invalid request: unsupported image model");
}
