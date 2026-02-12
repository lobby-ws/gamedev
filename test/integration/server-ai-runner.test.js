import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createServerAIRunner, readServerAIConfig } from '../../src/core/systems/ServerAIRunner.js'

test('readServerAIConfig normalizes provider and rollout toggle', () => {
  const config = readServerAIConfig({
    AI_PROVIDER: ' OpenAI ',
    AI_MODEL: ' gpt-5-mini ',
    AI_EFFORT: ' medium ',
    AI_API_KEY: ' secret-key ',
    AI_TOOL_LOOP_ENABLED: 'true',
  })

  assert.equal(config.provider, 'openai')
  assert.equal(config.model, 'gpt-5-mini')
  assert.equal(config.effort, 'medium')
  assert.equal(config.apiKey, 'secret-key')
  assert.equal(config.toolLoopEnabled, true)
})

test('readServerAIConfig rejects unsupported providers and defaults rollout toggle off', () => {
  const config = readServerAIConfig({
    AI_PROVIDER: 'xai',
    AI_MODEL: 'model-1',
    AI_API_KEY: 'key',
  })

  assert.equal(config.provider, null)
  assert.equal(config.toolLoopEnabled, false)
})

test('createServerAIRunner supports openai and anthropic providers', () => {
  const openaiRunner = createServerAIRunner({
    provider: 'openai',
    model: 'gpt-5-mini',
    effort: 'low',
    apiKey: 'test-key',
  })
  const anthropicRunner = createServerAIRunner({
    provider: 'anthropic',
    model: 'claude-3-7-sonnet-latest',
    effort: 'low',
    apiKey: 'test-key',
  })

  assert.equal(typeof openaiRunner?.generate, 'function')
  assert.equal(typeof anthropicRunner?.generate, 'function')
})

test('createServerAIRunner falls back to null when configuration is unsupported', () => {
  const unsupportedProvider = createServerAIRunner({
    provider: 'google',
    model: 'gemini',
    effort: 'low',
    apiKey: 'test-key',
  })
  const missingApiKey = createServerAIRunner({
    provider: 'openai',
    model: 'gpt-5-mini',
    effort: 'low',
    apiKey: null,
  })
  const missingModel = createServerAIRunner({
    provider: 'anthropic',
    model: '',
    effort: 'low',
    apiKey: 'test-key',
  })

  assert.equal(unsupportedProvider, null)
  assert.equal(missingApiKey, null)
  assert.equal(missingModel, null)
})
