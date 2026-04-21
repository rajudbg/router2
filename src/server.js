import "dotenv/config";
import express from "express";
import cors from "cors";
import { bootstrapGoogleCredentials } from "./bootstrapCredentials.js";
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
  modelSupportsVisionInput,
  VertexRequestError
} from "./vertex.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const debugErrors =
  String(process.env.DEBUG_ERRORS || "false").toLowerCase() === "true";

bootstrapGoogleCredentials();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

function classifyImageRoute(model) {
  if (typeof model !== "string") return "gemini-image";
  return model.toLowerCase().startsWith("imagen") ? "imagen" : "gemini-image";
}

function writeSseData(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamOpenAIChatResponse(res, { content, toolCalls, model }) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const modelName = model || process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";

  writeSseData(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: modelName,
    choices: [
      {
        index: 0,
        delta: { role: "assistant" },
        finish_reason: null
      }
    ]
  });

  if (toolCalls && toolCalls.length > 0) {
    const formattedToolCalls = toolCalls.map((tc, index) => {
      const callId = `call_${Date.now()}_${index}_${Math.random().toString(36).substring(2, 7)}`;
      return {
        index,
        id: callId,
        type: "function",
        function: {
          name: tc.name,
          arguments: typeof tc.args === "object" ? JSON.stringify(tc.args) : (tc.args || "{}")
        }
      };
    });

    writeSseData(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          delta: { tool_calls: formattedToolCalls },
          finish_reason: null
        }
      ]
    });
  }

  if (content) {
    writeSseData(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: null
        }
      ]
    });
  }

  writeSseData(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: modelName,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: (toolCalls && toolCalls.length > 0) ? "tool_calls" : "stop"
      }
    ]
  });

  res.write("data: [DONE]\n\n");
  res.end();
}

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

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
    const result = await generateTextFromVertex(vertexPayload);
    res.set("x-router2-route", "gemini-chat");

    if (req.body?.stream === true) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      streamOpenAIChatResponse(res, {
        content: result.text,
        toolCalls: result.toolCalls,
        model: vertexPayload.model
      });
      return;
    }

    return res.json(toOpenAIResponse({ text: result.text, toolCalls: result.toolCalls }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Vertex chat error:", error);

    if (message.startsWith("Invalid request:")) {
      return res.status(400).json({ error: message });
    }

    if (error instanceof VertexRequestError) {
      return res.status(error.statusCode).json({
        error:
          error.statusCode === 429
            ? "Vertex rate limited. Retry shortly."
            : "Vertex temporarily unavailable. Retry shortly.",
        ...(debugErrors ? { details: message, providerCode: error.providerCode } : {})
      });
    }

    return res.status(500).json({
      error: "Vertex request failed",
      ...(debugErrors ? { details: message } : {})
    });
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
    console.error("Vertex image error:", error);

    if (message.startsWith("Invalid request:")) {
      return res.status(400).json({ error: message });
    }

    if (error instanceof VertexRequestError) {
      return res.status(error.statusCode).json({
        error:
          error.statusCode === 429
            ? "Vertex rate limited. Retry shortly."
            : "Vertex temporarily unavailable. Retry shortly.",
        ...(debugErrors ? { details: message, providerCode: error.providerCode } : {})
      });
    }

    return res.status(500).json({
      error: "Vertex image generation failed",
      ...(debugErrors ? { details: message } : {})
    });
  }
});

app.use((req, res) => {
  return res.status(404).json({ error: "Not found" });
});

app.listen(port, () => {
  console.log(`Router2 listening on port ${port}`);
});
