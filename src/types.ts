/**
 * Public data model for the QQ bot interceptor.
 *
 * Everything in this file is JSON-safe: it is what the HTTP API returns, what
 * the dsh tools serialize, and what external controllers consume. Runtime
 * handles (QQBot instance, middleware context) never appear here.
 */

export type Scope = 'c2c' | 'group'

/** `observe` only taps traffic; `intercept` holds inbound messages away from dsh. */
export type InterceptMode = 'observe' | 'intercept'

/** Lifecycle of one inbound message as seen by the interceptor. */
export type InboundStatus =
  /** Received by the SDK, not yet past the qqbot middleware chain. */
  | 'received'
  /** Reached the qqbot `message` event (it would have entered dsh). */
  | 'actionable'
  /** Held back in intercept mode; dsh never saw it. */
  | 'intercepted'
  /** Passed through to qqbot/dsh in observe mode. */
  | 'passed'
  /** Was held, then explicitly released into the normal dsh pipeline. */
  | 'released'

export type AttachmentKind = 'image' | 'video' | 'voice' | 'file' | 'unknown'

export interface AttachmentInfo {
  kind: AttachmentKind
  contentType?: string
  url?: string
  filename?: string
  size?: number
  /** Local download path filled in by qqbot's attachmentProcessor middleware. */
  localPath?: string
  /** QQ server-side speech-to-text result, when present. */
  asrText?: string
}

export interface ReplyTargetInfo {
  scope: Scope
  targetId: string
  msgId?: string
}

export interface InboundMessage {
  /** Stable interceptor id, e.g. `in_12`. Use it with `release` / `send.replyTo`. */
  id: string
  /** Per-stream cursor; pass to `since`. */
  seq: number
  receivedAt: string
  receivedAtMs: number
  /** SDK message kind (`c2c` / `group`; other kinds are not intercepted). */
  kind: string
  scope: Scope | null
  peerId: string | null
  senderId: string
  senderName?: string
  messageId: string
  /** Processed text (post qqbot middleware) for actionable messages; raw text before that. */
  content: string
  /** Text exactly as delivered by the QQ gateway. */
  rawContent: string
  wasMentioned: boolean
  actionable: boolean
  status: InboundStatus
  groupOpenid?: string
  channelId?: string
  guildId?: string
  rawEventType?: string
  mentions: Array<Record<string, unknown>>
  attachments: AttachmentInfo[]
  quote?: {
    text?: string
    messageId?: string
    attachments?: AttachmentInfo[]
  }
  /**
   * The prompt envelope qqbot would have handed to the agent (sender, quote,
   * group history, current message). Useful for a controller that wants the
   * exact context without paying for dsh's system prompt.
   */
  envelope?: string
  historyCount?: number
  replyTarget: ReplyTargetInfo | null
  processedAt?: string
  releasedAt?: string
}

export interface OutboundMessage {
  /** Stable interceptor id, e.g. `out_3`. */
  id: string
  seq: number
  sentAt: string
  sentAtMs: number
  target: {
    scope: string
    targetId: string
    msgId?: string
    eventId?: string
  }
  /** High-level payload type. */
  type: 'text' | 'markdown' | 'image' | 'video' | 'voice' | 'file' | 'channel' | 'unknown'
  /** Text, markdown source, or a short media descriptor. */
  content: string
  messageId?: string
  ok: boolean
  error?: string
  /** `api` = sent through this plugin; `qqbot` = sent by the qqbot plugin itself. */
  via: 'api' | 'qqbot'
}

export interface Interaction {
  /** Stable interceptor id, e.g. `int_2`. */
  id: string
  seq: number
  receivedAt: string
  receivedAtMs: number
  /** QQ interaction/event id used for passive replies. */
  interactionId: string
  scope: Scope
  targetId: string
  userId?: string
  groupOpenid?: string
  /** Opaque `button_data` payload (JSON string, usually). */
  buttonData?: string
  /** Decoded event.data.resolved, when the platform provided it. */
  data?: unknown
  /** `held` in intercept mode, `passed` in observe mode. */
  status: 'held' | 'passed'
  acked: boolean
}

export interface InboundQuery {
  since?: number
  limit?: number
  scope?: Scope
  peerId?: string
  actionableOnly?: boolean
  /** Long-poll: wait up to this many milliseconds for a matching message. */
  waitMs?: number
}

export interface InboundResult {
  messages: InboundMessage[]
  nextSince: number
}

export interface OutboundQuery {
  since?: number
  limit?: number
  waitMs?: number
}

export interface OutboundResult {
  messages: OutboundMessage[]
  nextSince: number
}

export interface InteractionQuery {
  since?: number
  limit?: number
  waitMs?: number
}

export interface InteractionResult {
  interactions: Interaction[]
  nextSince: number
}

export interface SendMessageInput {
  /** Plain text body. */
  text?: string
  /** Markdown body; takes precedence over `text` when `format` is markdown. */
  markdown?: string
  /** Explicit target: `c2c:<openid>` or `group:<group_openid>`. */
  target?: string
  /**
   * Reply anchor, one of:
   * - an inbound id (`in_12`) → passive reply to that message,
   * - an interaction id (`int_3`) → passive reply via `event_id`,
   * - a raw QQ msg id (with `target`).
   */
  replyTo?: string
  /** Explicit passive-reply msg id (requires `target`). */
  msgId?: string
  /** Explicit interaction event id (requires `target`). */
  eventId?: string
  /** QQ inline keyboard payload. */
  keyboard?: Record<string, unknown>
  /** Defaults to `text`; use `markdown` for msg_type=2. */
  format?: 'text' | 'markdown'
}

export interface SendReceipt {
  messageId?: string
  target: string
  type: 'text' | 'markdown'
}

export interface ConversationSummary {
  scope: Scope
  peerId: string
  senderName?: string
  senderId: string
  lastMessageId: string
  lastAt: string
  lastContent: string
  inboundId: string
  actionable: boolean
}

export interface HealthReport {
  ok: boolean
  plugin: string
  version: string
  mode: InterceptMode
  attached: boolean
  patched: boolean
  patchError?: string
  sdkPatchedAt?: string
  botSeen: boolean
  appId?: string
  lastEvent?: {
    type: string
    at: string
    detail?: string
  }
  http: {
    enabled: boolean
    url?: string
    tokenRequired: boolean
  }
  counts: {
    inbound: number
    outbound: number
    interactions: number
    held: number
  }
  startedAt: string
}

export interface InterceptorConfig {
  mode: InterceptMode
  host: string
  port: number
  token: string
  ringSize: number
  ackInteractions: boolean
  allowRelease: boolean
  /** Older passive msg ids are sent as proactive messages to avoid QQ 40034. */
  maxPassiveAgeMs: number
  /** Directory for api.json. Empty string → `$DSH_HOME/qqbot-interceptor`. */
  dataDir: string
  debug: boolean
}

export interface LoggerLike {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug?(...args: unknown[]): void
}
