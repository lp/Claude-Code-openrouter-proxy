/* ========================= Types ========================= */

interface EnvConfig {
  PORT?: string;
  OPENROUTER_API_KEY?: string;
  REQUIRE_PROXY_TOKEN?: string;
  PROXY_TOKEN?: string;
  MODEL_MAP_EXT?: string;
  FORCE_MODEL?: string;
  FALLBACK_MODEL?: string;
  PRIMARY_MODEL?: string;
  REASONING_EFFORT?: string;
  ESTIMATE_USAGE?: string;
  ESTIMATE_TOKENS_PER_CHAR?: string;
  PRICING_JSON?: string;
  TIMEOUT_MS?: string;
}

interface AnthropicMessage {
  role: string;
  content: any;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: any;
}

interface AnthropicRequest {
  model?: string;
  messages?: AnthropicMessage[];
  system?: any;
  tools?: AnthropicTool[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: any;
}

interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  cost?: number;
  cost_details?: {
    upstream_inference_cost?: number;
  };
}

/* ========================= Bun HTTP Server ========================= */

const PORT = Number(process.env.PORT || 3000);
const env: EnvConfig = process.env;

Bun.serve({
  port: PORT,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Health & CORS preflight
    if (url.pathname === "/health") return withCORS(json({ ok: true }));
    if (request.method === "OPTIONS")
      return withCORS(new Response(null, { status: 204 }));
    // ---- Count tokens endpoint (Anthropic-compatible) ----
    if (
      request.method === "POST" &&
      url.pathname === "/v1/messages/count_tokens"
    ) {
      try {
        const body = (await request.json()) as AnthropicRequest;
        const input_tokens = estimatePromptTokensFromAnthropic(body, env);
        return withCORS(json({ input_tokens }));
      } catch {
        return withCORS(json({ error: "invalid_json" }, 400));
      }
    }

    // ---- Main messages endpoint ----
    if (request.method !== "POST" || url.pathname !== "/v1/messages") {
      return withCORS(json({ error: "not_found" }, 404));
    }

    // ---------- Auth ----------
    const clientKey =
      header(request, "anthropic-api-key") ||
      header(request, "x-api-key") ||
      "";
    const proxyToken = header(request, "proxy-token") || "";
    let orKey = "";
    if (clientKey && clientKey.startsWith("sk-or-")) {
      orKey = clientKey; // BYOK
    } else {
      if (!env.OPENROUTER_API_KEY)
        return withCORS(json({ error: "missing_server_key" }, 401));
      if (
        String(env.REQUIRE_PROXY_TOKEN || "0") === "1" &&
        proxyToken !== env.PROXY_TOKEN
      ) {
        return withCORS(json({ error: "forbidden" }, 403));
      }
      orKey = env.OPENROUTER_API_KEY;
    }

    // ---------- Body ----------
    let body: AnthropicRequest;
    try {
      body = (await request.json()) as AnthropicRequest;
    } catch {
      return withCORS(json({ error: "invalid_json" }, 400));
    }

    // ---------- Model mapping ----------
    // Try to load model mappings from model-map.json
    let MODEL_MAP_AUTO: Record<string, string> = {};
    try {
      const modelMapFile = Bun.file("./model-map.json");
      if (await modelMapFile.exists()) {
        MODEL_MAP_AUTO = await modelMapFile.json();
      }
    } catch (error) {
      // Silently fail, will use fallback mappings
    }

    const MODEL_MAP_BASE: Record<string, string> = {
      "claude-3-5-haiku-20241022": "$modeldemandé",
      "claude-3-7-sonnet-latest": "$modeldemandé",
      "claude-3-7-sonnet-20250219": "$modeldemandé",
      "claude-3-opus-20240229": "$modeldemandé",
    };
    const MODEL_MAP_EXT = parseJSON(env.MODEL_MAP_EXT, {});
    const FORCE_MODEL = (env.FORCE_MODEL || "").trim();

    function mapModel(id: string): string {
      if (FORCE_MODEL) return FORCE_MODEL;
      if (MODEL_MAP_EXT[id]) return MODEL_MAP_EXT[id];
      if (MODEL_MAP_AUTO[id]) return MODEL_MAP_AUTO[id]; // Auto-loaded from model-map.json
      if (MODEL_MAP_BASE[id] === "$modeldemandé") return id;
      if (MODEL_MAP_BASE[id]) return MODEL_MAP_BASE[id];
      return id;
    }

    // ---- STREAM BRANCH (SSE) ----
    const accept = request.headers.get("accept") || "";
    const wantsStream =
      accept.includes("text/event-stream") || (body && body.stream === true);
    if (wantsStream) {
      const payload = toOpenRouterPayload(body, request, env, mapModel);
      payload.stream = true;
      payload.usage = { include: true };

      const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
      const orResp = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${orKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "public-proxy",
          "X-Title": "ClaudeCode via OpenRouter",
        },
        body: JSON.stringify(payload),
      });

      if (!orResp.ok || !orResp.body) {
        const err = await orResp.text().catch(() => "");
        return withCORS(
          new Response(err || "upstream_error", {
            status: orResp.status || 502,
          })
        );
      }

      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        start(controller) {
          const reader = orResp.body!.getReader();
          const sendEvent = (name: string, obj: any) => {
            controller.enqueue(encoder.encode(`event: ${name}\n`));
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)
            );
          };

          sendEvent("message_start", { type: "message_start" });

          (async () => {
            const dec = new TextDecoder();
            let buf = "";
            let lastUsage: any = null;

            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              const parts = buf.split("\n\n");
              buf = parts.pop() || "";

              for (const chunk of parts) {
                const line = chunk.trim();
                if (!line) continue;
                const jsonLine = line.replace(/^data:\s*/i, "");
                if (jsonLine === "[DONE]") continue;

                let obj: any;
                try {
                  obj = JSON.parse(jsonLine);
                } catch {
                  continue;
                }

                const delta = obj?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta.length) {
                  sendEvent("content_block_delta", {
                    type: "content_block_delta",
                    delta: { type: "text_delta", text: delta },
                  });
                }

                if (obj?.usage) {
                  lastUsage = obj.usage;
                }
              }
            }

            if (lastUsage) {
              const u = mapUsageFromOpenRouter(lastUsage);
              sendEvent("message_delta", {
                type: "message_delta",
                delta: { usage: u },
              });
            }

            sendEvent("message_stop", { type: "message_stop" });
            controller.close();
          })().catch((e) => controller.error(e));
        },
      });

      return new Response(readable, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          "anthropic-version": "2023-06-01",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET, OPTIONS",
          "access-control-allow-headers":
            "content-type, x-api-key, anthropic-api-key, anthropic-version, proxy-token, x-or-model",
        },
      });
    }

    // ---- NON-STREAM branch ----
    const payload = toOpenRouterPayload(body, request, env, mapModel);
    const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
    const t0 = Date.now();

    let resp = await timedFetch(
      OPENROUTER_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${orKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "public-proxy",
          "X-Title": "ClaudeCode via OpenRouter",
        },
        body: JSON.stringify(payload),
      },
      env
    );

    // Fallback si 429/5xx
    if (!resp.ok) {
      const status = resp.status;
      const FALLBACK_MODEL = (env.FALLBACK_MODEL || "").trim();
      if (
        (status === 429 || (status >= 500 && status <= 599)) &&
        FALLBACK_MODEL
      ) {
        const p2 = { ...payload, model: FALLBACK_MODEL };
        resp = await timedFetch(
          OPENROUTER_URL,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${orKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "public-proxy",
              "X-Title": "ClaudeCode via OpenRouter",
            },
            body: JSON.stringify(p2),
          },
          env
        );
      }
    }

    const data = await resp.json();
    const t1 = Date.now();
    const durationMs = t1 - t0;

    if (!resp.ok) {
      console.log(`[OUT] status=${resp.status}`);
      return withCORS(json(data, resp.status));
    }

    const inputTokensEstimate = shouldEstimateUsage(env)
      ? estimatePromptTokensFromAnthropic(body, env)
      : 0;

    const { out, headers } = toAnthropicResponse(
      data,
      payload,
      durationMs,
      env,
      mapModel,
      inputTokensEstimate
    );
    return withCORS(json(out, 200, headers));
  },
});

