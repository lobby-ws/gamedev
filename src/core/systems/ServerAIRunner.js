import { generateText, stepCountIs } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'

const DEFAULT_EFFORT = 'low'
const DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS = 4096
const DEFAULT_TOOL_LOOP_MAX_STEPS = 4
const DEFAULT_TOOL_LOOP_MAX_CALLS = 4
const DEFAULT_TOOL_LOOP_TIMEOUT_MS = 20_000
const DEFAULT_TOOL_LOOP_ENABLED = false
const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const FALSY_ENV_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled'])

function clampInt(value, min, max, fallback) {
  const parsed = Number(value)
  const base = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
  if (base < min) return min
  if (base > max) return max
  return base
}

function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function parseBooleanEnv(value, fallback = false) {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  if (!normalized) return fallback
  if (TRUTHY_ENV_VALUES.has(normalized)) return true
  if (FALSY_ENV_VALUES.has(normalized)) return false
  return fallback
}

function normalizeProvider(value) {
  const provider = normalizeNonEmptyString(value)?.toLowerCase()
  if (provider === 'openai' || provider === 'anthropic') return provider
  return null
}

function normalizeToolLoopOptions(options = {}) {
  return {
    tools: options?.tools && typeof options.tools === 'object' ? options.tools : null,
    maxSteps: clampInt(options.maxSteps, 1, 12, DEFAULT_TOOL_LOOP_MAX_STEPS),
    maxToolCalls: clampInt(options.maxToolCalls, 1, 32, DEFAULT_TOOL_LOOP_MAX_CALLS),
    timeoutMs: clampInt(options.timeoutMs, 1000, 120_000, DEFAULT_TOOL_LOOP_TIMEOUT_MS),
  }
}

function countToolCallsFromSteps(steps) {
  if (!Array.isArray(steps) || !steps.length) return 0
  let count = 0
  for (const step of steps) {
    if (!Array.isArray(step?.toolCalls)) continue
    count += step.toolCalls.length
  }
  return count
}

function buildStopConditions(maxSteps, maxToolCalls) {
  const maxCallCondition = ({ steps }) => countToolCallsFromSteps(steps) > maxToolCalls
  return [stepCountIs(maxSteps), maxCallCondition]
}

function buildPrepareStep(tools, maxToolCalls) {
  const toolNames = Object.keys(tools || {})
  return ({ steps }) => {
    const toolCalls = countToolCallsFromSteps(steps)
    if (toolCalls >= maxToolCalls) {
      return { activeTools: [] }
    }
    return { activeTools: toolNames }
  }
}

async function runGenerateText(request, timeoutMs) {
  const abortController = new AbortController()
  let timer = null
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      abortController.abort()
      const timeoutError = new Error('ai_generation_timeout')
      timeoutError.code = 'ai_generation_timeout'
      reject(timeoutError)
    }, timeoutMs)
  })
  try {
    const result = await Promise.race([
      generateText({
        ...request,
        abortSignal: abortController.signal,
      }),
      timeout,
    ])
    return { result, timedOut: false }
  } catch (err) {
    if (err?.code === 'ai_generation_timeout' || abortController.signal.aborted) {
      const timeoutError = new Error('ai_generation_timeout')
      timeoutError.code = 'ai_generation_timeout'
      throw timeoutError
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function normalizeGenerationResult(result) {
  const steps = Array.isArray(result?.steps) ? result.steps : []
  const stepCount = steps.length || 1
  const toolCallCountFromSteps = countToolCallsFromSteps(steps)
  const topLevelToolCalls = Array.isArray(result?.toolCalls) ? result.toolCalls.length : 0
  return {
    text: typeof result?.text === 'string' ? result.text : '',
    finishReason: typeof result?.finishReason === 'string' ? result.finishReason : 'unknown',
    stepCount,
    toolCallCount: Math.max(toolCallCountFromSteps, topLevelToolCalls),
    timedOut: false,
    usage: result?.usage || null,
  }
}

export function readServerAIConfig(env = process.env) {
  const effort = normalizeNonEmptyString(env.AI_EFFORT) || DEFAULT_EFFORT
  const toolLoopEnabled = parseBooleanEnv(env.AI_TOOL_LOOP_ENABLED, DEFAULT_TOOL_LOOP_ENABLED)
  return {
    provider: normalizeProvider(env.AI_PROVIDER),
    model: normalizeNonEmptyString(env.AI_MODEL),
    effort,
    apiKey: normalizeNonEmptyString(env.AI_API_KEY),
    toolLoopEnabled,
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

  async generate(systemPrompt, userPrompt, options = {}) {
    const toolLoop = normalizeToolLoopOptions(options)
    const hasTools = toolLoop.tools && Object.keys(toolLoop.tools).length > 0
    const request = {
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
    }
    if (hasTools) {
      request.tools = toolLoop.tools
      request.stopWhen = buildStopConditions(toolLoop.maxSteps, toolLoop.maxToolCalls)
      request.prepareStep = buildPrepareStep(toolLoop.tools, toolLoop.maxToolCalls)
    }
    const { result } = await runGenerateText(request, toolLoop.timeoutMs)
    return normalizeGenerationResult(result)
  }
}

class AnthropicAIRunner {
  constructor(apiKey, model, maxOutputTokens) {
    this.model = model
    this.maxOutputTokens = maxOutputTokens
    this.provider = createAnthropic({ apiKey })
  }

  async generate(systemPrompt, userPrompt, options = {}) {
    const toolLoop = normalizeToolLoopOptions(options)
    const hasTools = toolLoop.tools && Object.keys(toolLoop.tools).length > 0
    const request = {
      model: this.provider(this.model),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      maxOutputTokens: this.maxOutputTokens,
    }
    if (hasTools) {
      request.tools = toolLoop.tools
      request.stopWhen = buildStopConditions(toolLoop.maxSteps, toolLoop.maxToolCalls)
      request.prepareStep = buildPrepareStep(toolLoop.tools, toolLoop.maxToolCalls)
    }
    const { result } = await runGenerateText(request, toolLoop.timeoutMs)
    return normalizeGenerationResult(result)
  }
}
