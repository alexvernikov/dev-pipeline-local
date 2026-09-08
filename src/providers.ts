import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";

export function languageModel(configuration: { provider: string; model: string; apiKey: string }) {
  const { provider, model, apiKey } = configuration;
  switch (provider) {
    case "openai": return createOpenAI({ apiKey })(model);
    case "anthropic": return createAnthropic({ apiKey })(model);
    case "google": return createGoogleGenerativeAI({ apiKey })(model);
    case "mistral": return createMistral({ apiKey })(model);
    case "xai": return createXai({ apiKey })(model);
    case "deepseek": return createDeepSeek({ apiKey })(model);
    default: throw new Error("Unsupported AI provider.");
  }
}
