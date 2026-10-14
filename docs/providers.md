# Provider Management in FORGE v1.1

FORGE is completely provider-neutral. It supports any standard OpenAI-compatible API, Anthropic Messages protocol, NVIDIA NIM, and local servers (Ollama, vLLM, LocalAI) without touching code.

## Provider Registry Concepts

Every configured provider in FORGE exposes:
- **`id`**: Unique provider identifier (e.g. `nvidia-nim`, `openai`, `anthropic`, `ollama-local`).
- **`name`**: Display name in UI and CLI.
- **`kind`**: Protocol adapter:
  - `openai-compatible`: Standard Chat Completions API (`POST /chat/completions`, `GET /models`).
  - `anthropic-messages`: Anthropic Messages API (`POST /v1/messages`).
  - `nvidia-nim`: High-performance OpenAI-compatible NVIDIA NIM integration.
- **`baseUrl`**: Remote endpoint base URL.
- **`apiKeyEnvVar`**: Backing environment variable name.
- **`maskedApiKey`**: Masked representation for safety (e.g., `nvap••••••••l_Lz`).
- **`availableModels`**: List of models discovered or registered for this provider.
- **`model`**: Default model ID.
- **`fallbackModels`**: Ordered list of fallback models.
- **`status`**: Health status (`healthy`, `untested`, `error`, `unconfigured`).
- **`lastLatencyMs`**: Round-trip latency from the latest health check.

## UI Management

1. Open **Providers & Models** in the sidebar.
2. Click any preset (**NVIDIA NIM**, **OpenAI**, **Anthropic**, **DeepSeek**, **Ollama Local**).
3. Update endpoints or API keys dynamically.
4. Click **Test Connection**: FORGE performs a live HTTP probe to verify authentication and latency, populating available models automatically.

## CLI Commands

```bash
# List all providers
forge providers

# Add a custom provider
forge providers add custom "Custom LLM" openai-compatible http://10.0.0.5:8000/v1 CUSTOM_API_KEY

# Test provider connection
forge providers test nvidia-nim

# List available models
forge providers models nvidia-nim

# Set default provider
forge providers default nvidia-nim

# Remove provider
forge providers delete custom
```
