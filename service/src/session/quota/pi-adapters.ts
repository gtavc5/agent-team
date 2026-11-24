import { antigravityAdapter } from "./antigravity";
import { kimiCodingAdapter } from "./kimi-coding";
import { openaiCodexAdapter } from "./openai-codex";
import { QuotaAdapterRegistry } from "./registry";
export const piAdapters = () =>
  new QuotaAdapterRegistry([antigravityAdapter, openaiCodexAdapter(), kimiCodingAdapter()]);
