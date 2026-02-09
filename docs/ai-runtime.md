# AI Runtime (SearchDocs + Failure Logs)

This runtime supports AI create/edit/fix flows with bounded tool use and bounded log context.

## Provider Support

- Supported providers: `openai`, `anthropic`
- Unsupported providers are ignored and AI stays disabled until valid config is provided.

Required environment variables:

- `AI_PROVIDER`
- `AI_MODEL`
- `AI_API_KEY`
- Optional: `AI_EFFORT` (OpenAI reasoning effort, default `low`)

## Rollout Toggle

- `AI_TOOL_LOOP_ENABLED=false` by default.
- Set `AI_TOOL_LOOP_ENABLED=true` to enable multi-step tool loop behavior and the `searchDocs` tool.
- When disabled, generation still runs, but without tool calls (single-step behavior only).

## searchDocs Tool Limits

When tool loop is enabled, `searchDocs` can query only markdown docs under `docs/`.

- Query length max: 240 chars
- Max matches returned: 6
- Max excerpt length: 420 chars
- Max serialized tool response: 9000 chars

Tool-loop execution budgets:

- Max generation steps: 5
- Max tool calls: 4
- Timeout per AI request: 45s

## Fix Context Logs

For `fix` mode only, prompt context includes:

- The runtime error payload
- Client-side last 20 app log entries
- Server-side last 20 app log entries

Log behavior:

- Stored in memory only
- Scoped by app id
- No file/database persistence
- No redaction in this rollout

## Failure Fallbacks

- Invalid/empty AI patch outputs in script edit/fix return `ai_request_failed`.
- Requests without valid AI provider/model/key return `ai_disabled`.
