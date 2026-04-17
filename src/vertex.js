import { helpers, v1 } from "@google-cloud/aiplatform";

const REQUEST_TIMEOUT_MS = 10_000;

const { PredictionServiceClient } = v1;

function getModelPath(model) {
  const projectId = process.env.PROJECT_ID;
  const location = process.env.LOCATION;
  const defaultModel = process.env.GEMINI_FLASH_MODEL || "gemini-2.0-flash-001";

  if (!projectId || !location) {
    throw new Error("Missing PROJECT_ID or LOCATION environment variables");
  }

  const chosenModel = model || defaultModel;
  return `projects/${projectId}/locations/${location}/publishers/google/models/${chosenModel}`;
}

function createClient() {
  const location = process.env.LOCATION;
  if (!location) {
    throw new Error("Missing LOCATION environment variable");
  }

  return new PredictionServiceClient({
    apiEndpoint: `${location}-aiplatform.googleapis.com`
  });
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

  const [response] = await client.generateContent(request, {
    timeout: REQUEST_TIMEOUT_MS
  });

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

  const [response] = await client.generateContent(request, {
    timeout: REQUEST_TIMEOUT_MS
  });

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
  const location = process.env.LOCATION;
  const imagenModel = model || process.env.IMAGEN_MODEL || "imagen-3.0-generate-002";

  const endpoint = `projects/${projectId}/locations/${location}/publishers/google/models/${imagenModel}`;
  const request = {
    endpoint,
    instances: [helpers.toValue({ prompt })],
    parameters: helpers.toValue({ sampleCount: n })
  };

  const [response] = await client.predict(request, {
    timeout: REQUEST_TIMEOUT_MS
  });

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