console.log(`🚀 Server running at http://localhost:${PORT}`);
console.log(`📝 Health check: http://localhost:${PORT}/health`);

console.log(`� API endpoint: http://localhost:${PORT}/v1/messages`);

/* ========================= Helpers & Mappers ========================= */

function header(request: Request, key: string): string {
  return (
    request.headers.get(key) || request.headers.get(key.toLowerCase()) || ""
  );
}

function parseJSON(raw: string | undefined, fallback: any): any {
  try {
    const t = (raw || "").trim();
    return t ? JSON.parse(t) : fallback;
  } catch {
    return fallback;
  }
}

function shouldEstimateUsage(env: EnvConfig): boolean {
  return String(env.ESTIMATE_USAGE || "1") === "1";
}

function tokensPerChar(env: EnvConfig): number {
  const v = Number(env.ESTIMATE_TOKENS_PER_CHAR || 0.25);
  return Number.isFinite(v) && v > 0 ? v : 0.25;
}

function extractText(content: any): string {
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b) return "";
        if (typeof b === "string") return b;
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (typeof b.text === "string") return b.text;
        if ("input" in b)
          return typeof b.input === "string"
            ? b.input
            : JSON.stringify(b.input);
        if ("output" in b)
          return typeof b.output === "string"
            ? b.output
            : JSON.stringify(b.output);
        return JSON.stringify(b);
      })
      .join("\n");
  }
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    if (content.type === "text" && typeof content.text === "string")
      return content.text;
    if (typeof content.text === "string") return content.text;
    if ("input" in content)
      return typeof content.input === "string"
        ? content.input
        : JSON.stringify(content.input);
    if ("output" in content)
      return typeof content.output === "string"
        ? content.output
        : JSON.stringify(content.output);
    return JSON.stringify(content);
  }
  return "";
}

