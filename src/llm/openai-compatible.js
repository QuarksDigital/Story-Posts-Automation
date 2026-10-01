// Any OpenAI-compatible /chat/completions endpoint: a local Ollama server
// (free, LLM_BASE_URL=http://localhost:11434/v1), Gemini, DeepSeek, OpenRouter...
import { z } from "zod";
import { settings } from "../config.js";

export const openaiCompatibleProvider = {
  name: "openai",
  async generate({ system, user, schema }) {
    const base = (settings.llm.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = settings.llm.model;
    if (!model) throw new Error("LLM_MODEL is required for LLM_PROVIDER=openai");

    const jsonSchema = z.toJSONSchema(schema);
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(settings.llm.apiKey ? { authorization: `Bearer ${settings.llm.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: `${system}\n\nReturn JSON matching this JSON Schema:\n${JSON.stringify(jsonSchema)}` },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.8,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    const text = body.choices?.[0]?.message?.content ?? "";
    const parsed = schema.safeParse(JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")));
    if (!parsed.success) throw new Error(`LLM JSON did not match schema: ${parsed.error.message.slice(0, 300)}`);

    return {
      data: parsed.data,
      model,
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  },
};
