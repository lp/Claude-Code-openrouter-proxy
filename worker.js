export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ ok: true });
    }
    if (request.method === "OPTIONS") {
      return cors();
    }
    if (request.method !== "POST" || url.pathname !== "/v1/messages") {
      return cors(json({ error: "not_found" }, 404));
    }

    // --- Auth modes ---
    // Mode BYOK: client envoie sa clé OpenRouter dans ANTHROPIC_API_KEY (recommandé)
    // Mode server key: on utilise env.OPENROUTER_API_KEY + on exige PROXY_TOKEN pour éviter l'abus
    const headers = Object.fromEntries(request.headers);
    const clientKey = headers["x-api-key"] || headers["anthropic-api-key"] || "";
    const proxyToken = headers["proxy-token"] || "";
    let orKey = "";

    if (clientKey && clientKey.startsWith("sk-or-")) {
      orKey = clientKey; // BYOK
    } else {
      // Server key
      if (!env.OPENROUTER_API_KEY) {
        return cors(json({ error: "missing_server_key" }, 401));
      }
      if (env.REQUIRE_PROXY_TOKEN === "1" && proxyToken !== env.PROXY_TOKEN) {
        return cors(json({ error: "forbidden" }, 403));
      }
      orKey = env.OPENROUTER_API_KEY;
    }

    // Lecture body Anthropic
    let body;
    try {
      body = await request.json();
    } catch {
      return cors(json({ error: "invalid_json" }, 400));
    }

    // Mapping modèles Anthropic -> OpenRouter
    const MODEL_MAP = {
      "claude-3-5-haiku-20241022":  "anthropic/claude-3.5-haiku",
      "claude-3-7-sonnet-latest":   "anthropic/claude-3.7-sonnet",
      "claude-3-7-sonnet-20250219": "anthropic/claude-3.7-sonnet",
      "claude-3-opus-20240229":     "anthropic/claude-3-opus",
    };

    // Helpers
    const extractText = (content) => {
      if (Array.isArray(content)) {
        return content.map(b => {
          if (!b) return "";
          if (typeof b === "string") return b;
          if (b.type === "text" && typeof b.text === "string") return b.text;
          if (typeof b.text === "string") return b.text;
          if ("input" in b)  return typeof b.input  === "string" ? b.input  : JSON.stringify(b.input);
          if ("output" in b) return typeof b.output === "string" ? b.output : JSON.stringify(b.output);
          return JSON.stringify(b);
        }).join("\n");
      }
      if (typeof content === "string") return content;
      if (content && typeof content === "object") {
        if (content.type === "text" && typeof content.text === "string") return content.text;
        if (typeof content.text === "string") return content.text;
        if ("input" in content)  return typeof content.input  === "string" ? content.input  : JSON.stringify(content.input);
        if ("output" in content) return typeof content.output === "string" ? content.output : JSON.stringify(content.output);
        return JSON.stringify(content);
      }
      return "";
    };

    const mapToolsAnthropicToOpenAI = (tools = []) =>
      (tools || []).map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.input_schema || { type: "object", properties: {}, additionalProperties: true }
        }
      }));

    // ---- Anthropic -> OpenRouter payload (avec tools) ----
    const toOpenRouter = (b) => {
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
                assistantText += (typeof block.text === "string" ? block.text : JSON.stringify(block.text)) + "\n";
              } else if (block.type === "tool_use") {
                const callId = block.id || crypto.randomUUID();
                const name = block.name || "tool";
                const args = block.input ?? {};
                tool_calls.push({
                  id: callId,
                  type: "function",
                  function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) }
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
                userText += (typeof block.text === "string" ? block.text : JSON.stringify(block.text)) + "\n";
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

      const reqModel   = b.model || "anthropic/claude-3.7-sonnet";
      const mappedModel= MODEL_MAP[reqModel] || reqModel;

      const out = {
        model: mappedModel,
        messages: messagesOut,
        temperature: b.temperature ?? 0.2,
        max_tokens: b.max_tokens ?? 1024
      };
      if (toolsOA.length) out.tools = toolsOA;
      if ((reqModel || "").includes(":thinking")) {
        out.reasoning = { effort: env.REASONING_EFFORT || "medium" };
      }
      return out;
    };

    // ---- OpenRouter -> Anthropic (avec tool_use) ----
    const toAnthropic = (orjson) => {
      const choice = (orjson.choices && orjson.choices[0]) || {};
      const msg = choice.message || {};
      const content = msg.content ?? "";
      const tool_calls = msg.tool_calls || [];

      const text =
        typeof content === "string" ? content :
        Array.isArray(content) ? content.map(c => (typeof c === "string" ? c : JSON.stringify(c))).join("\n") :
        JSON.stringify(content);

      const toolUseBlocks = tool_calls.map(tc => {
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
      return {
        id: orjson.id || "or_" + Math.random().toString(36).slice(2),
        type: "message",
        role: "assistant",
        model: orjson.model || "openrouter",
        content: blocks.length ? blocks : [{ type: "text", text: "" }],
        stop_reason: hasTools ? "tool_use" : "end_turn",
        usage: orjson.usage || {}
      };
    };

    // Logs simples
    try {
      const inModel = body?.model || "(unset)";
      console.log(`[IN] model=${inModel}`);
      const payload = toOpenRouter(body);

      const resp = await timedFetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${orKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "public-proxy",
          "X-Title": "ClaudeCode via OpenRouter"
        },
        body: JSON.stringify(payload)
      }, env);

      const data = await resp.json();
      if (!resp.ok) {
        console.log(`[OUT] status=${resp.status}`);
        return cors(json(data, resp.status));
      }
      const out = toAnthropic(data);
      console.log(`[OUT] status=200`);
      return cors(json(out, 200));
    } catch (e) {
      console.log(`[ERR] ${String(e)}`);
      return cors(json({ error: "gateway_error", detail: String(e) }, 504));
    }
  }
};

// --- utils ---
function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      ...extraHeaders
    }
  });
}

function cors(resp = new Response(null, { status: 204 })) {
  const h = new Headers(resp.headers);
  h.set("access-control-allow-origin", "*");
  h.set("access-control-allow-methods", "POST, GET, OPTIONS");
  h.set("access-control-allow-headers", "content-type, x-api-key, anthropic-api-key, anthropic-version, proxy-token");
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
