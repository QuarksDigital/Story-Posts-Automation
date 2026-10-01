// Provider-agnostic text generation. Swap providers with LLM_PROVIDER; nothing
// else in the system knows which one is in use.
import { settings } from "../config.js";
import { recordUsage } from "../db.js";
import { anthropicProvider } from "./anthropic.js";
import { openaiCompatibleProvider } from "./openai-compatible.js";
import { mockProvider } from "./mock.js";

// USD per 1M tokens [input, output]. Override with LLM_PRICE_IN / LLM_PRICE_OUT.
const PRICES = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

export function getProvider(name = settings.llm.provider) {
  switch (name) {
    case "anthropic":
      return anthropicProvider;
    case "openai":
      return openaiCompatibleProvider;
    case "mock":
      return mockProvider;
    default:
      throw new Error(`Unknown LLM_PROVIDER "${name}" (use anthropic | openai | mock)`);
  }
}

export function priceFor(model) {
  const envIn = process.env.LLM_PRICE_IN;
  const envOut = process.env.LLM_PRICE_OUT;
  if (envIn && envOut) return [Number(envIn), Number(envOut)];
  return PRICES[model] || [0, 0];
}

/**
 * Generates one structured object. Returns { data, usage }.
 * @param {{system:string,user:string,schema:import('zod').ZodType,businessId?:number,context?:object}} req
 */
export async function generate(req) {
  const provider = getProvider();
  const result = await provider.generate(req);
  const [pin, pout] = priceFor(result.model);
  const costUsd = (result.inputTokens * pin + result.outputTokens * pout) / 1e6;
  recordUsage({
    businessId: req.businessId,
    provider: provider.name,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd,
  });
  return { data: result.data, usage: { ...result, costUsd } };
}
