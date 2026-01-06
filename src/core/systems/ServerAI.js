import fs from 'fs'
import path from 'path'
import Anthropic, { toFile } from '@anthropic-ai/sdk'
import { OpenAI } from 'openai'

import { System } from './System'
import { hashFile } from '../utils-server'

const prefix = `app.remove(app.get('Block'))
`

const docs = fs.readFileSync(path.join(__dirname, 'public/ai-docs.md'), 'utf8')

/**
 * AI System
 *
 * - Runs on the server
 * - Handles comms with AI apis etc
 *
 */
export class ServerAI extends System {
  constructor(world) {
    super(world)
    this.assets = null
    this.provider = process.env.AI_PROVIDER || null
    this.model = process.env.AI_MODEL || null
    this.effort = process.env.AI_EFFORT || 'minimal'
    this.apiKey = process.env.AI_API_KEY || null
    if (this.provider && this.model && this.apiKey) {
      if (this.provider === 'openai') {
        this.client = new OpenAIClient(this.apiKey, this.model, this.effort)
      }
      if (this.provider === 'anthropic') {
        this.client = new AnthropicClient(this.apiKey, this.model)
      }
      if (this.provider === 'xai') {
        this.client = new XAIClient(this.apiKey, this.model)
      }
      if (this.provider === 'google') {
        this.client = new GoogleClient(this.apiKey, this.model)
      }
    }
    this.enabled = !!this.client
  }

  serialize() {
    return {
      enabled: this.enabled,
      provider: this.provider,
      model: this.model,
      effort: this.effort,
    }
  }

  async init({ assets }) {
    this.assets = assets
  }

  async onAction(action) {
    if (!this.enabled) {
      return
    }
    if (action.name === 'create') {
      this.create(action)
    } else if (action.name === 'edit') {
      this.edit(action)
    } else if (action.name === 'fix') {
      this.fix(action)
    }
  }

  async create({ blueprintId, appId, prompt }) {
    console.log('[ai] creating...')
    // classify prompt to a short descriptive name for the app
    this.classify({ blueprintId, prompt })
    // send prompt to ai to generate code
    const startAt = performance.now()
    let output = await this.client.create(prompt)
    output = stripCodeFences(output)
    const changelog = [`create: ${prompt}`]
    const code = prefix + writeChangelog(output, changelog)
    const elapsed = (performance.now() - startAt) / 1000
    // console.log(code)
    console.log(`[ai] created in ${elapsed}s`)
    // convert new code to asset
    const file = new File([code], 'script.js', { type: 'text/plain' })
    const fileContent = await file.arrayBuffer()
    const hash = await hashFile(Buffer.from(fileContent))
    const filename = `${hash}.js`
    const url = `asset://${filename}`
    // upload new script asset
    await this.assets.upload(file)
    // apply blueprint change
    const blueprint = this.world.blueprints.get(blueprintId)
    const version = blueprint.version + 1
    const change = { id: blueprint.id, version, script: url }
    this.world.network.applyBlueprintModified(change)
  }

  async edit({ blueprintId, appId, prompt }) {
    console.log('[ai] editing...')
    // get existing blueprint
    let blueprint = this.world.blueprints.get(blueprintId)
    if (!blueprint) return console.error('[ai] edit blueprint but blueprint not found')
    // get code to edit
    let script = this.world.loader.get('script', blueprint.script)
    if (!script) script = await this.world.loader.load('script', blueprint.script)
    // send prompt to ai to generate code
    const startAt = performance.now()
    const code = script.code.replace(prefix, '')
    const changelog = readChangelog(code)
    changelog.push(`edit: ${prompt}`)
    let output = await this.client.edit(code, prompt)
    output = stripCodeFences(output)
    const newCode = prefix + writeChangelog(output, changelog)
    const elapsed = (performance.now() - startAt) / 1000
    console.log(`[ai] edited in ${elapsed}s`)
    // convert new code to asset
    const file = new File([newCode], 'script.js', { type: 'text/plain' })
    const fileContent = await file.arrayBuffer()
    const hash = await hashFile(Buffer.from(fileContent))
    const filename = `${hash}.js`
    const url = `asset://${filename}`
    // upload new script asset
    await this.assets.upload(file)
    // apply blueprint change
    blueprint = this.world.blueprints.get(blueprintId)
    const version = blueprint.version + 1
    const change = { id: blueprint.id, version, script: url }
    this.world.network.applyBlueprintModified(change)
  }

