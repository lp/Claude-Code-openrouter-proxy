# Claude Code OpenRouter Proxy

A public proxy server that allows Claude Code to work with OpenRouter API endpoints without any installation required.

## Features

- **BYOK (Bring Your Own Key)**: Users can use their own OpenRouter API keys
- **Model Mapping**: Automatically maps Anthropic model names to OpenRouter equivalents
- **Tool Support**: Full support for Claude Code's tool/function calling
- **CORS Enabled**: Cross-origin requests supported
- **No Installation**: Works directly with Claude Code by setting environment variables

## Setup Instructions

### For Users (Recommended - BYOK Mode)

No installation required! Just set these environment variables:

```bash
# 1) Base URL without path or query (no /v1/messages, no ?beta=true)
export ANTHROPIC_BASE_URL="https://proxycodeclaude.mellot-jules.workers.dev"

# 2) API Key: Use your OpenRouter API key in ANTHROPIC_API_KEY
export ANTHROPIC_API_KEY="sk-or-v1_..."

# 3) For custom model :
claude --model "z-ai/glm-4.5"
```

That's it! Claude Code will now work through the proxy with your OpenRouter key.

### For Hosters

If you want to host your own instance:

1. Deploy this to Cloudflare Workers
2. Configure your `wrangler.toml` with:
   - Set `REQUIRE_PROXY_TOKEN = "0"` for public access or `"1"` for restricted access
   - Optionally set `OPENROUTER_API_KEY` for server-key mode
   - Set `REASONING_EFFORT` if desired (default: "medium")

## Supported Models

The proxy automatically maps these Anthropic models to OpenRouter:

- `claude-3-5-haiku-20241022` → `anthropic/claude-3.5-haiku`
- `claude-3-7-sonnet-latest` → `anthropic/claude-3.7-sonnet`
- `claude-3-7-sonnet-20250219` → `anthropic/claude-3.7-sonnet`
- `claude-3-opus-20240229` → `anthropic/claude-3-opus`

## Authentication Modes

### BYOK Mode (Recommended)
- Users provide their own OpenRouter API key via `ANTHROPIC_API_KEY`
- No server configuration required
- Key is sent via `x-api-key` or `anthropic-api-key` header

### Server Key Mode
- Proxy uses a configured OpenRouter API key
- Requires `REQUIRE_PROXY_TOKEN = "1"` and `PROXY_TOKEN` for security
- Useful for controlled environments

## API Endpoints

- `POST /v1/messages` - Main Claude API endpoint
- `GET /health` - Health check endpoint
- `OPTIONS /v1/messages` - CORS preflight

## Security Features

- CORS headers properly configured
- Timeout protection (3 minutes default)
- Request validation
- Error handling with appropriate HTTP status codes

## Development

The proxy is built for Cloudflare Workers and includes:
- Node.js compatibility flags
- Observability enabled
- Configurable timeout and reasoning effort settings
