import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ConversationSummary,
  InboundMessage,
  InboundQuery,
  InboundResult,
  Interaction,
  InteractionQuery,
  InteractionResult,
  InterceptorConfig,
  InterceptMode,
  LoggerLike,
  OutboundMessage,
  OutboundQuery,
  OutboundResult,
  ReplyTargetInfo,
  Scope,
  SendMessageInput,
  SendReceipt,
} from './types'
import {
  asRecord,
  BridgeError,
  clamp,
  cloneJson,
  describeError,
  mapAttachment,
  newToken,
  nowIso,
  parseTarget,
  truncate,
} from './util'

export const PLUGIN_VERSION = '0.1.0'
const DEFAULT_DATA_SUBDIR = 'qqbot-interceptor'

export interface PatchBinding {
  originalEmit: (...args: any[]) => any
  sdkVersion: string
  installedAt: number
}

interface HeldContext {
  bot: any
  ctx: any
  messageId: string
  heldAt: number
}

interface SseClient {
  res: ServerResponse
  inSeq: number
  outSeq: number
  intSeq: number
}

interface SendOrigin {
  via: 'api' | 'qqbot'
}

const GLOBAL_BRIDGE_KEY = Symbol.for('dsh-qqbot-interceptor/bridge/v1')

function fallbackLogger(): LoggerLike {
  return {
    info: (...args) => console.log('[qqbot-interceptor]', ...args),
    warn: (...args) => console.warn('[qqbot-interceptor]', ...args),
    error: (...args) => console.error('[qqbot-interceptor]', ...args),
    debug: () => {},
  }
}

function normalizeMode(value: unknown, fallback: InterceptMode): InterceptMode {
  return value === 'observe' || value === 'intercept' ? value : fallback
}

export class Bridge {
  readonly version = PLUGIN_VERSION
  /** Stable marker so a HMR-reloaded module can keep reusing the same bridge. */
  readonly __kind = 'qqbot-interceptor-bridge'
  private readonly tokenSeed = newToken()
  private config: InterceptorConfig
  private logger: LoggerLike = fallbackLogger()
  private attached = false
  private patch: PatchBinding | null = null
  private patchError: string | undefined

  private bot: any = null
  private appId: string | undefined
  private mode: InterceptMode = 'observe'
  private startedAt = Date.now()
  private lastEvent: { type: string; at: string; detail?: string } | undefined

  private readonly inbox: InboundMessage[] = []
  private readonly outbox: OutboundMessage[] = []
  private readonly interactions: Interaction[] = []
  private readonly inboundById = new Map<string, InboundMessage>()
  private readonly byMessageId = new Map<string, InboundMessage>()
  private readonly outboundById = new Map<string, OutboundMessage>()
  private readonly interactionById = new Map<string, Interaction>()
  private readonly held = new Map<string, HeldContext>()
  private readonly waiters = new Set<() => void>()
  private readonly sseClients = new Set<SseClient>()

  private inSeq = 0
  private outSeq = 0
  private intSeq = 0
  private revision = 0

  private server: Server | null = null
  private httpUrl: string | undefined
  private httpPort = 0
  private httpError: string | undefined
  private heartbeat: NodeJS.Timeout | undefined
  private readonly sendOrigin = new AsyncLocalStorage<SendOrigin>()