  async fix({ blueprintId, appId, error }) {
    console.log('[ai] fixing...')
    // get existing blueprint
    let blueprint = this.world.blueprints.get(blueprintId)
    if (!blueprint) return console.error('[ai] fix blueprint but blueprint not found')
    // get code to fix
    let script = this.world.loader.get('script', blueprint.script)
    if (!script) script = await this.world.loader.load('script', blueprint.script)
    // send prompt to ai to generate code
    const startAt = performance.now()
    const code = script.code.replace(prefix, '')
    const changelog = readChangelog(code)
    let output = await this.client.fix(code, error)
    output = stripCodeFences(output)
    const newCode = prefix + writeChangelog(output, changelog)
    const elapsed = (performance.now() - startAt) / 1000
    console.log(`[ai] fixed in ${elapsed}s`)
    // convert new code to asset
    const file = new File([newCode], 'script.js', { type: 'text/plain' })
    const fileContent = await file.arrayBuffer() // or file.text() for string
    const hash = await hashFile(Buffer.from(fileContent))
    const filename = `${hash}.js`
    const url = `asset://${filename}`
    // upload new script asset
    await this.assets.upload(file)
    // apply blueprint change
    blueprint = this.world.blueprints.get(blueprintId)
    const version = blueprint.version + 1
    const change = { id: blueprint.id, version, script: url }
    this.world.network.applyBlueprintModified(change)
  }

  async classify({ blueprintId, prompt }) {
    // get a name for the object
    const name = await this.client.classify(prompt)
    // apply name change
    const blueprint = this.world.blueprints.get(blueprintId)
    const version = blueprint.version + 1
    const change = { id: blueprint.id, version, name }
    this.world.network.applyBlueprintModified(change)
  }
}

class OpenAIClient {
  constructor(apiKey, model, effort) {
    this.client = new OpenAI({ apiKey })
    this.model = model
    this.effort = effort
  }

