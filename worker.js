export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health & CORS preflight
    if (url.pathname === "/health") return withCORS(json({ ok: true }));
    if (request.method === "OPTIONS") return withCORS(new Response(null, { status: 204 }));

    // ---- Count tokens endpoint (Anthropic-compatible) ----
    if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      try {
        const body = await request.json();
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
    const clientKey = header(request, "anthropic-api-key") || header(request, "x-api-key") || "";
    const proxyToken = header(request, "proxy-token") || "";
    let orKey = "";
    if (clientKey && clientKey.startsWith("sk-or-")) {
      orKey = clientKey; // BYOK
    } else {
      if (!env.OPENROUTER_API_KEY) return withCORS(json({ error: "missing_server_key" }, 401));
      if (String(env.REQUIRE_PROXY_TOKEN || "0") === "1" && proxyToken !== env.PROXY_TOKEN) {
        return withCORS(json({ error: "forbidden" }, 403));
      }
      orKey = env.OPENROUTER_API_KEY;
    }

    // ---------- Body ----------
    let body;
    try { body = await request.json(); }
    catch { return withCORS(json({ error: "invalid_json" }, 400)); }

    // ---------- Model mapping ----------
    // "$modeldemandé" => on laisse passer tel quel (pas de remap)
    const MODEL_MAP_BASE = {
      "claude-3-5-haiku-20241022": "$modeldemandé",
      "claude-3-7-sonnet-latest":  "$modeldemandé",
      "claude-3-7-sonnet-20250219":"$modeldemandé",
      "claude-3-opus-20240229":    "$modeldemandé",
    };
    const MODEL_MAP_EXT = parseJSON(env.MODEL_MAP_EXT, {});
    const FORCE_MODEL   = (env.FORCE_MODEL || "").trim();

    function mapModel(id) {
      if (FORCE_MODEL) return FORCE_MODEL;
      if (MODEL_MAP_EXT[id]) return MODEL_MAP_EXT[id];
      if (MODEL_MAP_BASE[id] === "$modeldemandé") return id;  // laisser passer tel quel
      if (MODEL_MAP_BASE[id]) return MODEL_MAP_BASE[id];
      return id;
    }

    // ---- STREAM BRANCH (SSE) ----
    const accept = request.headers.get("accept") || "";
    const wantsStream = accept.includes("text/event-stream") || (body && body.stream === true);
    if (wantsStream) {
      const payload = toOpenRouterPayload(body, request, env, mapModel);
      payload.stream = true;                 // stream OpenRouter
      payload.usage  = { include: true };    // demander l'usage

      const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
      const orResp = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${orKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "public-proxy",
          "X-Title": "ClaudeCode via OpenRouter",
        },
        body: JSON.stringify(payload),
      });

      if (!orResp.ok || !orResp.body) {
        const err = await orResp.text().catch(() => "");
        return withCORS(new Response(err || "upstream_error", { status: orResp.status || 502 }));
      }

      const encoder = new TextEncoder();
      const readable = new ReadableStream({
        start(controller) {
          const reader = orResp.body.getReader();
          const sendEvent = (name, obj) => {
            controller.enqueue(encoder.encode(`event: ${name}\n`));
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          };

          // (optionnel) amorce compatible Anthropic
          sendEvent("message_start", { type: "message_start" });

          (async () => {
            const dec = new TextDecoder();
            let buf = "";
            let lastUsage = null;

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

                let obj;
                try { obj = JSON.parse(jsonLine); } catch { continue; }

                // Texte incrémental
                const delta = obj?.choices?.[0]?.delta?.content;
                if (typeof delta === "string" && delta.length) {
                  sendEvent("content_block_delta", {
                    type: "content_block_delta",
                    delta: { type: "text_delta", text: delta }
                  });
                }

                // Usage final OR (souvent dans le dernier chunk)
                if (obj?.usage) {
                  lastUsage = obj.usage;
                }
              }
            }

            // Injecte usage dans message_delta final (ce que la CLI lit)
            if (lastUsage) {
              const u = mapUsageFromOpenRouter(lastUsage);
              sendEvent("message_delta", { type: "message_delta", delta: { usage: u } });
            }

            // Fin
            sendEvent("message_stop", { type: "message_stop" });
            controller.close();
          })().catch((e) => controller.error(e));
        }
      });

      return new Response(readable, {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          "connection": "keep-alive",
          "transfer-encoding": "chunked",
          "anthropic-version": "2023-06-01",
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, GET, OPTIONS",
          "access-control-allow-headers": "content-type, x-api-key, anthropic-api-key, anthropic-version, proxy-token, x-or-model"
        }
      });
    }

    // ---- NON-STREAM branch ----
    const payload = toOpenRouterPayload(body, request, env, mapModel);
    const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
    const t0 = Date.now();

    let resp = await timedFetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${orKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "public-proxy",
        "X-Title": "ClaudeCode via OpenRouter",
      },
      body: JSON.stringify(payload),
    }, env);

    // Fallback si 429/5xx
    if (!resp.ok) {
      const status = resp.status;
      const FALLBACK_MODEL = (env.FALLBACK_MODEL || "").trim();
      if ((status === 429 || (status >= 500 && status <= 599)) && FALLBACK_MODEL) {
        const p2 = { ...payload, model: FALLBACK_MODEL };
        resp = await timedFetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${orKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "public-proxy",
            "X-Title": "ClaudeCode via OpenRouter",
          },
          body: JSON.stringify(p2),
        }, env);
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

    const { out, headers } = toAnthropicResponse(data, payload, durationMs, env, mapModel, inputTokensEstimate);
    return withCORS(json(out, 200, headers));
  }
};

