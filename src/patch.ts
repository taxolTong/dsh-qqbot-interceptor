/**
 * Runtime tap on the QQ Bot SDK.
 *
 * The qqbot dsh plugin creates its `QQBot` instance inside `bootstrapGateway`
 * and keeps it private. Rather than replacing that plugin or opening a second
 * websocket, this module patches three prototype seams of the SDK class:
 *
 *  - `handleInboundMessage` — capture the raw inbound message before qqbot's
 *    middleware chain runs (all messages, including non-@ group chatter);
 *  - `emit` — capture the post-middleware `message` event and, in intercept
 *    mode, swallow it before `bot.on('message')` reaches the dsh agent;
 *  - the public send methods — record every outbound message, including the
 *    ones this plugin sends itself.
 *
 * `emit` is private in TypeScript but a regular prototype method at runtime.
 * The patch is installed once per process and delegates to whichever Bridge is
 * currently attached, so plugin HMR reloads keep working without re-wrapping.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { getActiveBridge, type PatchBinding } from './bridge'
import { describeError } from './util'

const GLOBAL_PATCH_KEY = Symbol.for('dsh-qqbot-interceptor/patch/v1')

interface PatchState extends PatchBinding {
  proto: Record<string, any>
  originals: Record<string, (...args: any[]) => any>
}

export interface PatchResult {
  ok: boolean
  binding?: PatchBinding
  error?: string
}

function sdkVersion(): string {
  try {
    const resolved = import.meta.resolve('@tencent-connect/qqbot-nodejs')
    const packageUrl = new URL('../package.json', resolved)
    const raw = readFileSync(fileURLToPath(packageUrl), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Install (or reuse) the SDK patch. Safe to call on every plugin activation.
 * Returns a diagnostic instead of throwing so a version drift cannot take down
 * the host: the HTTP API and tools still start, and `/health` reports the error.
 */
export function installPatch(): PatchResult {
  const store = globalThis as Record<symbol, unknown>
  const existing = store[GLOBAL_PATCH_KEY] as PatchState | undefined
  if (existing) {
    return { ok: true, binding: existing }
  }

  try {
    const proto = (QQBot as unknown as { prototype: Record<string, any> }).prototype
    const required = ['handleInboundMessage', 'emit', 'send']
    const missing = required.filter((method) => typeof proto[method] !== 'function')
    if (missing.length > 0) {
      return {
        ok: false,
        error: `unsupported @tencent-connect/qqbot-nodejs: missing QQBot.prototype.${missing.join(', ')}`,
      }
    }

    const originalEmit = proto.emit as (...args: any[]) => any
    const originals: PatchState['originals'] = {
      handleInboundMessage: proto.handleInboundMessage,
      emit: originalEmit,
      send: proto.send,
    }
    const outboundMethods = [
      'sendText',
      'sendTextWithKeyboard',
      'sendChannelMessage',
      'sendImage',
      'sendVideo',
      'sendVoice',
      'sendFile',
    ] as const
    for (const method of outboundMethods) {
      if (typeof proto[method] === 'function') originals[method] = proto[method]
    }

    const state: PatchState = {
      proto,
      originals,
      originalEmit,
      installedAt: Date.now(),
      sdkVersion: sdkVersion(),
    }

    proto.handleInboundMessage = async function patchedHandleInboundMessage(this: any, raw: any) {
      const bridge = getActiveBridge()
      if (bridge) {
        try {
          bridge.captureRaw(this, raw)
        } catch (error) {
          console.warn('[qqbot-interceptor] captureRaw failed:', describeError(error))
        }
      }
      return originals.handleInboundMessage?.call(this, raw)
    }

    proto.emit = async function patchedEmit(this: any, event: string, ...args: any[]) {
      const bridge = getActiveBridge()
      if (!bridge) return originalEmit.apply(this, [event, ...args])
      try {
        bridge.observeEvent(this, event, args)
        if (event === 'message') {
          await bridge.handleMessageEmit(this, args[0], args[1], originalEmit)
          return undefined
        }
        if (event === 'interaction') {
          await bridge.handleInteractionEmit(this, args[0], args[1], originalEmit)
          return undefined
        }
      } catch (error) {
        // Never let interception break the underlying plugin: fall through.
        console.warn(
          `[qqbot-interceptor] ${event} interception failed, passing through:`,
          describeError(error),
        )
      }
      return originalEmit.apply(this, [event, ...args])
    }

    for (const method of ['send', ...outboundMethods] as const) {
      const original = originals[method]
      if (typeof original !== 'function') continue
      proto[method] = async function patchedSend(this: any, ...args: any[]) {
        const bridge = getActiveBridge()
        if (!bridge) return original.apply(this, args)
        const outboundId = bridge.beginOutbound(this, method, args)
        try {
          const result = await original.apply(this, args)
          bridge.finishOutbound(outboundId, result)
          return result
        } catch (error) {
          bridge.failOutbound(outboundId, error)
          throw error
        }
      }
    }

    store[GLOBAL_PATCH_KEY] = state
    return { ok: true, binding: state }
  } catch (error) {
    return { ok: false, error: describeError(error) }
  }
}