function mapToolsAnthropicToOpenAI(tools: AnthropicTool[] = []): any[] {
  return (tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    },
  }));
}

/* --------- Token estimation (fallback) --------- */
function estimatePromptTokensFromAnthropic(
  b: AnthropicRequest,
  env: EnvConfig
): number {
  const TOK_PER_CHAR = tokensPerChar(env);
  const clamp = (n: number) => Math.max(0, Math.floor(n));
  const countTokensApprox = (text: string) =>
    clamp((text || "").length * TOK_PER_CHAR);

  let pieces: string[] = [];
  if (b.system) pieces.push(extractText(b.system));
  for (const m of b.messages || []) {
    const role = m.role || "user";
    const c = m.content;
    if (Array.isArray(c)) {
      for (const blok of c) {
        if (blok?.type === "text")
          pieces.push(
            typeof blok.text === "string"
              ? blok.text
              : JSON.stringify(blok.text)
          );
        if (role === "user" && blok?.type === "tool_result") {
          const out = blok.output ?? blok.content ?? "";
          pieces.push(typeof out === "string" ? out : JSON.stringify(out));
        }
      }
    } else {
      pieces.push(extractText(c));
    }
  }
  return countTokensApprox(pieces.join("\n"));
}

function estimateOutputTokensFromText(text: string, env: EnvConfig): number {
  const TOK_PER_CHAR = tokensPerChar(env);
  const clamp = (n: number) => Math.max(0, Math.floor(n));
  return clamp(String(text || "").length * TOK_PER_CHAR);
}