/* ========================= Helpers & Mappers ========================= */

function header(request, key) {
  return request.headers.get(key) || request.headers.get(key.toLowerCase()) || "";
}

function parseJSON(raw, fallback) {
  try {
    const t = (raw || "").trim();
    return t ? JSON.parse(t) : fallback;
  } catch {
    return fallback;
  }
}

function shouldEstimateUsage(env) {
  return String(env.ESTIMATE_USAGE || "1") === "1";
}

function tokensPerChar(env) {
  const v = Number(env.ESTIMATE_TOKENS_PER_CHAR || 0.25);
  return Number.isFinite(v) && v > 0 ? v : 0.25; // ≈ 4 chars/token
}

function extractText(content) {
  if (Array.isArray(content)) {
    return content.map((b) => {
      if (!b) return "";
      if (typeof b === "string") return b;
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (typeof b.text === "string") return b.text;
      if ("input" in b)  return typeof b.input === "string" ? b.input : JSON.stringify(b.input);
      if ("output" in b) return typeof b.output === "string" ? b.output : JSON.stringify(b.output);
      return JSON.stringify(b);
    }).join("\n");
  }
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    if (content.type === "text" && typeof content.text === "string") return content.text;
    if (typeof content.text === "string") return content.text;
    if ("input" in content)  return typeof content.input === "string" ? content.input : JSON.stringify(content.input);
    if ("output" in content) return typeof content.output === "string" ? content.output : JSON.stringify(content.output);
    return JSON.stringify(content);
  }
  return "";
}

function mapToolsAnthropicToOpenAI(tools = []) {
  return (tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {}, additionalProperties: true },
    },
  }));
}