  async create(prompt) {
    const resp = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: this.effort },
      // text: { verbosity: 'low' },
      // max_output_tokens: 8192,
      instructions: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.`,
      input: `Respond with the javascript needed to generate the following:\n\n"${prompt}"`,
    })
    return resp.output_text
  }

  async edit(code, prompt) {
    const resp = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: this.effort },
      // text: { verbosity: 'low' },
      // max_output_tokens: 8192,
      instructions: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
        Here is the existing script that you will be working with:
        ===============
        ${code}`,
      input: `Please edit the code above to satisfy the following request:\n\n"${prompt}"`,
    })
    return resp.output_text
  }

  async fix(code, error) {
    const resp = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: this.effort },
      // text: { verbosity: 'low' },
      // max_output_tokens: 8192,
      instructions: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
        Here is the existing script that you will be working with:
        ===============
        ${code}`,
      input: `This code has an error please fix it:\n\n"${JSON.stringify(error, null, 2)}"`,
    })
    return resp.output_text
  }

  async classify(prompt) {
    const resp = await this.client.responses.create({
      model: this.model,
      reasoning: { effort: this.effort },
      // text: { verbosity: 'low' },
      // max_output_tokens: 8192,
      instructions: `You are a classifier. We will give you a prompt that a user has entered to generate a 3D object and your job is respond with a short name for the object. For example if someone prompts "a cool gamer desk with neon lights" you would respond with something like "Gamer Desk" because it is a short descriptive name that captures the essence of the object.`,
      input: `Please classify the following prompt:\n\n"${prompt}"`,
    })
    return resp.output_text
  }
}

class AnthropicClient {
  constructor(apiKey, model) {
    this.client = new Anthropic({ apiKey })
    this.model = model
    this.maxTokens = 8192
  }

  async create(prompt) {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.`,
      messages: [
        {
          role: 'user',
          content: `Respond with the javascript needed to generate the following:\n\n"${prompt}"`,
        },
      ],
    })
    return resp.content[0].text
  }

  async edit(code, prompt) {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
        Here is the existing script that you will be working with:
        ===============
        ${code}`,
      messages: [
        {
          role: 'user',
          content: `Please edit the code above to satisfy the following request:\n\n"${prompt}"`,
        },
      ],
    })
    return resp.content[0].text
  }

  async fix(code, error) {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: `
        ${docs}
        ===============
        You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
        Here is the existing script that you will be working with:
        ===============
        ${code}`,
      messages: [
        {
          role: 'user',
          content: `This code has an error please fix it:\n\n"${JSON.stringify(error, null, 2)}"`,
        },
      ],
    })
    return resp.content[0].text
  }

  async classify(prompt) {
    const resp = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: `You are a classifier. We will give you a prompt that a user has entered to generate a 3D object and your job is respond with a short name for the object. For example if someone prompts "a cool gamer desk with neon lights" you would respond with something like "Gamer Desk" because it is a short descriptive name that captures the essence of the object.`,
      messages: [
        {
          role: 'user',
          content: `Please classify the following prompt:\n\n"${prompt}"`,
        },
      ],
    })
    return resp.content[0].text
  }
}

class Comput3Client {
  constructor() {
    this.apiKey = 'c3_api_ZtSTqeJjSca97M57mKEEksI93278'
    this.model = 'kimi-k2'
    // this.model = 'qwen3-coder:480b'
  }

  async exec(data) {
    const resp = await fetch('https://api.comput3.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    })
    const json = await resp.json()
    console.log(JSON.stringify(json, null, 2))
    return json.choices[0].message.content
  }

  async create(prompt) {
    return await this.exec({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: `
            ${docs}
            ===============
            You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.`,
        },
        {
          role: 'user',
          content: `Respond with the javascript needed to generate the following:\n\n"${prompt}"`,
        },
      ],
    })
  }

  async edit(code, prompt) {
    return await this.exec({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: `
            ${docs}
            ===============
            You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
            Here is the existing script that you will be working with:
            ===============
            ${code}`,
        },
        {
          role: 'user',
          content: `Please edit the code above to satisfy the following request:\n\n"${prompt}"`,
        },
      ],
    })
  }

  async fix(code, error) {
    return await this.exec({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: `
            ${docs}
            ===============
            You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
            Here is the existing script that you will be working with:
            ===============
            ${code}`,
        },
        {
          role: 'user',
          content: `This code has an error please fix it:\n\n"${JSON.stringify(error, null, 2)}"`,
        },
      ],
    })
  }

  async classify(prompt) {
    return await this.exec({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: `You are a classifier. We will give you a prompt that a user has entered to generate a 3D object and your job is respond with a short name for the object. For example if someone prompts "a cool gamer desk with neon lights" you would respond with something like "Gamer Desk" because it is a short descriptive name that captures the essence of the object.`,
        },
        {
          role: 'user',
          content: `Please classify the following prompt:\n\n"${prompt}"`,
        },
      ],
    })
  }
}

class XAIClient {
  constructor(apiKey, model) {
    this.apiKey = apiKey
    this.model = model
    this.url = 'https://api.x.ai/v1/chat/completions'
  }

  async create(prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.`,
          },
          {
            role: 'user',
            content: `Respond with the javascript needed to generate the following:\n\n"${prompt}"`,
          },
        ],
      }),
    })
    const data = await resp.json()
    return data.choices[0].message.content
  }

  async edit(code, prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
              Here is the existing script that you will be working with:
              ===============
              ${code}`,
          },
          {
            role: 'user',
            content: `Please edit the code above to satisfy the following request:\n\n"${prompt}"`,
          },
        ],
      }),
    })
    const data = await resp.json()
    return data.choices[0].message.content
  }

  async fix(code, error) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
              Here is the existing script that you will be working with:
              ===============
              ${code}`,
          },
          {
            role: 'user',
            content: `This code has an error please fix it:\n\n"${JSON.stringify(error, null, 2)}"`,
          },
        ],
      }),
    })
    const data = await resp.json()
    return data.choices[0].message.content
  }

  async classify(prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [
          {
            role: 'system',
            content: `You are a classifier. We will give you a prompt that a user has entered to generate a 3D object and your job is respond with a short name for the object. For example if someone prompts "a cool gamer desk with neon lights" you would respond with something like "Gamer Desk" because it is a short descriptive name that captures the essence of the object.`,
          },
          {
            role: 'user',
            content: `Please classify the following prompt:\n\n"${prompt}"`,
          },
        ],
      }),
    })
    const data = await resp.json()
    return data.choices[0].message.content
  }
}