/* --------- Build OR payload (messages + tools + usage.include) --------- */
function toOpenRouterPayload(
  b: AnthropicRequest,
  request: Request,
  env: EnvConfig,
  mapModel: (id: string) => string
): any {
  const messagesOut: any[] = [];
  const toolsOA = mapToolsAnthropicToOpenAI(b.tools || []);

  if (b.system)
    messagesOut.push({ role: "system", content: extractText(b.system) });

  for (const m of b.messages || []) {
    const role = m.role || "user";
    const content = m.content;

    if (Array.isArray(content)) {
      if (role === "assistant") {
        let assistantText = "";
        const tool_calls: any[] = [];
        for (const block of content) {
          if (!block) continue;
          if (block.type === "text") {
            const t =
              typeof block.text === "string"
                ? block.text
                : JSON.stringify(block.text);
            assistantText += t + "\n";
          } else if (block.type === "tool_use") {
            const callId = block.id || crypto.randomUUID();
            const name = block.name || "tool";
            const args = block.input ?? {};
            tool_calls.push({
              id: callId,
              type: "function",
              function: {
                name,
                arguments:
                  typeof args === "string" ? args : JSON.stringify(args),
              },
            });
          } else {
            assistantText += JSON.stringify(block) + "\n";
          }
        }
        const assistantMsg: any = { role: "assistant" };
        if (assistantText.trim()) assistantMsg.content = assistantText.trim();
        if (tool_calls.length) assistantMsg.tool_calls = tool_calls;
        if (assistantMsg.content || assistantMsg.tool_calls)
          messagesOut.push(assistantMsg);
      } else if (role === "user") {
        let userText = "";
        const pendingToolMsgs: any[] = [];
        for (const block of content) {
          if (!block) continue;
          if (block.type === "text") {
            const t =
              typeof block.text === "string"
                ? block.text
                : JSON.stringify(block.text);
            userText += t + "\n";
          } else if (block.type === "tool_result") {
            const tool_call_id =
              block.tool_use_id || block.id || crypto.randomUUID();
            const output = block.output ?? block.content ?? "";
            const toolContent =
              typeof output === "string" ? output : JSON.stringify(output);
            pendingToolMsgs.push({
              role: "tool",
              tool_call_id,
              content: toolContent,
            });
          } else {
            userText += JSON.stringify(block) + "\n";
          }
        }

        let prevAssistantIdx = -1;
        for (let i = messagesOut.length - 1; i >= 0; i--) {
          const mprev = messagesOut[i];
          if (
            mprev.role === "assistant" &&
            Array.isArray(mprev.tool_calls) &&
            mprev.tool_calls.length > 0
          ) {
            prevAssistantIdx = i;
            break;
          } else if (mprev.role !== "tool" && mprev.role !== "assistant") {
            break;
          }
        }

        if (pendingToolMsgs.length && prevAssistantIdx >= 0) {
          const prevAssistant = messagesOut[prevAssistantIdx];
          const toolIds = (prevAssistant.tool_calls || [])
            .map((tc: any) => tc.id)
            .filter(Boolean);
          const idToName = new Map(
            (prevAssistant.tool_calls || []).map((tc: any) => [
              tc.id,
              tc.function?.name || "tool",
            ])
          );

          const validById = new Map();
          const invalidTools: any[] = [];
          for (const tm of pendingToolMsgs) {
            if (toolIds.includes(tm.tool_call_id)) {
              validById.set(tm.tool_call_id, {
                role: "tool",
                tool_call_id: tm.tool_call_id,
                name: idToName.get(tm.tool_call_id) || "tool",
                content: tm.content,
              });
            } else {
              invalidTools.push(tm);
            }
          }
          const orderedValidTools = toolIds
            .filter((id: string) => validById.has(id))
            .map((id: string) => validById.get(id));

          if (orderedValidTools.length) {
            messagesOut.splice(prevAssistantIdx + 1, 0, ...orderedValidTools);
          }

          if (invalidTools.length) {
            const folded =
              "\n\n[tool_result]\n" +
              invalidTools
                .map((t) => `id=${t.tool_call_id} content=${t.content}`)
                .join("\n");
            userText += folded;
          }

          continue;
        }

        const trimmed = (userText || "").trim();
        if (trimmed) {
          messagesOut.push({ role: "user", content: trimmed });
        }
      }
    }
  }

  // Post-normalization
  for (let i = 0; i < messagesOut.length; i++) {
    const m = messagesOut[i];
    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      const toolIds = new Set(
        m.tool_calls.map((tc: any) => tc.id).filter(Boolean)
      );
      let j = i + 1;
      const usersToRemove: number[] = [];
      let seenTools = 0;
      while (j < messagesOut.length) {
        const mj = messagesOut[j];
        if (mj.role === "tool" && toolIds.has(mj.tool_call_id)) {
          seenTools++;
          j++;
          continue;
        }
        if (mj.role === "user" && seenTools === 0) {
          usersToRemove.push(j);
          j++;
          continue;
        }
        break;
      }
      for (let k = usersToRemove.length - 1; k >= 0; k--) {
        messagesOut.splice(usersToRemove[k], 1);
      }
    }
  }

  const reqModel = b.model || "anthropic/claude-3.7-sonnet";
  const mappedModel = mapModel(reqModel);

  const out: any = {
    model: mappedModel,
    messages: messagesOut,
    temperature: b.temperature ?? 0.2,
    max_tokens: b.max_tokens ?? 1024,
    usage: { include: true },
  };
  if (toolsOA.length) out.tools = toolsOA;

  if ((reqModel || "").includes(":thinking")) {
    out.reasoning = { effort: env.REASONING_EFFORT || "medium" };
  }

  const overrideModel = header(request, "x-or-model") || "";
  if (overrideModel) out.model = overrideModel.trim();

  const PRIMARY_MODEL = (env.PRIMARY_MODEL || "").trim();
  if (PRIMARY_MODEL) out.model = PRIMARY_MODEL;

  const passthroughKeys = [
    "plugins",
    "transforms",
    "web_search_options",
    "models",
    "provider",
    "reasoning",
    "usage",
    "top_p",
    "top_k",
    "frequency_penalty",
    "presence_penalty",
    "repetition_penalty",
    "seed",
    "logit_bias",
    "response_format",
    "user",
  ];
  for (const k of passthroughKeys) {
    if (b[k] !== undefined) out[k] = b[k];
  }

  return out;
}