/* --------- Token estimation (fallback) --------- */
function estimatePromptTokensFromAnthropic(b, env) {
  const TOK_PER_CHAR = tokensPerChar(env || {});
  const clamp = (n) => Math.max(0, Math.floor(n));
  const countTokensApprox = (text) => clamp((text || "").length * TOK_PER_CHAR);

  let pieces = [];
  if (b.system) pieces.push(extractText(b.system));
  for (const m of (b.messages || [])) {
    const role = m.role || "user";
    const c = m.content;
    if (Array.isArray(c)) {
      for (const blok of c) {
        if (blok?.type === "text") pieces.push(typeof blok.text === "string" ? blok.text : JSON.stringify(blok.text));
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

function estimateOutputTokensFromText(text, env) {
  const TOK_PER_CHAR = tokensPerChar(env || {});
  const clamp = (n) => Math.max(0, Math.floor(n));
  return clamp(String(text || "").length * TOK_PER_CHAR);
}

/* --------- Build OR payload (messages + tools + usage.include) --------- */
function toOpenRouterPayload(b, request, env, mapModel) {
  const messagesOut = [];
  const toolsOA = mapToolsAnthropicToOpenAI(b.tools || []);

  if (b.system) messagesOut.push({ role: "system", content: extractText(b.system) });

  for (const m of (b.messages || [])) {
    const role = m.role || "user";
    const content = m.content;

    if (Array.isArray(content)) {
      if (role === "assistant") {
        let assistantText = "";
        const tool_calls = [];
        for (const block of content) {
          if (!block) continue;
          if (block.type === "text") {
            const t = typeof block.text === "string" ? block.text : JSON.stringify(block.text);
            assistantText += t + "\n";
          } else if (block.type === "tool_use") {
            const callId = block.id || crypto.randomUUID();
            const name = block.name || "tool";
            const args = block.input ?? {};
            tool_calls.push({
              id: callId,
              type: "function",
              function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
            });
          } else {
            assistantText += JSON.stringify(block) + "\n";
          }
        }
        const assistantMsg = { role: "assistant" };
        if (assistantText.trim()) assistantMsg.content = assistantText.trim();
        if (tool_calls.length) assistantMsg.tool_calls = tool_calls;
        if (assistantMsg.content || assistantMsg.tool_calls) messagesOut.push(assistantMsg);

      } else if (role === "user") {
        // Bufferiser le texte et les tool_result
        let userText = "";
        const pendingToolMsgs = [];
      
        for (const block of content) {
          if (!block) continue;
          if (block.type === "text") {
            const t = typeof block.text === "string" ? block.text : JSON.stringify(block.text);
            userText += t + "\n";
          } else if (block.type === "tool_result") {
            const tool_call_id = block.tool_use_id || block.id || crypto.randomUUID();
            const output = block.output ?? block.content ?? "";
            const toolContent = typeof output === "string" ? output : JSON.stringify(output);
            pendingToolMsgs.push({ role: "tool", tool_call_id, content: toolContent });
          } else {
            userText += JSON.stringify(block) + "\n";
          }
        }
      
        // Trouver l'assistant précédent qui a des tool_calls
        let prevAssistantIdx = -1;
        for (let i = messagesOut.length - 1; i >= 0; i--) {
          const mprev = messagesOut[i];
          if (mprev.role === "assistant" && Array.isArray(mprev.tool_calls) && mprev.tool_calls.length > 0) {
            prevAssistantIdx = i;
            break;
          } else if (mprev.role !== "tool" && mprev.role !== "assistant") {
            // on a croisé un autre type → plus de fenêtre valide
            break;
          }
        }
      
        if (pendingToolMsgs.length && prevAssistantIdx >= 0) {
          const prevAssistant = messagesOut[prevAssistantIdx];
          const toolIds = (prevAssistant.tool_calls || []).map(tc => tc.id).filter(Boolean);
          const idToName = new Map(
            (prevAssistant.tool_calls || []).map(tc => [tc.id, tc.function?.name || "tool"])
          );
      
          // Séparer valides/invalides + ordonner les valides comme l'assistant
          const validById = new Map();
          const invalidTools = [];
          for (const tm of pendingToolMsgs) {
            if (toolIds.includes(tm.tool_call_id)) {
              validById.set(tm.tool_call_id, {
                role: "tool",
                tool_call_id: tm.tool_call_id,
                name: idToName.get(tm.tool_call_id) || "tool",
                content: tm.content
              });
            } else {
              invalidTools.push(tm);
            }
          }
          const orderedValidTools = toolIds
            .filter(id => validById.has(id))
            .map(id => validById.get(id));
      
          // INSÉRER les tools IMMÉDIATEMENT APRES l'assistant (≠ push)
          if (orderedValidTools.length) {
            messagesOut.splice(prevAssistantIdx + 1, 0, ...orderedValidTools);
          }
      
          // Replier les invalides dans le texte du user
          if (invalidTools.length) {
            const folded =
              "\n\n[tool_result]\n" +
              invalidTools.map(t => `id=${t.tool_call_id} content=${t.content}`).join("\n");
            userText += folded;
          }
        }
      
        // N'émettre le user que s'il reste du texte utile
        const trimmed = (userText || "").trim();
        if (trimmed) {
          messagesOut.push({ role: "user", content: trimmed });
        }
      }
    }
  }

  const reqModel    = b.model || "anthropic/claude-3.7-sonnet";
  const mappedModel = mapModel(reqModel);

  const out = {
    model: mappedModel,
    messages: messagesOut,
    temperature: b.temperature ?? 0.2,
    max_tokens: b.max_tokens ?? 1024,
    usage: { include: true }, // usage accounting OpenRouter
  };
  if (toolsOA.length) out.tools = toolsOA;

  if ((reqModel || "").includes(":thinking")) {
    out.reasoning = { effort: env.REASONING_EFFORT || "medium" };
  }

  // Overrides
  const overrideModel = header(request, "x-or-model") || "";
  if (overrideModel) out.model = overrideModel.trim();

  const PRIMARY_MODEL  = (env.PRIMARY_MODEL  || "").trim();
  if (PRIMARY_MODEL) out.model = PRIMARY_MODEL;

  // ---- OpenRouter/OpenAI extras passthrough (enable "integrations") ----
  const passthroughKeys = [
    // OpenRouter features
    "plugins",               // e.g. [{ id: "web", max_results: 5, search_prompt: "..." }]
    "transforms",            // e.g. ["middle-out"]
    "web_search_options",    // e.g. { search_context_size: "high" }
    "models",                // routing overrides
    "provider",              // provider routing preferences
    "reasoning",             // reasoning tokens config
    "usage",                 // allow caller override
    // OpenAI-compatible extras commonly supported by OR
    "top_p","top_k","frequency_penalty","presence_penalty","repetition_penalty",
    "seed","logit_bias","response_format","user"
  ];
  for (const k of passthroughKeys) {
    if (b[k] !== undefined) out[k] = b[k];
  }

  return out;
}

/* --------- OR -> Anthropic (message + usage mapping) --------- */
function toAnthropicResponse(orjson, payload, durationMs, env, mapModel, inputTokensEstimate) {
  const choice = (orjson.choices && orjson.choices[0]) || {};
  const msg = choice.message || {};
  const content = msg.content ?? "";
  const tool_calls = msg.tool_calls || [];

  const text =
    typeof content === "string" ? content :
    Array.isArray(content) ? content.map(c => (typeof c === "string" ? c : JSON.stringify(c))).join("\n") :
    JSON.stringify(content);

  const toolUseBlocks = tool_calls.map((tc) => {
    const id = tc.id || crypto.randomUUID();
    const name = tc.function?.name || "tool";
    let argsRaw = tc.function?.arguments;
    let input;
    try { input = typeof argsRaw === "string" ? JSON.parse(argsRaw) : (argsRaw || {}); }
    catch { input = { _raw: argsRaw }; }
    return { type: "tool_use", id, name, input };
  });

  const blocks = [];
  if (text && String(text).trim()) blocks.push({ type: "text", text: String(text) });
  for (const b of toolUseBlocks) blocks.push(b);

  const hasTools = toolUseBlocks.length > 0;

  // Usage OR -> Anthropic
  let usageAnthropic = mapUsageFromOpenRouter(orjson.usage || {});
  if (shouldEstimateUsage(env) && usageAnthropic.input_tokens === 0 && usageAnthropic.output_tokens === 0) {
    const outTokEst = estimateOutputTokensFromText(text, env);
    const inTokEst  = inputTokensEstimate != null ? inputTokensEstimate : 0;
    usageAnthropic = {
      input_tokens: inTokEst,
      output_tokens: outTokEst,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
  }

  const modelUsedRaw = orjson.model || payload.model || "openrouter";
  const stableModel  = mapModel(modelUsedRaw);

  // Pricing (USD estimé) + meta headers
  const pricing = parseJSON(env.PRICING_JSON, {});
  const costUSD = computeCostUSD(usageAnthropic, stableModel, pricing);
  const totalTokens = usageAnthropic.input_tokens + usageAnthropic.output_tokens;
  const tps = totalTokens > 0 ? totalTokens / (durationMs / 1000) : null;

  const extraHeaders = {
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
    extraHeaders["X-OR-Upstream-Cost"] = String(orjson.usage.cost_details.upstream_inference_cost);
  }
  if (costUSD) extraHeaders["X-OR-Cost-USD"] = String(costUSD.total.toFixed(6));

  console.log(
    `[USAGE] model=${stableModel} in=${usageAnthropic.input_tokens} out=${usageAnthropic.output_tokens}` +
    (typeof orjson.usage?.cost === "number" ? ` cost_credits=${orjson.usage.cost}` : ``) +
    (costUSD ? ` cost_usd~$${costUSD.total.toFixed(6)}` : ``) +
    (tps ? ` tps=${tps.toFixed(1)}` : ``) + ` dur=${durationMs}ms`
  );

  const out = {
    id: orjson.id || "or_" + Math.random().toString(36).slice(2),
    type: "message",
    role: "assistant",
    model: stableModel,
    content: blocks.length ? blocks : [{ type: "text", text: "" }],
    stop_reason: hasTools ? "tool_use" : "end_turn",
    usage: usageAnthropic,
    proxy_meta: {
      model: stableModel,
      openrouter_usage: orjson.usage || null,
      usage: {
        prompt_tokens: usageAnthropic.input_tokens,
        completion_tokens: usageAnthropic.output_tokens,
        total_tokens: totalTokens,
      },
      duration_ms: durationMs,
      tps: tps != null ? Number(tps.toFixed(2)) : null,
      cost_usd: costUSD ? Number(costUSD.total.toFixed(6)) : null,
    },
  };

  return { out, headers: extraHeaders };
}

/* ========================= HTTP Utils ========================= */

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function withCORS(resp) {
  const h = new Headers(resp.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "POST, GET, OPTIONS");
  h.set("access-control-allow-headers", "content-type, x-api-key, anthropic-api-key, anthropic-version, proxy-token, x-or-model");
  h.set("anthropic-version", "2023-06-01"); // compat Claude Code
  return new Response(resp.body, { status: resp.status, headers: h });
}

async function timedFetch(url, options, env) {
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

function mapUsageFromOpenRouter(orUsage = {}) {
  // Champs OR fréquents:
  // prompt_tokens, completion_tokens
  // prompt_tokens_details.cached_tokens
  const inTok  = Number(orUsage.prompt_tokens ?? orUsage.input_tokens ?? 0);
  const outTok = Number(orUsage.completion_tokens ?? orUsage.output_tokens ?? 0);
  const cached = Number(orUsage.prompt_tokens_details?.cached_tokens ?? 0);
  return {
    input_tokens: inTok,
    output_tokens: outTok,
    cache_creation_input_tokens: 0, // OR ne fournit pas "cache write"
    cache_read_input_tokens: cached,
  };
}

function computeCostUSD(usageAnthropic, model, pricing) {
  const p = pricing?.[model];
  if (!p) return null;
  const inTok  = usageAnthropic.input_tokens  || 0;
  const outTok = usageAnthropic.output_tokens || 0;
  const inCost  = (inTok  / 1000) * (p.in  || 0);
  const outCost = (outTok / 1000) * (p.out || 0);
  return { total: inCost + outCost, inCost, outCost };
}