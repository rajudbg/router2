import { helpers, v1 } from "@google-cloud/aiplatform";

const REQUEST_TIMEOUT_MS = 10_000;
const RETRYABLE_ERROR_CODES = new Set([4, 8, 13, 14]);
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

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

function extractResponseText(response) {
  const candidates = response?.candidates ?? [];
  const firstCandidate = candidates[0];
  const parts = firstCandidate?.content?.parts ?? [];

  const text = parts
    .map((part) => part?.text)
    .filter((value) => typeof value === "string")
    .join("");

  return text || "";
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

export async function generateTextFromVertex(contents, model) {
  const client = createClient();
  const request = {
    model: getModelPath(model),
    contents
  };

  const [response] = await withRetry(() =>
    client.generateContent(request, {
      timeout: REQUEST_TIMEOUT_MS
    })
  );

  return extractResponseText(response);
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
