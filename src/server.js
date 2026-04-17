import "dotenv/config";
import express from "express";
import { validateApiKey } from "./auth.js";
import {
  toOpenAIImagesRequest,
  toOpenAIImagesResponse,
  toOpenAIResponse,
  toVertexRequest
} from "./transform.js";
import {
  generateImagesFromVertex,
  generateTextFromVertex,
  modelSupportsImageGeneration,
  modelSupportsVisionInput
} from "./vertex.js";

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "10mb" }));

function classifyImageRoute(model) {
  if (typeof model !== "string") return "gemini-image";
  return model.toLowerCase().startsWith("imagen") ? "imagen" : "gemini-image";
}

app.post("/v1/chat/completions", validateApiKey, async (req, res) => {
  try {
    const hasImage = JSON.stringify(req.body).includes("image_url");
    console.log("Request:", {
      type: req.path,
      model: req.body?.model ?? process.env.GEMINI_FLASH_MODEL,
      hasImage
    });

    if (hasImage && !modelSupportsVisionInput(req.body?.model)) {
      return res.status(400).json({
        error: "Invalid request: selected model does not support image input"
      });
    }

    const vertexPayload = await toVertexRequest(req.body);
    const content = await generateTextFromVertex(
      vertexPayload.contents,
      vertexPayload.model
    );
    res.set("x-router2-route", "gemini-chat");
    return res.json(toOpenAIResponse(content));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    if (message.startsWith("Invalid request:")) {
      return res.status(400).json({ error: message });
    }

    return res.status(500).json({ error: "Vertex request failed" });
  }
});

app.post("/v1/images/generations", validateApiKey, async (req, res) => {
  try {
    const resolvedModel =
      req.body?.model ||
      process.env.GEMINI_IMAGE_MODEL ||
      process.env.IMAGEN_MODEL;
    console.log("Request:", {
      type: req.path,
      model: resolvedModel,
      hasImage: false
    });

    if (!modelSupportsImageGeneration(resolvedModel)) {
      return res.status(400).json({
        error: "Invalid request: unsupported image model"
      });
    }

    const imageRequest = toOpenAIImagesRequest(req.body);
    const images = await generateImagesFromVertex(imageRequest);
    res.set("x-router2-route", classifyImageRoute(imageRequest.model || resolvedModel));
    return res.json(toOpenAIImagesResponse(images));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    if (message.startsWith("Invalid request:")) {
      return res.status(400).json({ error: message });
    }

    return res.status(500).json({ error: "Vertex image generation failed" });
  }
});

app.use((req, res) => {
  return res.status(404).json({ error: "Not found" });
});

app.listen(port, () => {
  console.log(`Router2 listening on port ${port}`);
});