class GoogleClient {
  constructor(apiKey, model) {
    this.apiKey = apiKey
    this.url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  }

  async create(prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: {
          parts: {
            text: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.`,
          },
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: `Respond with the javascript needed to generate the following:\n\n"${prompt}"` }],
          },
        ],
      }),
    })
    const data = await resp.json()
    // console.log(JSON.stringify(data, null, 2))
    return data.candidates[0].content.parts[0].text
  }

  async edit(code, prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: {
          parts: {
            text: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
              Here is the existing script that you will be working with:
              ===============
              ${code}`,
          },
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: `Please edit the code above to satisfy the following request:\n\n"${prompt}"` }],
          },
        ],
      }),
    })
    const data = await resp.json()
    // console.log(JSON.stringify(data, null, 2))
    return data.candidates[0].content.parts[0].text
  }

  async fix(code, error) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: {
          parts: {
            text: `
              ${docs}
              ===============
              You are an artist and code generator. Always respond with raw code only, never use markdown code blocks or any other formatting.
              Here is the existing script that you will be working with:
              ===============
              ${code}`,
          },
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: `This code has an error please fix it:\n\n"${JSON.stringify(error, null, 2)}"` }],
          },
        ],
      }),
    })
    const data = await resp.json()
    // console.log(JSON.stringify(data, null, 2))
    return data.candidates[0].content.parts[0].text
  }

  async classify(prompt) {
    const resp = await fetch(this.url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        system_instruction: {
          parts: {
            text: `You are a classifier. We will give you a prompt that a user has entered to generate a 3D object and your job is respond with a short name for the object. For example if someone prompts "a cool gamer desk with neon lights" you would respond with something like "Gamer Desk" because it is a short descriptive name that captures the essence of the object.`,
          },
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: `Please classify the following prompt:\n\n"${prompt}"` }],
          },
        ],
      }),
    })
    const data = await resp.json()
    // console.log(JSON.stringify(data, null, 2))
    return data.candidates[0].content.parts[0].text
  }
}

const changelogRegex = /\/\*\*[\s\S]*?changelog:[\s\S]*?\*\/\s*/
const entryRegex = /\*\s*-\s*(.+)/g

function readChangelog(code) {
  // match changelog comment block
  const match = code.match(changelogRegex)
  if (!match) return []
  const changelogBlock = match[0]
  // extract individual entries (lines starting with * -)
  const entries = []
  let entryMatch
  while ((entryMatch = entryRegex.exec(changelogBlock)) !== null) {
    entries.push(entryMatch[1].trim())
  }
  return entries
}

function writeChangelog(code, changelog) {
  // remove existing changelog header if exists
  const changelogRegex = /\/\*\*[\s\S]*?changelog:[\s\S]*?\*\/\s*/
  const cleanCode = code.replace(changelogRegex, '')
  // construct new changelog header
  const entries = changelog.map(entry => ` * - ${entry}`).join('\n')
  const header = `/**\n * changelog:\n${entries}\n */\n\n`
  // insert new header at beginning
  return header + cleanCode.trimStart()
}

const fencePattern = /^```(?:\w+)?\s*([\s\S]*?)\s*```$/
function stripCodeFences(text) {
  // sometimes AI responses come back wrapped in code backticks even though
  // we ask it not to. this strips them out if they exist.
  let cleaned = text.trim()
  // regex to match ```js ... ``` or ``` ... ```
  const match = cleaned.match(fencePattern)
  if (match) {
    return match[1] // extract inner code
  }
  return cleaned // return untouched if no fences
}
