/**
 * Provider API keys the host may hold in its environment, as model-auth sources.
 *
 * One table rather than a literal per spec: several agents offer the same key
 * (four offer `ANTHROPIC_API_KEY`), and the label the picker shows must not
 * drift between them. Still pure data at rest, so a row spreading these stays a
 * plain JSON object in `~/.agentbox/agents.json`.
 *
 * These are the keys that authenticate; a preference like `ANTHROPIC_MODEL` is
 * NOT one and stays in `forwardedEnvKeys`, which is asserted by a drift test.
 */

import type { AgentModelAuthSource } from '@agentbox/core';

function envSource(envKey: string, provider: string): AgentModelAuthSource {
  return { kind: 'env', envKey, label: `Your ${provider} API key`, provider };
}

export const ENV_SOURCE = {
  ANTHROPIC: envSource('ANTHROPIC_API_KEY', 'Anthropic'),
  OPENAI: envSource('OPENAI_API_KEY', 'OpenAI'),
  OPENROUTER: envSource('OPENROUTER_API_KEY', 'OpenRouter'),
  GEMINI: envSource('GEMINI_API_KEY', 'Google Gemini'),
  GOOGLE_GENERATIVE_AI: envSource('GOOGLE_GENERATIVE_AI_API_KEY', 'Google Gemini'),
  GOOGLE: envSource('GOOGLE_API_KEY', 'Google'),
  GROQ: envSource('GROQ_API_KEY', 'Groq'),
  XAI: envSource('XAI_API_KEY', 'xAI (Grok)'),
  AI_GATEWAY: envSource('AI_GATEWAY_API_KEY', 'Vercel AI Gateway'),
  HUGGINGFACE: envSource('HF_TOKEN', 'Hugging Face'),
  BEDROCK: envSource('AWS_BEARER_TOKEN_BEDROCK', 'Amazon Bedrock'),
  /**
   * A long-lived token from `claude setup-token`. Deliberately offered where the
   * live `~/.claude/.credentials.json` OAuth blob is NOT: that blob rotates its
   * refresh token when a consumer refreshes it, logging the host and every
   * claude box out, whereas this token is separate and revocable.
   */
  CLAUDE_CODE_OAUTH: {
    kind: 'env',
    envKey: 'CLAUDE_CODE_OAUTH_TOKEN',
    label: 'Your Claude Code token',
    provider: 'Anthropic',
  },
} as const satisfies Record<string, AgentModelAuthSource>;
