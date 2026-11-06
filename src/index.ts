/**
 * dsh-qqbot-interceptor — Cordis host plugin entry.
 *
 * It attaches to the already-running `@tencent-connect/dsh-qqbot` without
 * replacing it: inbound messages can be held before they reach the dsh agent,
 * outbound sends are observable, and two tools expose the streams.
 *
 * Configuration lives in the profile `cordis.patch.yml` row:
 *
 *   - id: qqbot-interceptor
 *     name: dsh-qqbot-interceptor
 *     config:
 *       mode: intercept      # or observe
 *       port: 7333           # 0 disables the HTTP API
 *       token: ''            # empty -> random token written to api.json
 */
import { getOrCreateBridge, PLUGIN_VERSION } from './bridge'
import { installPatch } from './patch'
import { registerTools } from './tools'
import type { LoggerLike } from './types'

export const name = 'qqbot-interceptor'

export { PLUGIN_VERSION as version }

export function apply(ctx: any, config: unknown): void {
  const logger = (ctx?.logger ?? console) as LoggerLike
  const bridge = getOrCreateBridge()

  const patch = installPatch()
  if (patch.ok && patch.binding) {
    bridge.bindPatch(patch.binding)
  } else {
    bridge.bindPatch(null, patch.error)
    logger.error(
      `QQBot SDK patch failed (${patch.error ?? 'unknown error'}); ` +
        'interception is disabled but the HTTP API and tools still start.',
    )
  }

  bridge.attach(config, logger)
  registerTools(ctx, bridge, logger)

  ctx.effect(() => () => {
    bridge.detach()
  }, 'qqbot-interceptor.lifecycle')
}

export {
  getInboundMessages,
  sendOutboundMessage,
  getOutboundMessages,
  getInteractions,
} from './api'

export type {
  InboundMessage,
  InboundQuery,
  InboundResult,
  Interaction,
  InteractionQuery,
  InteractionResult,
  OutboundMessage,
  OutboundQuery,
  OutboundResult,
  SendMessageInput,
  SendReceipt,
} from './types'
