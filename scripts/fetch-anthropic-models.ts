#!/usr/bin/env bun

/**
 * Utility script to fetch all available Anthropic models from OpenRouter
 * and generate a model mapping configuration
 */

interface OpenRouterModel {
  id: string;
  name: string;
  created: number;
  description?: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
    request?: string;
    image?: string;
  };
  top_provider?: {
    context_length: number;
    max_completion_tokens: number;
    is_moderated: boolean;
  };
  per_request_limits?: {
    prompt_tokens?: string;
    completion_tokens?: string;
  };
}

interface OpenRouterResponse {
  data: OpenRouterModel[];
}

async function fetchAnthropicModels(): Promise<void> {
  console.log("🔍 Fetching models from OpenRouter API...\n");

  try {
    const response = await fetch("https://openrouter.ai/api/v1/models");

    if (!response.ok) {
      throw new Error(
        `Failed to fetch models: ${response.status} ${response.statusText}`
      );
    }

    const data: OpenRouterResponse = await response.json();

    // Filter for Anthropic models
    const anthropicModels = data.data.filter(
      (model) =>
        model.id.toLowerCase().includes("anthropic") ||
        model.id.toLowerCase().includes("claude")
    );

    console.log(`✅ Found ${anthropicModels.length} Anthropic models:\n`);

    // Sort by name
    anthropicModels.sort((a, b) => a.id.localeCompare(b.id));

    // Display models in a table format
    console.log(
      "┌─────────────────────────────────────────────────────────────────────────┐"
    );
    console.log(
      "│ Available Anthropic Models on OpenRouter                               │"
    );
    console.log(
      "├─────────────────────────────────────────────────────────────────────────┤"
    );

    for (const model of anthropicModels) {
      const promptPrice = parseFloat(model.pricing.prompt);
      const completionPrice = parseFloat(model.pricing.completion);
      const contextLength = model.context_length.toLocaleString();

      console.log(`│ ${model.id.padEnd(45)} │`);
      console.log(
        `│   Context: ${contextLength.padEnd(
          15
        )} Prompt: $${promptPrice.toFixed(6)}/1K │`
      );
      console.log(
        `│   Completion: $${completionPrice.toFixed(6)}/1K${" ".repeat(38)}│`
      );
      console.log(
        "├─────────────────────────────────────────────────────────────────────────┤"
      );
    }

    console.log(
      "└─────────────────────────────────────────────────────────────────────────┘\n"
    );

    // Generate MODEL_MAP_EXT configuration
    console.log("📝 Generated model-map.json (ALL Anthropic models):\n");

    const modelMap: Record<string, string> = {};

    // Include ALL Anthropic models in the mapping
    for (const model of anthropicModels) {
      // Map the full OpenRouter ID to itself (pass-through)
      modelMap[model.id] = model.id;

      // Also create short-name mappings (without anthropic/ prefix)
      const shortName = model.id.replace(/^anthropic\//, "");
      if (shortName !== model.id) {
        modelMap[shortName] = model.id;
      }

      // Create additional base name mappings for dated versions
      // e.g., "claude-3.5-sonnet" maps to "anthropic/claude-3.5-sonnet-20240620"
      const match = model.id.match(
        /anthropic\/(claude-[\d\.]+-[\w]+?)(-\d{8})?$/
      );
      if (match) {
        const baseName = match[1];
        // Only map if this is the first (likely latest) version we encounter
        if (!modelMap[baseName]) {
          modelMap[baseName] = model.id;
        }
      }
    }

    console.log("```json");
    console.log(JSON.stringify(modelMap, null, 2));
    console.log("```\n");
    console.log(`✅ Mapped ${Object.keys(modelMap).length} model variations\n`);

    // Generate PRICING_JSON configuration
    console.log("💰 Suggested PRICING_JSON configuration:\n");

    const pricingMap: Record<string, { in: number; out: number }> = {};

    for (const model of anthropicModels) {
      pricingMap[model.id] = {
        in: parseFloat(model.pricing.prompt) * 1000, // Convert to per-1K tokens
        out: parseFloat(model.pricing.completion) * 1000,
      };
    }

    console.log("```json");
    console.log(JSON.stringify(pricingMap, null, 2));
    console.log("```\n");

    // Save to files
    await Bun.write(
      "./anthropic-models.json",
      JSON.stringify(anthropicModels, null, 2)
    );
    await Bun.write("./model-map.json", JSON.stringify(modelMap, null, 2));
    await Bun.write("./pricing.json", JSON.stringify(pricingMap, null, 2));

    console.log("💾 Saved to files:");
    console.log("   - anthropic-models.json (full model list)");
    console.log("   - model-map.json (MODEL_MAP_EXT configuration)");
    console.log("   - pricing.json (PRICING_JSON configuration)\n");

    console.log(
      "🎉 Done! You can now update your .env file with these configurations."
    );
  } catch (error) {
    console.error("❌ Error fetching models:", error);
    process.exit(1);
  }
}

// Run the script
fetchAnthropicModels();
