export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return withCORS(json({ ok: true }));
    }
    if (request.method === "OPTIONS") {
      return withCORS(new Response(null, { status: 204 }));
    }
    if (request.method !== "POST" || url.pathname !== "/v1/messages") {
      return withCORS(json({ error: "not_found" }, 404));
    }

    // ---------- Auth ----------
    // BYOK (client fournit sa clé OpenRouter dans ANTHROPIC_API_KEY / X-API-Key)
    // ou clé serveur (OPENROUTER_API_KEY) protégée avec PROXY_TOKEN si REQUIRE_PROXY_TOKEN=1
    const clientKey = header(request, "anthropic-api-key") || header(request, "x-api-key") || "";
    const proxyToken = header(request, "proxy-token") || "";
    let orKey = "";

    if (clientKey && clientKey.startsWith("sk-or-")) {
      orKey = clientKey;
    } else {
      if (!env.OPENROUTER_API_KEY) {
        return withCORS(json({ error: "missing_server_key" }, 401));
      }
      if (String(env.REQUIRE_PROXY_TOKEN || "0") === "1" && proxyToken !== env.PROXY_TOKEN) {
        return withCORS(json({ error: "forbidden" }, 403));
      }
      orKey = env.OPENROUTER_API_KEY;
    }

    // ---------- Lecture du body ----------
    let body;
    try {
      body = await request.json();
    } catch {
      return withCORS(json({ error: "invalid_json" }, 400));
    }

    // ---------- Mapping modèles ----------
    const MODEL_MAP_BASE = {
      "claude-3-5-haiku-20241022": "anthropic/claude-3.5-haiku",
      "claude-3-7-sonnet-latest":  "anthropic/claude-3.7-sonnet",
      "claude-3-7-sonnet-20250219":"anthropic/claude-3.7-sonnet",
      "claude-3-opus-20240229":    "anthropic/claude-3-opus",
    };

    // Extension/override via env JSON
    const MODEL_MAP_EXT = parseJSON(env.MODEL_MAP_EXT, {});
    const FORCE_MODEL   = (env.FORCE_MODEL || "").trim();
    function mapModel(id) {
      if (FORCE_MODEL) return FORCE_MODEL;
      if (MODEL_MAP_EXT[id]) return MODEL_MAP_EXT[id];
      if (MODEL_MAP_BASE[id]) return MODEL_MAP_BASE[id];
      return id;
    }

    // ---------- Helpers payload ----------
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
      // Anthropic: [{name, description, input_schema}]
      // OpenAI:    [{type:"function", function:{name, description, parameters}}]
      return (tools || []).map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || { type: "object", properties: {}, additionalProperties: true },
        },
      }));
    }

    // ---------- Build payload OpenRouter (bridge tools) ----------
    function toOpenRouterPayload(b) {
      const messagesOut = [];
      const toolsOA = mapToolsAnthropicToOpenAI(b.tools || []);

      // system
      if (b.system) {
        messagesOut.push({ role: "system", content: extractText(b.system) });
      }

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
            let userText = "";
            for (const block of content) {
              if (!block) continue;
              if (block.type === "text") {
                const t = typeof block.text === "string" ? block.text : JSON.stringify(block.text);
                userText += t + "\n";
              } else if (block.type === "tool_result") {
                const tool_call_id = block.tool_use_id || block.id || crypto.randomUUID();
                const output = block.output ?? block.content ?? "";
                const toolContent = typeof output === "string" ? output : JSON.stringify(output);
                messagesOut.push({ role: "tool", tool_call_id, content: toolContent });
              } else {
                userText += JSON.stringify(block) + "\n";
              }
            }
            if (userText.trim()) messagesOut.push({ role: "user", content: userText.trim() });
          } else {
            messagesOut.push({ role, content: extractText(content) });
          }
        } else {
          messagesOut.push({ role, content: extractText(content) });
        }
      }

      const reqModel    = b.model || "anthropic/claude-3.7-sonnet";
      const mappedModel = mapModel(reqModel);

      const out = {
        model: mappedModel,
        messages: messagesOut,
        temperature: b.temperature ?? 0.2,
        max_tokens: b.max_tokens ?? 1024,
      };
      if (toolsOA.length) out.tools = toolsOA;

      // Reasoning basique si :thinking
      if ((reqModel || "").includes(":thinking")) {
        out.reasoning = { effort: env.REASONING_EFFORT || "medium" };
      }

      // Override ponctuel par header (pour tests)
      const overrideModel = header(request, "x-or-model") || "";
      if (overrideModel) out.model = overrideModel.trim();

      // Force/fallback via env
      const PRIMARY_MODEL  = (env.PRIMARY_MODEL  || "").trim();
      if (PRIMARY_MODEL) out.model = PRIMARY_MODEL;

      return out;
    }

    // ---------- OpenRouter -> Anthropic (bridge tools + usage) ----------
    function toAnthropicResponse(orjson, payload, durationMs, env) {
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

      // Usage -> format Anthropic
      const usageAnthropic = mapUsageForAnthropic(orjson.usage || {});
      const modelUsedRaw = orjson.model || payload.model || "openrouter";
      const stableModel  = mapModel(modelUsedRaw);

      // Pricing / headers meta
      const pricing = parseJSON(env.PRICING_JSON, {});
      const cost    = computeCostUSD(usageAnthropic, stableModel, pricing);
      const totalTokens = usageAnthropic.input_tokens + usageAnthropic.output_tokens;
      const tps = totalTokens > 0 ? totalTokens / (durationMs / 1000) : null;

      // Headers additionnels
      const extraHeaders = {
        "X-OR-Model": stableModel,
        "X-OR-Prompt-Tokens": String(usageAnthropic.input_tokens),
        "X-OR-Completion-Tokens": String(usageAnthropic.output_tokens),
        "X-OR-Total-Tokens": String(totalTokens),
        "X-OR-Duration-MS": String(durationMs),
      };
      if (tps != null) extraHeaders["X-OR-TPS"] = String(tps.toFixed(1));
      if (cost) extraHeaders["X-OR-Cost-USD"] = String(cost.total.toFixed(6));

      // Log sympa
      console.log(
        `[USAGE] model=${stableModel} in=${usageAnthropic.input_tokens} out=${usageAnthropic.output_tokens}` +
        (cost ? ` cost~$${cost.total.toFixed(6)}` : ``) +
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
          usage: {
            prompt_tokens: usageAnthropic.input_tokens,
            completion_tokens: usageAnthropic.output_tokens,
            total_tokens: totalTokens,
          },
          duration_ms: durationMs,
          tps: tps != null ? Number(tps.toFixed(2)) : null,
          cost_usd: cost ? Number(cost.total.toFixed(6)) : null,
        },
      };

      return { out, headers: extraHeaders };
    }

    // ---------- Appel OpenRouter avec timeout + fallback optionnel ----------
    const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
    const t0 = Date.now();
    const payload = toOpenRouterPayload(body);

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

    // Fallback si 429/5xx et FALLBACK_MODEL défini
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

    const { out, headers } = toAnthropicResponse(data, payload, durationMs, env);
    return withCORS(json(out, 200, headers));
  }
};

// ------------- Utils -------------
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

function mapUsageForAnthropic(orUsage = {}) {
  // OpenRouter peut renvoyer prompt_tokens/completion_tokens OU input_tokens/output_tokens
  const inTok  = Number(orUsage.prompt_tokens ?? orUsage.input_tokens ?? 0);
  const outTok = Number(orUsage.completion_tokens ?? orUsage.output_tokens ?? 0);
  const cacheCreate = Number(orUsage.cache_creation_input_tokens ?? 0);
  const cacheRead   = Number(orUsage.cache_read_input_tokens ?? 0);

  return {
    input_tokens: inTok,
    output_tokens: outTok,
    cache_creation_input_tokens: cacheCreate,
    cache_read_input_tokens: cacheRead,
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

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
  });
}

function withCORS(resp) {
  const h = new Headers(resp.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "POST, GET, OPTIONS");
  h.set("access-control-allow-headers", "content-type, x-api-key, anthropic-api-key, anthropic-version, proxy-token, x-or-model");
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
