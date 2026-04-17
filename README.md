# Router2

OpenAI-compatible Node.js middleware that routes OpenClaw requests to Google Vertex AI for:
- chat + vision with Gemini Flash
- image generation with Gemini image-capable models or Imagen

## Features

- OpenAI-style endpoints:
  - `POST /v1/chat/completions`
  - `POST /v1/images/generations`
- API key middleware with `Authorization: Bearer <ROUTER_API_KEY>`
- Text-only and multimodal (text + image URL) input support
- Native `fetch` for image retrieval with 10-second timeout
- Image-to-base64 conversion for Vertex `inline_data`
- OpenAI-compatible response shape
- Runtime model routing (`model` in request body or env defaults)
- Strict vision mode (`STRICT_IMAGE_MODE`) to prevent silent fallback
- Render-ready (uses `process.env.PORT`)

## Project Structure

```txt
.
├── package.json
├── .env
├── README.md
└── src
    ├── server.js
    ├── vertex.js
    ├── transform.js
    └── auth.js
```

## Prerequisites

- Node.js 20+
- A Google Cloud project with Vertex AI enabled
- Service account credentials with Vertex AI access

## Environment Variables

Create `.env`:

```env
PORT=3000
PROJECT_ID=your-project-id
LOCATION=us-central1
ROUTER_API_KEY=supersecretkey
GEMINI_FLASH_MODEL=gemini-2.0-flash-001
GEMINI_IMAGE_MODEL=gemini-2.0-flash-preview-image-generation
IMAGEN_MODEL=imagen-3.0-generate-002
STRICT_IMAGE_MODE=true
```

## Google Credentials

Set the service account key path:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/to/key.json"
```

On Render, add `GOOGLE_APPLICATION_CREDENTIALS` as an environment variable pointing to your mounted key path, or use Render's supported secret/file mechanism for credentials.

## Install and Run Locally

```bash
npm install
npm start
```

Server starts on `http://localhost:3000` by default.

## API

### Endpoint

- `POST /v1/chat/completions`
- `POST /v1/images/generations`

### Headers

- `Authorization: Bearer <ROUTER_API_KEY>`
- `Content-Type: application/json`

### Text Request Example

```bash
curl -X POST "http://localhost:3000/v1/chat/completions" \
  -H "Authorization: Bearer supersecretkey" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.0-flash-001",
    "messages": [
      { "role": "user", "content": "Explain AI" }
    ]
  }'
```

### Image Request Example

```bash
curl -X POST "http://localhost:3000/v1/chat/completions" \
  -H "Authorization: Bearer supersecretkey" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.0-flash-001",
    "messages": [
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "What is this image?" },
          { "type": "image_url", "image_url": { "url": "https://example.com/image.jpg" } }
        ]
      }
    ]
  }'
```

### OpenAI Images API Example (Gemini image model)

```bash
curl -X POST "http://localhost:3000/v1/images/generations" \
  -H "Authorization: Bearer supersecretkey" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.0-flash-preview-image-generation",
    "prompt": "A futuristic city at sunset, cinematic, ultra detailed",
    "n": 1
  }'
```

### OpenAI Images API Example (Imagen)

```bash
curl -X POST "http://localhost:3000/v1/images/generations" \
  -H "Authorization: Bearer supersecretkey" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "imagen-3.0-generate-002",
    "prompt": "A studio product photo of a red sneaker on white background",
    "n": 1
  }'
```

## Response Format

The middleware returns OpenAI-compatible responses:

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "response text"
      }
    }
  ]
}
```

For image generation, response format is OpenAI-compatible:

```json
{
  "created": 1710000000,
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAA..."
    }
  ]
}
```

## Error Handling

- `401` for missing/invalid API key
- `400` for malformed request body
- `500` for Vertex API failures
- If `STRICT_IMAGE_MODE=true`, vision requests fail fast when image fetch fails
- If `STRICT_IMAGE_MODE=false`, image fetch failures fall back to text-only behavior

## Model Routing and Guards

- Chat + vision (`/v1/chat/completions`)
  - Uses request `model` when present, otherwise `GEMINI_FLASH_MODEL`
  - Rejects image input when selected model does not support vision
- Image generation (`/v1/images/generations`)
  - `model` starting with `imagen` routes to Imagen
  - `model` containing `flash` or `gemini` routes to Gemini image generation
  - Other values return `400` unsupported model

## Deploy on Render

1. Create a new **Web Service** from this repository.
2. Runtime: **Node**.
3. Build command: `npm install`
4. Start command: `npm start`
5. Set environment variables:
   - `PORT` (Render can set this automatically)
   - `PROJECT_ID`
   - `LOCATION`
   - `ROUTER_API_KEY`
   - `GOOGLE_APPLICATION_CREDENTIALS`
6. Deploy.

Render injects `PORT`, and this app listens on `process.env.PORT`, so it is compatible with native Render Node deployment.

## Cloud Run (Next Step)

This codebase is also compatible with Cloud Run because it is stateless and binds to `process.env.PORT`.
