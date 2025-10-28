# Claude Code OpenRouter Proxy

A proxy server that allows Claude Code to work with OpenRouter API endpoints. Built with Bun runtime for fast, lightweight local deployment.

## Features

- **BYOK (Bring Your Own Key)**: Users can use their own OpenRouter API keys
- **Model Mapping**: Automatically maps Anthropic model names to OpenRouter equivalents
- **Tool Support**: Full support for Claude Code's tool/function calling
- **CORS Enabled**: Cross-origin requests supported
- **Fast & Lightweight**: Powered by Bun runtime for optimal performance
- **TypeScript**: Written in TypeScript for type safety

## Prerequisites

- [Bun](https://bun.sh) (v1.0.0 or higher)

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd claude-code-openrouter-proxy
```

2. Install dependencies:
```bash
bun install
```

3. Create a `.env` file from the example:
```bash
cp .env.example .env
```

4. Configure your environment variables in `.env`:
```bash
# Required for server-key mode, optional for BYOK mode
OPENROUTER_API_KEY=your_openrouter_api_key_here

# Optional: Set custom port (default: 3000)
PORT=3000

# Optional: Enable proxy token requirement
REQUIRE_PROXY_TOKEN=0
PROXY_TOKEN=your_secret_token
```

## Fetching Available Models

To fetch all available Anthropic models from OpenRouter:

```bash
bun run fetch-models
```

This will:
- Display all available Anthropic models with pricing
- Generate `model-map.json` with ALL Anthropic model mappings (auto-loaded by server)
- Generate `pricing.json` with pricing for cost estimation
- Generate `anthropic-models.json` with full model details

**The server automatically loads `model-map.json` on startup**, making all Anthropic models available without additional configuration!

You can optionally configure pricing in your `.env`:

```bash
# Copy the content from pricing.json for cost tracking
PRICING_JSON='{"anthropic/claude-3.7-sonnet":{"in":0.003,"out":0.015},...}'
```

## Running the Server

### Development Mode (with hot reload):
```bash
bun run dev
```

### Production Mode:
```bash
bun start
```

The server will start at `http://localhost:3000` (or your configured PORT).

## Setup Instructions for Claude Code

### For Users (Recommended - BYOK Mode)

Set these environment variables in your shell:

```bash
# 1) Base URL without path or query (no /v1/messages, no ?beta=true)
export ANTHROPIC_BASE_URL="http://localhost:3333"

# 2) API Key: Use your OpenRouter API key in ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY="sk-or-v1-..."

# 3) For custom model:
claude --model "anthropic/claude-3.7-sonnet"
```

That's it! Claude Code will now work through the local proxy with your OpenRouter key.

### For Server-Key Mode

If you want to use a server-side OpenRouter API key:

1. Set `OPENROUTER_API_KEY` in your `.env` file
2. Set `REQUIRE_PROXY_TOKEN=1` in your `.env` file
3. Set a secure `PROXY_TOKEN` in your `.env` file
4. Configure Claude Code:

```bash
export ANTHROPIC_BASE_URL="http://localhost:3000"
export ANTHROPIC_API_KEY="any-value"  # Required but not used
export PROXY_TOKEN="your_secret_token"  # Send via proxy-token header
```

## Supported Models

The proxy automatically maps these Anthropic models to OpenRouter:

- `claude-3-5-haiku-20241022` → passes through as-is
- `claude-3-7-sonnet-latest` → passes through as-is
- `claude-3-7-sonnet-20250219` → passes through as-is
- `claude-3-opus-20240229` → passes through as-is

You can configure custom model mappings via the `MODEL_MAP_EXT` environment variable (JSON format).

## Configuration Options

All configuration is done via environment variables (see `.env.example`):

### Server Configuration
- `PORT`: Server port (default: 3000)

### Authentication
- `OPENROUTER_API_KEY`: Your OpenRouter API key (for server-key mode)
- `REQUIRE_PROXY_TOKEN`: Set to "1" to require proxy token (default: "0")
- `PROXY_TOKEN`: Secret token for proxy authentication

### Model Configuration
- `FORCE_MODEL`: Force all requests to use a specific model
- `PRIMARY_MODEL`: Override model selection
- `FALLBACK_MODEL`: Fallback model for rate limits/errors
- `MODEL_MAP_EXT`: JSON object for custom model mappings

### Advanced
- `REASONING_EFFORT`: For reasoning models (low/medium/high, default: medium)
- `ESTIMATE_USAGE`: Enable usage estimation (default: "1")
- `ESTIMATE_TOKENS_PER_CHAR`: Token estimation ratio (default: 0.25)
- `PRICING_JSON`: Model pricing in JSON format for cost estimation
- `TIMEOUT_MS`: Request timeout in milliseconds (default: 180000)

## API Endpoints

- `POST /v1/messages` - Main Claude API endpoint (compatible with Anthropic API)
- `POST /v1/messages/count_tokens` - Token counting endpoint
- `GET /health` - Health check endpoint
- `OPTIONS /v1/messages` - CORS preflight

### Automatic Model Loading

The server automatically loads model mappings from `model-map.json` (if present) on startup. This enables all Anthropic models from OpenRouter to be used directly through the proxy.

To generate the model map:
```bash
bun run fetch-models
```

This creates `model-map.json` with mappings for all available Anthropic models, including:
- Full OpenRouter IDs (e.g., `anthropic/claude-3.7-sonnet`)
- Short names (e.g., `claude-3.7-sonnet`)
- Base names without dates (e.g., `claude-3.5-sonnet` → latest dated version)

## Development

The project structure:
```
.
├── server.ts                          # Main Bun server (TypeScript)
├── package.json                       # Bun package configuration
├── tsconfig.json                      # TypeScript configuration
├── .env.example                       # Environment variables template
├── README.md                          # This file
└── scripts/
    └── fetch-anthropic-models.ts      # Utility to fetch available models
```

### Available Scripts

- `bun run dev` - Start development server with hot reload
- `bun run start` - Start production server
- `bun run fetch-models` - Fetch and display all available Anthropic models from OpenRouter

## Security Features

- CORS headers properly configured
- Timeout protection (3 minutes default)
- Request validation
- Error handling with appropriate HTTP status codes
- Optional proxy token authentication

## Performance

Running on Bun provides:
- Fast startup times
- Low memory footprint
- Native TypeScript support
- Built-in hot reload during development
- Excellent HTTP server performance

## Troubleshooting

### Server won't start
- Ensure Bun is installed: `bun --version`
- Check if port is available: `lsof -i :3000`
- Verify environment variables are set correctly

### Claude Code connection issues
- Verify `ANTHROPIC_BASE_URL` doesn't include `/v1/messages`
- Check server is running: `curl http://localhost:3000/health`
- Ensure no trailing slashes in the base URL

### API errors
- Verify your OpenRouter API key is valid
- Check OpenRouter account has sufficient credits
- Review server logs for detailed error messages

## License

MIT
