import "dotenv/config";
import express from "express";
import { bootstrapGoogleCredentials } from "./bootstrapCredentials.js";
import { validateApiKey } from "./auth.js";
import {
  toOpenAIImagesRequest,
  toOpenAIImagesResponse,
  toOpenAIResponse,
  toOpenAIToolCallsResponse,
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

app.use(express.json({ limit: "10mb" }));

function classifyImageRoute(model) {
  if (typeof model !== "string") return "gemini-image";
  return model.toLowerCase().startsWith("imagen") ? "imagen" : "gemini-image";
}

function writeSseData(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamOpenAIChatResponse(res, { content, model }) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const modelName = model || process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";

  try {
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

    const safeContent = content || "No response generated";
    writeSseData(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          delta: { content: safeContent },
          finish_reason: null
        }
      ]
    });

    writeSseData(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop"
        }
      ]
    });
  } catch (streamError) {
    console.error("[Router2][Streaming] Error in text stream:", streamError);
    writeSseData(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          delta: { content: "Stream interrupted" },
          finish_reason: "stop"
        }
      ]
    });
  } finally {
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

function streamOpenAIToolCallsResponse(res, { functionCalls, model }) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const modelName = model || process.env.GEMINI_FLASH_MODEL || "gemini-2.5-flash";

  const toolCalls = functionCalls.map((fc, index) => ({
    index,
    id: `call_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 15)}`,
    type: "function",
    function: {
      name: fc.name,
      arguments: JSON.stringify(fc.args)
    }
  }));

  try {
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

    for (const toolCall of toolCalls) {
      writeSseData(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: modelName,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [toolCall]
            },
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
          finish_reason: "tool_calls"
        }
      ]
    });
  } catch (streamError) {
    console.error("[Router2][Streaming] Error in tool_calls stream:", streamError);
    writeSseData(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model: modelName,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "tool_calls"
        }
      ]
    });
  } finally {
    res.write("data: [DONE]\n\n");
    res.end();
  }
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
    const result = await generateTextFromVertex(
      vertexPayload.contents,
      vertexPayload.model
    );
    res.set("x-router2-route", "gemini-chat");

    if (result.type === "functionCalls") {
      console.log("[Router2][Route] Sending tool_calls response", { model: result.model, requestedModel: vertexPayload.model, fallbackUsed: result.fallbackUsed, count: result.functionCalls.length });
      if (req.body?.stream === true) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        streamOpenAIToolCallsResponse(res, {
          functionCalls: result.functionCalls,
          model: result.model || vertexPayload.model
        });
        return;
      }
      const response = toOpenAIToolCallsResponse(result.functionCalls);
      const isError = response.isError;
      delete response.isError;
      if (isError) {
        console.error("[Router2][ERROR][Final Response] Tool calls validation failed", { model: result.model, requestedModel: vertexPayload.model, fallbackUsed: result.fallbackUsed, finish_reason: response.choices[0]?.finish_reason });
      } else {
        console.log("[Router2][Final Response] Non-streaming tool_calls validated", { model: result.model, requestedModel: vertexPayload.model, fallbackUsed: result.fallbackUsed, finish_reason: response.choices[0]?.finish_reason, toolCount: response.choices[0]?.message?.tool_calls?.length });
      }
      return res.json(response);
    }

    if (result.isError) {
      console.error("[Router2][ERROR][Route] Sending error fallback response", { model: result.model, requestedModel: vertexPayload.model, reason: "Vertex request failed or timeout" });
    } else {
      console.log("[Router2][Route] Sending text response", { model: result.model, requestedModel: vertexPayload.model, fallbackUsed: result.fallbackUsed, textLength: result.text?.length });
    }

    if (req.body?.stream === true) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      streamOpenAIChatResponse(res, {
        content: result.text,
        model: result.model || vertexPayload.model
      });
      return;
    }

    const response = toOpenAIResponse(result.text);
    const isError = response.isError;
    delete response.isError;
    if (isError) {
      console.error("[Router2][ERROR][Final Response] Text response validation failed", { model: result.model, requestedModel: vertexPayload.model, fallbackUsed: result.fallbackUsed, finish_reason: response.choices[0]?.finish_reason });
    } else {
      console.log("[Router2][Final Response] Non-streaming text validated", { model: result.model, requestedModel: vertexPayload.model, fallbackUsed: result.fallbackUsed, hasContent: !!response.choices[0]?.message?.content, contentLength: response.choices[0]?.message?.content?.length });
    }
    return res.json(response);
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