  constructor(config?: Partial<InterceptorConfig>) {
    this.config = this.normalizeConfig(config)
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  get isAttached(): boolean {
    return this.attached
  }

  get currentMode(): InterceptMode {
    return this.mode
  }

  attach(config: unknown, logger?: LoggerLike): void {
    this.config = this.normalizeConfig(config)
    this.mode = this.config.mode
    if (logger) this.logger = logger
    this.attached = true
    this.startedAt = Date.now()
    if (!this.patch) this.patchError = 'SDK patch not installed yet'
    void this.startHttp()
    this.logger.info(
      `attached (mode=${this.mode}, http=${this.config.port === 0 ? 'off' : `${this.config.host}:${this.config.port}`})`,
    )
  }

  detach(): void {
    this.attached = false
    this.stopHttp()
    for (const wake of [...this.waiters]) wake()
    this.waiters.clear()
    this.sseClients.clear()
    this.logger.info('detached')
  }

  bindPatch(patch: PatchBinding | null, error?: string): void {
    this.patch = patch
    this.patchError = error
  }

  reconfigure(partial: Partial<InterceptorConfig>): void {
    this.config = this.normalizeConfig({ ...this.config, ...partial })
    this.mode = this.config.mode
  }

  // ── inbound capture ──────────────────────────────────────────────────────

  /** Observe non-message lifecycle events (`ready`, `resumed`, `error`, ...). */
  observeEvent(bot: any, event: string, args: any[]): void {
    if (!this.attached) return
    this.bindBot(bot)
    if (event !== 'ready' && event !== 'resumed' && event !== 'error' && event !== 'disconnected') {
      return
    }
    const detail =
      event === 'error'
        ? describeError(args[0])
        : event === 'disconnected'
          ? `code=${args[0]?.code ?? '?'}${args[0]?.reason ? ` reason=${args[0].reason}` : ''}`
          : undefined
    this.lastEvent = { type: event, at: nowIso(), ...(detail ? { detail } : {}) }
    if (event === 'ready' || event === 'resumed') {
      this.logger.info(`QQBot ${event} (appId=${this.appId ?? '?'})`)
    }
  }

  /** Called from the patched SDK before its middleware chain runs. */
  captureRaw(bot: any, raw: any): void {
    if (!this.attached || !raw) return
    this.bindBot(bot)
    try {
      const scope: Scope | null =
        raw.kind === 'group' ? 'group' : raw.kind === 'c2c' ? 'c2c' : null
      if (scope === null) return
      const messageId = typeof raw.messageId === 'string' ? raw.messageId : ''
      if (!messageId) return
      if (this.byMessageId.has(messageId)) return

      const peerId =
        scope === 'group' ? (raw.groupOpenid ?? raw.senderId) : raw.senderId
      if (!peerId) return

      const receivedAtMs = Date.now()
      const record: InboundMessage = {
        id: `in_${++this.inSeq}`,
        seq: this.inSeq,
        receivedAt: nowIso(receivedAtMs),
        receivedAtMs,
        kind: typeof raw.kind === 'string' ? raw.kind : scope,
        scope,
        peerId,
        senderId: typeof raw.senderId === 'string' ? raw.senderId : '',
        ...(typeof raw.senderName === 'string' ? { senderName: raw.senderName } : {}),
        messageId,
        content: typeof raw.content === 'string' ? raw.content : '',
        rawContent: typeof raw.content === 'string' ? raw.content : '',
        wasMentioned: false,
        actionable: false,
        status: 'received',
        ...(typeof raw.groupOpenid === 'string' ? { groupOpenid: raw.groupOpenid } : {}),
        ...(typeof raw.channelId === 'string' ? { channelId: raw.channelId } : {}),
        ...(typeof raw.guildId === 'string' ? { guildId: raw.guildId } : {}),
        ...(typeof raw.rawEventType === 'string' ? { rawEventType: raw.rawEventType } : {}),
        mentions: Array.isArray(raw.mentions)
          ? raw.mentions.map((mention: unknown) => asRecord(mention))
          : [],
        attachments: Array.isArray(raw.attachments)
          ? raw.attachments.map((attachment: any) => mapAttachment(attachment))
          : [],
        replyTarget: { scope, targetId: peerId, msgId: messageId },
      }
      this.pushInbound(record)
      this.notify()
      if (this.config.debug) {
        this.logger.info(`← ${record.id} ${scope}:${peerId} msg=${messageId}`)
      }
    } catch (error) {
      this.logger.warn('captureRaw failed:', describeError(error))
    }
  }

  /**
   * Called from the patched `emit('message')` after qqbot's middleware chain.
   * Returns true when the message was swallowed (intercept mode).
   */
  async handleMessageEmit(
    bot: any,
    ctx: any,
    msg: any,
    originalEmit: (...args: any[]) => any,
  ): Promise<boolean> {
    if (!this.attached) {
      await originalEmit.call(bot, 'message', ctx, msg)
      return false
    }
    this.bindBot(bot)
    const record = this.upsertActionable(ctx, msg)
    if (this.mode === 'intercept') {
      record.status = 'intercepted'
      this.held.set(record.id, {
        bot,
        ctx,
        messageId: record.messageId,
        heldAt: Date.now(),
      })
      this.notify()
      if (this.config.debug) {
        this.logger.info(`⏸ held ${record.id} (${record.scope}:${record.peerId})`)
      }
      return true
    }
    record.status = 'passed'
    this.notify()
    await originalEmit.call(bot, 'message', ctx, msg)
    return false
  }

  /** Called from the patched `emit('interaction')`. */
  async handleInteractionEmit(
    bot: any,
    ctx: any,
    event: any,
    originalEmit: (...args: any[]) => any,
  ): Promise<boolean> {
    if (!this.attached) {
      await originalEmit.call(bot, 'interaction', ctx, event)
      return false
    }
    this.bindBot(bot)
    const record = this.recordInteraction(event)
    if (this.mode !== 'intercept') {
      record.status = 'passed'
      this.notify()
      await originalEmit.call(bot, 'interaction', ctx, event)
      return false
    }
    record.status = 'held'
    this.notify()
    if (this.config.ackInteractions && typeof bot.acknowledgeInteraction === 'function') {
      try {
        await bot.acknowledgeInteraction(event.id, 0)
        record.acked = true
        this.notify()
      } catch (error) {
        this.logger.warn(`ack interaction ${record.interactionId} failed:`, describeError(error))
      }
    }
    return true
  }

  // ── outbound capture ─────────────────────────────────────────────────────

  beginOutbound(bot: any, method: string, args: any[]): string | undefined {
    if (!this.attached) return undefined
    this.bindBot(bot)
    try {
      const payload = this.describeOutbound(method, args)
      if (!payload) return undefined
      const sentAtMs = Date.now()
      const record: OutboundMessage = {
        id: `out_${++this.outSeq}`,
        seq: this.outSeq,
        sentAt: nowIso(sentAtMs),
        sentAtMs,
        target: payload.target,
        type: payload.type,
        content: truncate(payload.content, 4000),
        ok: true,
        via: this.sendOrigin.getStore()?.via ?? 'qqbot',
      }
      this.outbox.push(record)
      this.outboundById.set(record.id, record)
      if (this.outbox.length > this.config.ringSize) {
        const removed = this.outbox.splice(0, this.outbox.length - this.config.ringSize)
        for (const item of removed) this.outboundById.delete(item.id)
      }
      return record.id
    } catch (error) {
      this.logger.warn('beginOutbound failed:', describeError(error))
      return undefined
    }
  }

  finishOutbound(id: string | undefined, result: any): void {
    if (!id) return
    const record = this.outboundById.get(id)
    if (!record) return
    const messageId = readMessageId(result)
    if (messageId) record.messageId = messageId
    record.ok = true
    this.notify()
  }

  failOutbound(id: string | undefined, error: unknown): void {
    if (!id) return
    const record = this.outboundById.get(id)
    if (!record) return
    record.ok = false
    record.error = describeError(error)
    this.notify()
  }

  /** Run `fn` so outbound sends made inside it are attributed to this plugin. */
  runAsApi<T>(fn: () => Promise<T>): Promise<T> {
    return this.sendOrigin.run({ via: 'api' }, fn)
  }

  // ── public operations ────────────────────────────────────────────────────

  async send(input: SendMessageInput): Promise<SendReceipt> {
    if (!this.attached) throw new BridgeError('NOT_ATTACHED', 'qqbot-interceptor is not active')
    const bot = this.bot
    if (!bot || typeof bot.send !== 'function') {
      throw new BridgeError(
        'BOT_NOT_BOUND',
        'QQBot instance is not bound yet; wait for the first inbound message after the plugin loads',
      )
    }
    const target = this.resolveTarget(input)
    const payload: Record<string, unknown> = {
      target: {
        scope: target.scope,
        targetId: target.targetId,
        ...(target.msgId ? { msgId: target.msgId } : {}),
      },
    }
    if (input.keyboard) payload.keyboard = input.keyboard
    if (target.eventId) payload.extra = { event_id: target.eventId }

    const useMarkdown = input.markdown !== undefined || input.format === 'markdown'
    const body = useMarkdown ? (input.markdown ?? input.text ?? '') : (input.text ?? '')
    if (!body.trim()) {
      throw new BridgeError('INVALID_ARGUMENT', 'send requires non-empty `text` or `markdown`')
    }
    if (useMarkdown) {
      payload.msgType = 2
      payload.markdown = { content: body }
    } else {
      payload.content = body
    }

    const result = (await this.runAsApi(() => bot.send(payload)).catch((error: unknown) => {
      throw new BridgeError('SEND_FAILED', describeError(error))
    })) as any
    return {
      ...(readMessageId(result) ? { messageId: readMessageId(result) } : {}),
      target: `${target.scope}:${target.targetId}`,
      type: useMarkdown ? 'markdown' : 'text',
    }
  }

  release(id: string): { released: boolean; id: string } {
    if (!this.config.allowRelease) {
      throw new BridgeError('RELEASE_DISABLED', 'release is disabled by configuration')
    }
    const record = this.inboundById.get(id)
    if (!record) throw new BridgeError('NOT_FOUND', `unknown inbound id: ${id}`)
    const held = this.held.get(id)
    if (!held) {
      throw new BridgeError(
        'RELEASE_UNAVAILABLE',
        `inbound ${id} is not held (status=${record.status}); nothing to release`,
      )
    }
    const originalEmit = this.patch?.originalEmit
    if (!originalEmit) throw new BridgeError('NOT_ATTACHED', 'SDK patch is unavailable')

    this.held.delete(id)
    record.status = 'released'
    record.releasedAt = nowIso()
    this.notify()
    void Promise.resolve(originalEmit.call(held.bot, 'message', held.ctx, held.ctx.message)).catch(
      (error: unknown) => {
        this.logger.error(`release ${id} failed:`, describeError(error))
      },
    )
    return { released: true, id }
  }

  queryInbound(query: InboundQuery = {}): InboundResult {
    const limit = clamp(query.limit ?? 20, 1, 200)
    const since = query.since
    let items = this.inbox
    if (since !== undefined) items = items.filter((item) => item.seq > since)
    if (query.scope) items = items.filter((item) => item.scope === query.scope)
    if (query.peerId) items = items.filter((item) => item.peerId === query.peerId)
    if (query.actionableOnly) items = items.filter((item) => item.actionable)
    const selected = items.slice(-limit)
    const last = this.inbox[this.inbox.length - 1]
    return {
      messages: cloneJson(selected),
      nextSince: selected.length > 0 ? (selected[selected.length - 1]?.seq ?? 0) : (since ?? last?.seq ?? 0),
    }
  }

  async queryInboundAsync(query: InboundQuery = {}, signal?: AbortSignal): Promise<InboundResult> {
    const waitMs = clamp(query.waitMs ?? 0, 0, 60_000)
    let result = this.queryInbound(query)
    if (result.messages.length > 0 || waitMs === 0) return result
    const before = this.revision
    await this.waitForChange(waitMs, signal)
    if (signal?.aborted) return result
    result = this.queryInbound(query)
    if (result.messages.length === 0 && this.revision === before) return result
    return result
  }

  queryOutbound(query: OutboundQuery = {}): OutboundResult {
    const limit = clamp(query.limit ?? 20, 1, 200)
    const since = query.since
    let items = this.outbox
    if (since !== undefined) items = items.filter((item) => item.seq > since)
    const selected = items.slice(-limit)
    const last = this.outbox[this.outbox.length - 1]
    return {
      messages: cloneJson(selected),
      nextSince: selected.length > 0 ? (selected[selected.length - 1]?.seq ?? 0) : (since ?? last?.seq ?? 0),
    }
  }

  async queryOutboundAsync(query: OutboundQuery = {}, signal?: AbortSignal): Promise<OutboundResult> {
    const waitMs = clamp(query.waitMs ?? 0, 0, 60_000)
    let result = this.queryOutbound(query)
    if (result.messages.length > 0 || waitMs === 0) return result
    await this.waitForChange(waitMs, signal)
    if (signal?.aborted) return result
    return this.queryOutbound(query)
  }

  queryInteractions(query: InteractionQuery = {}): InteractionResult {
    const limit = clamp(query.limit ?? 20, 1, 200)
    const since = query.since
    let items = this.interactions
    if (since !== undefined) items = items.filter((item) => item.seq > since)
    const selected = items.slice(-limit)
    const last = this.interactions[this.interactions.length - 1]
    return {
      interactions: cloneJson(selected),
      nextSince: selected.length > 0 ? (selected[selected.length - 1]?.seq ?? 0) : (since ?? last?.seq ?? 0),
    }
  }

  async queryInteractionsAsync(
    query: InteractionQuery = {},
    signal?: AbortSignal,
  ): Promise<InteractionResult> {
    const waitMs = clamp(query.waitMs ?? 0, 0, 60_000)
    let result = this.queryInteractions(query)
    if (result.interactions.length > 0 || waitMs === 0) return result
    await this.waitForChange(waitMs, signal)
    if (signal?.aborted) return result
    return this.queryInteractions(query)
  }

  conversations(): ConversationSummary[] {
    const seen = new Set<string>()
    const result: ConversationSummary[] = []
    for (let i = this.inbox.length - 1; i >= 0; i -= 1) {
      const item = this.inbox[i]
      if (!item || !item.scope || !item.peerId) continue
      const key = `${item.scope}:${item.peerId}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push({
        scope: item.scope,
        peerId: item.peerId,
        ...(item.senderName ? { senderName: item.senderName } : {}),
        senderId: item.senderId,
        lastMessageId: item.messageId,
        lastAt: item.receivedAt,
        lastContent: truncate(item.content, 500),
        inboundId: item.id,
        actionable: item.actionable,
      })
    }
    return result
  }

  setMode(mode: unknown): InterceptMode {
    const next = normalizeMode(mode, this.mode)
    if (next === this.mode) return this.mode
    this.mode = next
    this.logger.info(`mode → ${this.mode}`)
    this.notify()
    return this.mode
  }

  health(): Record<string, unknown> {
    return {
      ok: true,
      plugin: 'dsh-qqbot-interceptor',
      version: this.version,
      mode: this.mode,
      attached: this.attached,
      patched: this.patch !== null,
      ...(this.patchError ? { patchError: this.patchError } : {}),
      ...(this.patch ? { sdkPatchedAt: nowIso(this.patch.installedAt), sdkVersion: this.patch.sdkVersion } : {}),
      botSeen: this.bot !== null,
      ...(this.appId ? { appId: this.appId } : {}),
      ...(this.lastEvent ? { lastEvent: this.lastEvent } : {}),
      http: {
        enabled: this.httpUrl !== undefined,
        ...(this.httpUrl ? { url: this.httpUrl } : {}),
        ...(this.httpError ? { error: this.httpError } : {}),
        tokenRequired: true,
      },
      counts: {
        inbound: this.inbox.length,
        outbound: this.outbox.length,
        interactions: this.interactions.length,
        held: this.held.size,
      },
      startedAt: nowIso(this.startedAt),
    }
  }

  // ── HTTP / SSE ───────────────────────────────────────────────────────────

  private async startHttp(): Promise<void> {
    if (this.server || this.config.port === 0) return
    const server = createServer((req, res) => {
      void this.handleHttp(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          sendError(res, error)
        } else {
          res.end()
        }
      })
    })
    this.server = server
    await new Promise<void>((resolve) => {
      const onError = (error: unknown): void => {
        this.httpError = describeError(error)
        this.logger.warn(`http listen failed: ${describeError(error)}`)
        this.server = null
        resolve()
      }
      server.once('error', onError)
      server.listen(this.config.port, this.config.host, () => {
        server.off('error', onError)
        this.httpError = undefined
        const address = server.address()
        this.httpPort =
          address !== null && typeof address === 'object' ? address.port : this.config.port
        this.httpUrl = `http://${this.config.host}:${this.httpPort}`
        this.heartbeat = setInterval(() => this.pingSse(), 15_000)
        this.heartbeat.unref?.()
        void this.writeApiInfo()
        this.logger.info(`http listening on ${this.httpUrl}`)
        resolve()
      })
    })
  }

  private stopHttp(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
    const server = this.server
    this.server = null
    this.httpUrl = undefined
    for (const client of this.sseClients) {
      try {
        client.res.end()
      } catch {
        // ignore
      }
    }
    this.sseClients.clear()
    if (server) {
      server.closeAllConnections?.()
      server.close(() => {})
    }
  }

  private async writeApiInfo(): Promise<void> {
    if (!this.httpUrl) return
    try {
      const dir = this.resolveDataDir()
      await mkdir(dir, { recursive: true })
      const file = join(dir, 'api.json')
      const info = {
        version: 1,
        url: this.httpUrl,
        token: this.config.token,
        pid: process.pid,
        appId: this.appId ?? null,
        mode: this.mode,
        startedAt: nowIso(this.startedAt),
      }
      await writeFile(file, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 })
      if (this.config.debug) this.logger.info(`api info written to ${file}`)
    } catch (error) {
      this.logger.warn('write api.json failed:', describeError(error))
    }
  }

  private resolveDataDir(): string {
    if (this.config.dataDir) return this.config.dataDir
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return join(home, DEFAULT_DATA_SUBDIR)
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, this.health())
      return
    }
    if (!this.isAuthorized(req, url)) {
      sendJson(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'missing or invalid token' } })
      return
    }

    if (method === 'GET' && path === '/inbox') {
      const result = await this.queryInboundAsync(
        {
          ...(url.searchParams.has('since') ? { since: Number(url.searchParams.get('since')) } : {}),
          ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
          ...(url.searchParams.has('waitMs') ? { waitMs: Number(url.searchParams.get('waitMs')) } : {}),
          ...(url.searchParams.get('scope') === 'c2c' || url.searchParams.get('scope') === 'group'
            ? { scope: url.searchParams.get('scope') as Scope }
            : {}),
          ...(url.searchParams.get('peerId') ? { peerId: url.searchParams.get('peerId') as string } : {}),
          ...(url.searchParams.get('actionable') === '1' || url.searchParams.get('actionable') === 'true'
            ? { actionableOnly: true }
            : {}),
        },
        abortSignalFor(req, res),
      )
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (method === 'GET' && path === '/outbox') {
      const result = await this.queryOutboundAsync(
        {
          ...(url.searchParams.has('since') ? { since: Number(url.searchParams.get('since')) } : {}),
          ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
          ...(url.searchParams.has('waitMs') ? { waitMs: Number(url.searchParams.get('waitMs')) } : {}),
        },
        abortSignalFor(req, res),
      )
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (method === 'GET' && path === '/interactions') {
      const result = await this.queryInteractionsAsync(
        {
          ...(url.searchParams.has('since') ? { since: Number(url.searchParams.get('since')) } : {}),
          ...(url.searchParams.has('limit') ? { limit: Number(url.searchParams.get('limit')) } : {}),
          ...(url.searchParams.has('waitMs') ? { waitMs: Number(url.searchParams.get('waitMs')) } : {}),
        },
        abortSignalFor(req, res),
      )
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (method === 'GET' && path === '/conversations') {
      sendJson(res, 200, { ok: true, conversations: this.conversations() })
      return
    }

    if (method === 'GET' && path === '/mode') {
      sendJson(res, 200, { ok: true, mode: this.mode })
      return
    }

    if (method === 'POST' && path === '/mode') {
      const body = asRecord(await readJsonBody(req))
      if (body.mode !== 'observe' && body.mode !== 'intercept') {
        throw new BridgeError('INVALID_ARGUMENT', 'mode must be "observe" or "intercept"')
      }
      const mode = this.setMode(body.mode)
      sendJson(res, 200, { ok: true, mode })
      return
    }

    if (method === 'POST' && path === '/send') {
      const body = asRecord(await readJsonBody(req))
      const receipt = await this.send(body as SendMessageInput)
      sendJson(res, 200, { ok: true, receipt })
      return
    }

    if (method === 'POST' && path === '/release') {
      const body = asRecord(await readJsonBody(req))
      const id = typeof body.id === 'string' ? body.id : ''
      if (!id) throw new BridgeError('INVALID_ARGUMENT', 'release requires `id`')
      const result = this.release(id)
      sendJson(res, 200, { ok: true, ...result })
      return
    }

    if (method === 'GET' && path === '/stream') {
      this.openSse(req, res, url)
      return
    }

    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `no route for ${method} ${path}` } })
  }

  private isAuthorized(req: IncomingMessage, url: URL): boolean {
    const expected = this.config.token
    if (!expected) return true
    const header = req.headers.authorization
    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      if (timingSafeEqual(header.slice(7), expected)) return true
    }
    const direct = req.headers['x-qqbot-token']
    if (typeof direct === 'string' && timingSafeEqual(direct, expected)) return true
    const query = url.searchParams.get('token')
    return query !== null && timingSafeEqual(query, expected)
  }

  private openSse(req: IncomingMessage, res: ServerResponse, url: URL): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    const since = Number(url.searchParams.get('since') ?? '0')
    const client: SseClient = {
      res,
      inSeq: Number.isFinite(since) ? since : 0,
      outSeq: Number.isFinite(since) ? since : 0,
      intSeq: Number.isFinite(since) ? since : 0,
    }
    this.sseClients.add(client)
    this.flushSse(client)
    req.on('close', () => {
      this.sseClients.delete(client)
    })
  }

  private flushSse(client: SseClient): void {
    try {
      const inbound = this.inbox.filter((item) => item.seq > client.inSeq)
      if (inbound.length > 0) {
        for (const item of inbound) {
          writeSse(client.res, 'inbound', item)
          client.inSeq = item.seq
        }
      }
      const outbound = this.outbox.filter((item) => item.seq > client.outSeq)
      if (outbound.length > 0) {
        for (const item of outbound) {
          writeSse(client.res, 'outbound', item)
          client.outSeq = item.seq
        }
      }
      const interactions = this.interactions.filter((item) => item.seq > client.intSeq)
      if (interactions.length > 0) {
        for (const item of interactions) {
          writeSse(client.res, 'interaction', item)
          client.intSeq = item.seq
        }
      }
    } catch {
      this.sseClients.delete(client)
    }
  }

  private pingSse(): void {
    for (const client of this.sseClients) {
      try {
        client.res.write(': ping\n\n')
      } catch {
        this.sseClients.delete(client)
      }
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  private bindBot(bot: any): void {
    if (!bot) return
    this.bot = bot
    try {
      const appId = typeof bot.appId === 'string' ? bot.appId : undefined
      if (appId) this.appId = appId
    } catch {
      // ignore getter failures
    }
  }

  private pushInbound(record: InboundMessage): void {
    this.inbox.push(record)
    this.inboundById.set(record.id, record)
    this.byMessageId.set(record.messageId, record)
    if (this.inbox.length > this.config.ringSize) {
      const removed = this.inbox.splice(0, this.inbox.length - this.config.ringSize)
      for (const item of removed) {
        this.inboundById.delete(item.id)
        this.byMessageId.delete(item.messageId)
        this.held.delete(item.id)
      }
    }
  }

  private upsertActionable(ctx: any, msg: any): InboundMessage {
    const messageId = typeof msg?.messageId === 'string' ? msg.messageId : ''
    let record = messageId ? this.byMessageId.get(messageId) : undefined
    if (!record) {
      // The raw hook missed it (plugin loaded mid-flight); synthesize one.
      const scope: Scope | null =
        msg?.kind === 'group' ? 'group' : msg?.kind === 'c2c' ? 'c2c' : null
      const peerId =
        scope === 'group' ? (msg?.groupOpenid ?? msg?.senderId) : (msg?.senderId ?? null)
      const replyTarget = msg?.replyTarget as ReplyTargetInfo | undefined
      const receivedAtMs = Date.now()
      record = {
        id: `in_${++this.inSeq}`,
        seq: this.inSeq,
        receivedAt: nowIso(receivedAtMs),
        receivedAtMs,
        kind: typeof msg?.kind === 'string' ? msg.kind : (scope ?? 'unknown'),
        scope,
        peerId: peerId ?? null,
        senderId: typeof msg?.senderId === 'string' ? msg.senderId : '',
        ...(typeof msg?.senderName === 'string' ? { senderName: msg.senderName } : {}),
        messageId,
        content: typeof msg?.content === 'string' ? msg.content : '',
        rawContent: typeof msg?.content === 'string' ? msg.content : '',
        wasMentioned: false,
        actionable: false,
        status: 'received',
        ...(typeof msg?.groupOpenid === 'string' ? { groupOpenid: msg.groupOpenid } : {}),
        ...(typeof msg?.rawEventType === 'string' ? { rawEventType: msg.rawEventType } : {}),
        mentions: Array.isArray(msg?.mentions)
          ? msg.mentions.map((mention: unknown) => asRecord(mention))
          : [],
        attachments: Array.isArray(msg?.attachments)
          ? msg.attachments.map((attachment: any) => mapAttachment(attachment))
          : [],
        replyTarget: replyTarget ?? (scope && peerId ? { scope, targetId: peerId, msgId: messageId } : null),
      }
      this.pushInbound(record)
    }

    record.actionable = true
    record.processedAt = nowIso()
    if (typeof msg?.content === 'string') record.content = msg.content
    const mention = ctx?.state?.mention
    if (mention && typeof mention === 'object' && 'wasMentioned' in mention) {
      record.wasMentioned = mention.wasMentioned === true
    }
    if (typeof ctx?.state?.envelope === 'string') {
      record.envelope = truncate(ctx.state.envelope, 8000)
    }
    if (Array.isArray(ctx?.state?.history)) {
      record.historyCount = ctx.state.history.length
    }
    if (msg?.replyTarget) {
      record.replyTarget = msg.replyTarget
      if (msg.replyTarget.scope === 'c2c' || msg.replyTarget.scope === 'group') {
        record.scope = msg.replyTarget.scope
        record.peerId = msg.replyTarget.targetId
      }
    }
    this.enrichFromContext(record, ctx, msg)
    return record
  }

  private enrichFromContext(record: InboundMessage, ctx: any, msg: any): void {
    const state = ctx?.state ?? {}
    const downloaded = new Map<string, string>()
    if (Array.isArray(state.downloadedFiles)) {
      for (const item of state.downloadedFiles) {
        if (item && typeof item.filename === 'string' && typeof item.localPath === 'string') {
          downloaded.set(item.filename, item.localPath)
        }
      }
    }
    if (Array.isArray(msg?.attachments)) {
      record.attachments = msg.attachments.map((attachment: any) =>
        mapAttachment(attachment, downloaded.get(attachment.fileName ?? attachment.filename)),
      )
    }
    const quote = state.quote
    if (quote && typeof quote === 'object') {
      const text =
        typeof quote.text === 'string'
          ? quote.text
          : typeof quote.entry?.content === 'string'
            ? quote.entry.content
            : undefined
      const quoteAttachments = Array.isArray(quote.attachments)
        ? quote.attachments.map((attachment: any) => mapAttachment(attachment))
        : undefined
      if (text || quoteAttachments) {
        record.quote = {
          ...(text ? { text: truncate(text, 2000) } : {}),
          ...(typeof quote.entry?.messageId === 'string'
            ? { messageId: quote.entry.messageId }
            : {}),
          ...(quoteAttachments ? { attachments: quoteAttachments } : {}),
        }
      }
    }
  }

  private recordInteraction(event: any): Interaction {
    const interactionId = typeof event?.id === 'string' ? event.id : `unknown_${this.intSeq + 1}`
    const existing = this.interactions.find((item) => item.interactionId === interactionId)
    if (existing) return existing
    const scope: Scope = event?.scene === 'group' ? 'group' : 'c2c'
    const targetId =
      scope === 'group'
        ? (event?.group_openid ?? event?.user_openid ?? '')
        : (event?.user_openid ?? event?.group_openid ?? '')
    const rawButton = event?.data?.resolved?.button_data
    const receivedAtMs = Date.now()
    const record: Interaction = {
      id: `int_${++this.intSeq}`,
      seq: this.intSeq,
      receivedAt: nowIso(receivedAtMs),
      receivedAtMs,
      interactionId,
      scope,
      targetId: String(targetId),
      ...(typeof event?.user_openid === 'string' ? { userId: event.user_openid } : {}),
      ...(typeof event?.group_openid === 'string' ? { groupOpenid: event.group_openid } : {}),
      ...(typeof rawButton === 'string'
        ? { buttonData: rawButton }
        : rawButton !== undefined
          ? { buttonData: JSON.stringify(rawButton) }
          : {}),
      ...(event?.data?.resolved !== undefined ? { data: cloneJson(event.data.resolved) } : {}),
      status: 'held',
      acked: false,
    }
    this.interactions.push(record)
    this.interactionById.set(record.id, record)
    if (this.interactions.length > this.config.ringSize) {
      const removed = this.interactions.splice(0, this.interactions.length - this.config.ringSize)
      for (const item of removed) this.interactionById.delete(item.id)
    }
    return record
  }

  private resolveTarget(input: SendMessageInput): {
    scope: Scope
    targetId: string
    msgId?: string
    eventId?: string
  } {
    let scope: Scope | undefined
    let targetId: string | undefined
    if (input.target) {
      const parsed = parseTarget(input.target)
      if (!parsed) throw new BridgeError('INVALID_ARGUMENT', `bad target: ${input.target}`)
      scope = parsed.scope
      targetId = parsed.targetId
    }

    if (input.replyTo) {
      const inbound = this.inboundById.get(input.replyTo)
      if (inbound) {
        const target = inbound.replyTarget
        if (!target) throw new BridgeError('INVALID_ARGUMENT', `${input.replyTo} has no reply target`)
        scope ??= target.scope
        targetId ??= target.targetId
        const msgId = target.msgId
        if (msgId && Date.now() - inbound.receivedAtMs <= this.config.maxPassiveAgeMs) {
          return { scope, targetId, msgId }
        }
        return { scope, targetId }
      }
      const interaction = this.interactionById.get(input.replyTo)
      if (interaction) {
        scope ??= interaction.scope
        targetId ??= interaction.targetId
        return { scope, targetId, eventId: interaction.interactionId }
      }
      if (!scope || !targetId) {
        throw new BridgeError(
          'INVALID_ARGUMENT',
          `unknown replyTo "${input.replyTo}"; use an inbound id (in_N), an interaction id (int_N), or pass target`,
        )
      }
      return { scope, targetId, msgId: input.replyTo }
    }

    if (input.eventId) {
      if (!scope || !targetId) {
        const latest = this.interactions[this.interactions.length - 1]
        if (latest) {
          scope ??= latest.scope
          targetId ??= latest.targetId
        }
      }
      if (!scope || !targetId) {
        throw new BridgeError('INVALID_ARGUMENT', 'eventId needs a target (or a prior interaction)')
      }
      return { scope, targetId, eventId: input.eventId }
    }

    if (scope && targetId) {
      return input.msgId ? { scope, targetId, msgId: input.msgId } : { scope, targetId }
    }

    const latest = this.latestInbound()
    if (latest?.replyTarget) {
      const target = latest.replyTarget
      const fresh = Date.now() - latest.receivedAtMs <= this.config.maxPassiveAgeMs
      return {
        scope: target.scope,
        targetId: target.targetId,
        ...(fresh && target.msgId ? { msgId: target.msgId } : {}),
      }
    }
    throw new BridgeError(
      'INVALID_ARGUMENT',
      'send requires target ("c2c:<openid>" / "group:<group_openid>") or replyTo',
    )
  }

  private latestInbound(): InboundMessage | undefined {
    for (let i = this.inbox.length - 1; i >= 0; i -= 1) {
      const item = this.inbox[i]
      if (item?.replyTarget) return item
    }
    return undefined
  }

  private describeOutbound(
    method: string,
    args: any[],
  ): { target: OutboundMessage['target']; type: OutboundMessage['type']; content: string } | undefined {
    if (method === 'send') {
      const opts = args[0] ?? {}
      const target = opts.target ?? {}
      const markdown = typeof opts.markdown?.content === 'string' ? opts.markdown.content : undefined
      const content = markdown ?? (typeof opts.content === 'string' ? opts.content : '')
      const type: OutboundMessage['type'] = markdown !== undefined ? 'markdown' : 'text'
      return { target: normalizeOutboundTarget(target), type, content }
    }
    if (method === 'sendText' || method === 'sendTextWithKeyboard') {
      return {
        target: normalizeOutboundTarget(args[0]),
        type: 'text',
        content: typeof args[1] === 'string' ? args[1] : '',
      }
    }
    if (method === 'sendChannelMessage') {
      const opts = args[2] ?? {}
      return {
        target: { scope: 'channel', targetId: String(args[0] ?? '') },
        type: 'channel',
        content: typeof args[1] === 'string' ? args[1] : '',
      }
    }
    const target = normalizeOutboundTarget(args[0])
    const source = args[1] ?? {}
    const descriptor =
      typeof source.localPath === 'string'
        ? source.localPath
        : typeof source.url === 'string'
          ? source.url
          : typeof source.fileData === 'string'
            ? '[inline data]'
            : ''
    const type: OutboundMessage['type'] =
      method === 'sendImage'
        ? 'image'
        : method === 'sendVideo'
          ? 'video'
          : method === 'sendVoice'
            ? 'voice'
            : method === 'sendFile'
              ? 'file'
              : 'unknown'
    const content =
      method === 'sendFile' && typeof args[2]?.fileName === 'string'
        ? args[2].fileName
        : descriptor
    return { target, type, content }
  }

  private notify(): void {
    this.revision += 1
    if (this.waiters.size > 0) {
      for (const wake of [...this.waiters]) wake()
      this.waiters.clear()
    }
    for (const client of this.sseClients) this.flushSse(client)
  }

  private async waitForChange(waitMs: number, signal?: AbortSignal): Promise<void> {
    if (waitMs <= 0) return
    if (signal?.aborted) return
    await new Promise<void>((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const done = (): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.waiters.delete(done)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      timer = setTimeout(done, waitMs)
      this.waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  private normalizeConfig(input: unknown): InterceptorConfig {
    const raw = (input ?? {}) as Record<string, unknown>
    const port = Number(raw.port ?? 7333)
    const ringSize = Number(raw.ringSize ?? 500)
    const maxPassiveAgeMs = Number(raw.maxPassiveAgeMs ?? 4.5 * 60_000)
    return {
      mode: normalizeMode(raw.mode, 'observe'),
      host: typeof raw.host === 'string' && raw.host ? raw.host : '127.0.0.1',
      port: Number.isFinite(port) ? clamp(port, 0, 65535) : 7333,
      token:
        typeof raw.token === 'string' && raw.token.length > 0 ? raw.token : this.tokenSeed,
      ringSize: Number.isFinite(ringSize) ? clamp(ringSize, 10, 5000) : 500,
      ackInteractions: raw.ackInteractions !== false,
      allowRelease: raw.allowRelease !== false,
      maxPassiveAgeMs:
        Number.isFinite(maxPassiveAgeMs) && maxPassiveAgeMs >= 0
          ? maxPassiveAgeMs
          : 4.5 * 60_000,
      dataDir: typeof raw.dataDir === 'string' ? raw.dataDir : '',
      debug: raw.debug === true,
    }
  }
}

export function getOrCreateBridge(): Bridge {
  const store = globalThis as Record<symbol, unknown>
  const existing = store[GLOBAL_BRIDGE_KEY]
  if (isBridge(existing)) {
    // HMR loads a fresh module generation; keep the buffers/server but move the
    // instance onto the new class prototype so method changes take effect.
    if (Object.getPrototypeOf(existing) !== Bridge.prototype) {
      Object.setPrototypeOf(existing, Bridge.prototype)
    }
    return existing
  }
  const bridge = new Bridge()
  store[GLOBAL_BRIDGE_KEY] = bridge
  return bridge
}

export function getActiveBridge(): Bridge | null {
  const store = globalThis as Record<symbol, unknown>
  const bridge = store[GLOBAL_BRIDGE_KEY]
  if (isBridge(bridge) && bridge.isAttached) return bridge
  return null
}

function isBridge(value: unknown): value is Bridge {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __kind?: unknown }).__kind === 'qqbot-interceptor-bridge' &&
    typeof (value as { attach?: unknown }).attach === 'function'
  )
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

function normalizeOutboundTarget(target: any): OutboundMessage['target'] {
  const scope = typeof target?.scope === 'string' ? target.scope : 'unknown'
  const targetId = typeof target?.targetId === 'string' ? target.targetId : ''
  const msgId = typeof target?.msgId === 'string' ? target.msgId : undefined
  const eventId = typeof target?.eventId === 'string' ? target.eventId : undefined
  return {
    scope,
    targetId,
    ...(msgId ? { msgId } : {}),
    ...(eventId ? { eventId } : {}),
  }
}

function readMessageId(result: any): string | undefined {
  if (!result) return undefined
  if (typeof result.id === 'string') return result.id
  if (typeof result.message?.id === 'string') return result.message.id
  return undefined
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function statusFor(error: unknown): number {
  if (error instanceof BridgeError) {
    switch (error.code) {
      case 'INVALID_ARGUMENT':
      case 'INVALID_JSON':
        return 400
      case 'UNAUTHORIZED':
        return 401
      case 'RELEASE_DISABLED':
        return 403
      case 'NOT_FOUND':
        return 404
      case 'RELEASE_UNAVAILABLE':
        return 409
      case 'PAYLOAD_TOO_LARGE':
        return 413
      case 'SEND_FAILED':
        return 502
      case 'NOT_ATTACHED':
      case 'BOT_NOT_BOUND':
        return 503
      default:
        return 500
    }
  }
  const code = (error as { code?: unknown })?.code
  if (code === 'INVALID_ARGUMENT' || code === 'INVALID_JSON') return 400
  if (code === 'NOT_FOUND') return 404
  if (code === 'RELEASE_UNAVAILABLE') return 409
  if (code === 'SEND_FAILED') return 502
  if (code === 'NOT_ATTACHED' || code === 'BOT_NOT_BOUND') return 503
  return 500
}

function sendError(res: ServerResponse, error: unknown): void {
  const code = (error as { code?: unknown })?.code
  sendJson(res, statusFor(error), {
    ok: false,
    error: {
      code: typeof code === 'string' ? code : 'INTERNAL',
      message: describeError(error),
    },
  })
}

async function readJsonBody(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > limit) throw new BridgeError('PAYLOAD_TOO_LARGE', 'request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new BridgeError('INVALID_JSON', 'request body is not valid JSON')
  }
}

function abortSignalFor(req: IncomingMessage, res: ServerResponse): AbortSignal {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  req.on('close', abort)
  res.on('close', abort)
  return controller.signal
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
