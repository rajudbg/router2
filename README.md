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
- Vertex retry/backoff for transient upstream failures (`429/503`)
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
IMAGE_FETCH_TIMEOUT_MS=20000
MAX_IMAGE_BYTES=10485760
DEBUG_ERRORS=false
```

## Google Credentials

Set the service account key path:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/absolute/path/to/key.json"
```

On Render, add `GOOGLE_APPLICATION_CREDENTIALS` as an environment variable pointing to your mounted key path, or use Render's supported secret/file mechanism for credentials.

### Alternative for Render: base64 credentials

If you cannot mount a credentials file, set `GOOGLE_CREDENTIALS_BASE64` to a base64-encoded service account JSON.
At startup, Router2 will decode it, write `/tmp/router2-gcp-key.json`, and set `GOOGLE_APPLICATION_CREDENTIALS` automatically.

Example to generate base64 from a local key file:

```bash
base64 -i key.json | tr -d '\n'
```

Paste the resulting single-line value into Render env var `GOOGLE_CREDENTIALS_BASE64` (no quotes).

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

### OpenAI / OpenRouter Compatibility Notes

- Router2 accepts OpenAI-compatible request payloads for:
  - `chat/completions` (`messages`, optional `model`, multimodal `content[]`)
  - `images/generations` (`prompt`, `n`, optional `model`)
- Router2 returns OpenAI-compatible success response shapes:
  - chat: `choices[].message.role/content`
  - images: `created`, `data[].b64_json`
- Router2 also adds a diagnostic response header:
  - `x-router2-route: gemini-chat | gemini-image | imagen`
- Error objects are simplified (`{ "error": "..." }`), not full OpenAI error object schema.

### Headers

- `Authorization: Bearer <ROUTER_API_KEY>`
- `Content-Type: application/json`

### Text Request Example

```bash
curl -X POST "http://localhost:3000/v1/chat/completions" \
  -H "Authorization: Bearer supersecretkey" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-2.5-flash",
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
    "model": "gemini-2.5-flash",
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
    "model": "gemini-2.5-flash",
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
- `429` when Vertex is rate-limited/resource exhausted
- `503` for transient Vertex unavailability
- `500` for unexpected server/internal errors
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

## Migrate from Google AI Studio API to Router2

If your app currently calls Google AI Studio Gemini endpoints directly, migration is mainly a transport/auth change.

### 1) Endpoint and auth change

- Before (AI Studio): Google endpoint + Google API key auth.
- After (Router2): your Router2 endpoint + Router API key auth.

Use:

- Base URL: `https://your-router-domain`
- Header: `Authorization: Bearer <ROUTER_API_KEY>`

### 2) Keep OpenAI-style payloads in your app

Router2 accepts OpenAI-style payloads, so clients that already talk OpenAI/OpenRouter-style APIs usually only need:

- `baseURL` swap to Router2
- API key swap to `ROUTER_API_KEY`
- optional model name updates (for example `gemini-2.5-flash`, `imagen-3.0-generate-002`)

### 3) Model mapping guidance

- Text + vision chat:
  - Set `GEMINI_FLASH_MODEL=gemini-2.5-flash` in env
  - Or pass `"model": "gemini-2.5-flash"` per request
- Image generation:
  - Imagen: `"model": "imagen-3.0-generate-002"`
  - Gemini image-capable model: set/request a Gemini image-capable model

### 4) Client migration checklist

- Replace old endpoint with `https://your-router-domain/v1/chat/completions`
- Replace old endpoint with `https://your-router-domain/v1/images/generations`
- Replace Google API key header with `Authorization: Bearer <ROUTER_API_KEY>`
- Keep request JSON as OpenAI-style
- Validate returned `choices` and `data[].b64_json`
- In production, set:
  - `STRICT_IMAGE_MODE=true`
  - `DEBUG_ERRORS=false`
