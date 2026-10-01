import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { settings } from "../config.js";

let client;

export const anthropicProvider = {
  name: "anthropic",
  async generate({ system, user, schema }) {
    client ??= new Anthropic(settings.llm.apiKey ? { apiKey: settings.llm.apiKey } : {});
    const model = settings.llm.model || "claude-opus-5-5";

    const response = await client.messages.parse({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
      output_config: {
        // "low" keeps thinking (billed as output) small. Haiku 4.5 rejects the effort parameter.
        ...(settings.llm.effort && !model.includes("haiku") ? { effort: settings.llm.effort } : {}),
        format: zodOutputFormat(schema),
      },
    });

    if (response.stop_reason === "refusal") {
      throw new Error(`Model declined the request (${response.stop_details?.category ?? "no category"})`);
    }
    if (response.stop_reason === "max_tokens") throw new Error("Model output hit max_tokens");
    if (!response.parsed_output) throw new Error("Model returned no parseable JSON");

    return {
      data: response.parsed_output,
      model: response.model || model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  },
};