/* --------- OR -> Anthropic (message + usage mapping) --------- */
function toAnthropicResponse(
  orjson: any,
  payload: any,
  durationMs: number,
  env: EnvConfig,
  mapModel: (id: string) => string,
  inputTokensEstimate: number
): { out: any; headers: Record<string, string> } {
  const choice = (orjson.choices && orjson.choices[0]) || {};
  const msg = choice.message || {};
  const content = msg.content ?? "";
  const tool_calls = msg.tool_calls || [];

  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
      ? content
          .map((c) => (typeof c === "string" ? c : JSON.stringify(c)))
          .join("\n")
      : JSON.stringify(content);

  const toolUseBlocks = tool_calls.map((tc: any) => {
    const id = tc.id || crypto.randomUUID();
    const name = tc.function?.name || "tool";
    let argsRaw = tc.function?.arguments;
    let input;
    try {
      input = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw || {};
    } catch {
      input = { _raw: argsRaw };
    }
    return { type: "tool_use", id, name, input };
  });

  const blocks: any[] = [];
  if (text && String(text).trim())
    blocks.push({ type: "text", text: String(text) });
  for (const b of toolUseBlocks) blocks.push(b);

  const hasTools = toolUseBlocks.length > 0;

  let usageAnthropic = mapUsageFromOpenRouter(orjson.usage || {});
  if (
    shouldEstimateUsage(env) &&
    usageAnthropic.input_tokens === 0 &&
    usageAnthropic.output_tokens === 0
  ) {
    const outTokEst = estimateOutputTokensFromText(text, env);
    const inTokEst = inputTokensEstimate != null ? inputTokensEstimate : 0;
    usageAnthropic = {
      input_tokens: inTokEst,
      output_tokens: outTokEst,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }

  const modelUsedRaw = orjson.model || payload.model || "openrouter";
  const stableModel = mapModel(modelUsedRaw);

  const pricing = parseJSON(env.PRICING_JSON, {});
  const costUSD = computeCostUSD(usageAnthropic, stableModel, pricing);
  const totalTokens =
    usageAnthropic.input_tokens + usageAnthropic.output_tokens;
  const tps = totalTokens > 0 ? totalTokens / (durationMs / 1000) : null;

  const extraHeaders: Record<string, string> = {
    "X-OR-Model": stableModel,
    "X-OR-Prompt-Tokens": String(usageAnthropic.input_tokens),
    "X-OR-Completion-Tokens": String(usageAnthropic.output_tokens),
    "X-OR-Total-Tokens": String(totalTokens),
    "X-OR-Duration-MS": String(durationMs),
  };
  if (tps != null) extraHeaders["X-OR-TPS"] = String(tps.toFixed(1));
  if (typeof orjson.usage?.cost === "number") {
    extraHeaders["X-OR-Cost-Credits"] = String(orjson.usage.cost);
  }
  if (typeof orjson.usage?.cost_details?.upstream_inference_cost === "number") {
    extraHeaders["X-OR-Upstream-Cost"] = String(
      orjson.usage.cost_details.upstream_inference_cost
    );
  }
  if (costUSD) extraHeaders["X-OR-Cost-USD"] = String(costUSD.total.toFixed(6));

  console.log(
    `[USAGE] model=${stableModel} in=${usageAnthropic.input_tokens} out=${usageAnthropic.output_tokens}` +
      (typeof orjson.usage?.cost === "number"
        ? ` cost_credits=${orjson.usage.cost}`
        : ``) +
      (costUSD ? ` cost_usd~$${costUSD.total.toFixed(6)}` : ``) +
      (tps ? ` tps=${tps.toFixed(1)}` : ``) +
      ` dur=${durationMs}ms`
  );

  const out = {
    id: orjson.id || "or_" + Math.random().toString(36).slice(2),
    type: "message",
    role: "assistant",
    model: stableModel,
    content: blocks.length ? blocks : [{ type: "text", text: "" }],
    stop_reason: hasTools ? "tool_use" : "end_turn",
    usage: usageAnthropic,
  };

  return { out, headers: extraHeaders };
}

/* ========================= HTTP Utils ========================= */

function json(
  obj: any,
  status = 200,
  extraHeaders: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function withCORS(resp: Response): Response {
  const h = new Headers(resp.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "POST, GET, OPTIONS");
  h.set(
    "access-control-allow-headers",
    "content-type, x-api-key, anthropic-api-key, anthropic-version, proxy-token, x-or-model"
  );
  h.set("anthropic-version", "2023-06-01");
  return new Response(resp.body, { status: resp.status, headers: h });
}

async function timedFetch(
  url: string,
  options: RequestInit,
  env: EnvConfig
): Promise<Response> {
  const timeoutMs = Number(env.TIMEOUT_MS || 180000);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(t);
    return r;
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

/* ========================= Usage/Cost mapping ========================= */

function mapUsageFromOpenRouter(orUsage: OpenRouterUsage = {}): Usage {
  const inTok = Number(orUsage.prompt_tokens ?? orUsage.input_tokens ?? 0);
  const outTok = Number(
    orUsage.completion_tokens ?? orUsage.output_tokens ?? 0
  );
  const cached = Number(orUsage.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    input_tokens: inTok,
    output_tokens: outTok,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

function computeCostUSD(
  usageAnthropic: Usage,
  model: string,
  pricing: any
): { total: number; inCost: number; outCost: number } | null {
  const p = pricing?.[model];
  if (!p) return null;
  const inTok = usageAnthropic.input_tokens || 0;
  const outTok = usageAnthropic.output_tokens || 0;
  const inCost = (inTok / 1000) * (p.in || 0);
  const outCost = (outTok / 1000) * (p.out || 0);
  return { total: inCost + outCost, inCost, outCost };
}
