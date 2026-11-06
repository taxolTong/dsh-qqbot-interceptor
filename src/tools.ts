/**
 * Model-facing tools registered into the dsh `tools` service.
 *
 * Two tools are exported on purpose:
 *  - `qqbot_inbox` reads the message stream the bot received;
 *  - `qqbot_send` emits a message as the bot.
 *
 * Together they are enough for a controller to answer fixed replies without
 * routing inbound messages through a full dsh agent turn.
 */
import type { Bridge } from './bridge'
import type { LoggerLike } from './types'

export const INBOX_TOOL = 'qqbot_inbox'
export const SEND_TOOL = 'qqbot_send'

const INBOX_DESCRIPTION =
  'Read messages the QQ bot received, newest last. In intercept mode messages are held ' +
  'away from dsh and only appear here; use `release` over the HTTP API to hand one to dsh. ' +
  'Each message has an id (in_N), sender, content, wasMentioned, attachments, reply target ' +
  'and an envelope preview. Set waitMs to long-poll for the next message.'

const SEND_DESCRIPTION =
  'Send a text or markdown message as the QQ bot. Pass `replyTo` with an inbox id (in_N) ' +
  'to reply passively to that message, or with an interaction id (int_N) to answer a button ' +
  'click. Without `replyTo`, the latest conversation is used when possible.'

interface ToolExec {
  signal?: AbortSignal
}

interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: any, value: any) => Array<{ type: 'text'; text: string }>
  }
  timeoutMs?: number
  execute: (args: any, exec: ToolExec) => Promise<unknown>
}

function inboxDefinition(bridge: Bridge): ToolDefinition {
  return {
    name: INBOX_TOOL,
    description: INBOX_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        since: {
          type: 'number',
          description: 'Cursor: only messages with seq greater than this value.',
        },
        limit: { type: 'number', description: 'Maximum messages to return (default 20, max 200).' },
        waitMs: {
          type: 'number',
          description: 'Long-poll up to this many milliseconds for a new message (max 60000).',
        },
        scope: { type: 'string', enum: ['c2c', 'group'], description: 'Only this chat scope.' },
        peerId: {
          type: 'string',
          description: 'Only this peer (user openid for c2c, group openid for group).',
        },
        actionableOnly: {
          type: 'boolean',
          description: 'Only messages that reached the qqbot message event (would enter dsh).',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messages: { type: 'array', items: { type: 'object' } },
          nextSince: { type: 'number' },
        },
        required: ['messages', 'nextSince'],
      },
      render: (_args, value) => {
        const result = value as { messages?: Array<Record<string, any>>; nextSince?: number }
        const messages = result.messages ?? []
        if (messages.length === 0) {
          return [{ type: 'text', text: `No new messages (nextSince=${result.nextSince ?? 0}).` }]
        }
        const lines = messages.map((message) => {
          const who = message.senderName ? `${message.senderName} (${message.senderId})` : message.senderId
          const flags = [
            message.actionable ? 'actionable' : 'raw',
            message.wasMentioned ? '@bot' : '',
            message.status ?? '',
          ]
            .filter(Boolean)
            .join(',')
          const content = String(message.content ?? '').replace(/\s+/g, ' ').slice(0, 200)
          return `- ${message.id} [${message.scope}:${message.peerId}] ${who} (${flags}): ${content}`
        })
        return [
          {
            type: 'text',
            text: `${messages.length} message(s), nextSince=${result.nextSince ?? 0}:\n${lines.join('\n')}`,
          },
        ]
      },
    },
    timeoutMs: 65_000,
    execute: (args, exec) =>
      bridge.queryInboundAsync(
        {
          ...(typeof args.since === 'number' ? { since: args.since } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          ...(typeof args.waitMs === 'number' ? { waitMs: args.waitMs } : {}),
          ...(args.scope === 'c2c' || args.scope === 'group' ? { scope: args.scope } : {}),
          ...(typeof args.peerId === 'string' ? { peerId: args.peerId } : {}),
          ...(args.actionableOnly === true ? { actionableOnly: true } : {}),
        },
        exec.signal,
      ),
  }
}

function sendDefinition(bridge: Bridge): ToolDefinition {
  return {
    name: SEND_TOOL,
    description: SEND_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Plain text body.' },
        markdown: { type: 'string', description: 'Markdown body (format=markdown).' },
        target: {
          type: 'string',
          description: 'Explicit target: "c2c:<openid>" or "group:<group_openid>".',
        },
        replyTo: {
          type: 'string',
          description: 'Reply anchor: inbox id in_N, interaction id int_N, or a raw QQ msg id.',
        },
        format: {
          type: 'string',
          enum: ['text', 'markdown'],
          description: 'Message format; defaults to text.',
        },
        keyboard: { type: 'object', description: 'Optional QQ inline keyboard payload.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          messageId: { type: 'string' },
          target: { type: 'string' },
          type: { type: 'string', enum: ['text', 'markdown'] },
        },
        required: ['target', 'type'],
      },
      render: (_args, value) => {
        const receipt = value as { messageId?: string; target?: string; type?: string }
        return [
          {
            type: 'text',
            text: `Sent ${receipt.type ?? 'text'} → ${receipt.target ?? '?'}${
              receipt.messageId ? ` (messageId=${receipt.messageId})` : ''
            }`,
          },
        ]
      },
    },
    timeoutMs: 30_000,
    execute: (args) =>
      bridge.send({
        ...(typeof args.text === 'string' ? { text: args.text } : {}),
        ...(typeof args.markdown === 'string' ? { markdown: args.markdown } : {}),
        ...(typeof args.target === 'string' ? { target: args.target } : {}),
        ...(typeof args.replyTo === 'string' ? { replyTo: args.replyTo } : {}),
        ...(args.format === 'text' || args.format === 'markdown' ? { format: args.format } : {}),
        ...(args.keyboard && typeof args.keyboard === 'object'
          ? { keyboard: args.keyboard as Record<string, unknown> }
          : {}),
      }),
  }
}

export function registerTools(ctx: any, bridge: Bridge, logger: LoggerLike): void {
  let tools: any
  try {
    tools = ctx.get('tools')
  } catch {
    tools = undefined
  }
  if (!tools || typeof tools.register !== 'function') {
    logger.warn('tools service is unavailable; qqbot_inbox/qqbot_send were not registered')
    return
  }
  for (const definition of [inboxDefinition(bridge), sendDefinition(bridge)]) {
    try {
      tools.register(definition)
      logger.info(`registered tool ${definition.name}`)
    } catch (error) {
      logger.error(`failed to register tool ${definition.name}:`, error)
    }
  }
}
