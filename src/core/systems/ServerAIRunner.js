import { streamText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'

const DEFAULT_EFFORT = 'low'
const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 4096

export function readServerAIConfig(env = process.env) {
  return {
    provider: env.AI_PROVIDER || null,
    model: env.AI_MODEL || null,
    effort: env.AI_EFFORT || DEFAULT_EFFORT,
    apiKey: env.AI_API_KEY || null,
  }
}

export function createServerAIRunner(config, options = {}) {
  const provider = config?.provider || null
  const model = config?.model || null
  const effort = config?.effort || DEFAULT_EFFORT
  const apiKey = config?.apiKey || null
  if (!provider || !model || !apiKey) return null

  if (provider === 'openai') {
    return new OpenAIRunner(apiKey, model, effort)
  }

  if (provider === 'anthropic') {
    const requestedMaxTokens = options?.anthropicMaxOutputTokens
    const maxOutputTokens =
      Number.isInteger(requestedMaxTokens) && requestedMaxTokens > 0
        ? requestedMaxTokens
        : DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS
    return new AnthropicAIRunner(apiKey, model, maxOutputTokens)
  }

  return null
}

class OpenAIRunner {
  constructor(apiKey, model, effort) {
    this.model = model
    this.effort = effort
    this.provider = createOpenAI({ apiKey })
  }

  async generate(systemPrompt, userPrompt) {
    const result = streamText({
      model: this.provider(this.model),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      providerOptions: {
        openai: {
          reasoningEffort: this.effort || undefined,
        },
      },
    })
    let output = ''
    for await (const delta of result.textStream) {
      output += delta
    }
    return output
  }
}

class AnthropicAIRunner {
  constructor(apiKey, model, maxOutputTokens) {
    this.model = model
    this.maxOutputTokens = maxOutputTokens
    this.provider = createAnthropic({ apiKey })
  }

  async generate(systemPrompt, userPrompt) {
    const result = streamText({
      model: this.provider(this.model),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      maxOutputTokens: this.maxOutputTokens,
    })
    let output = ''
    for await (const delta of result.textStream) {
      output += delta
    }
    return output
  }
}
