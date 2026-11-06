/**
 * Public tool functions.
 *
 * These are the two functions the rest of the system is meant to use:
 *
 *   getInboundMessages()  — read the stream of messages the bot received
 *   sendOutboundMessage() — make the bot emit a message
 *
 * Both work in-process (for dsh tools and plugins). External controllers can
 * use the same operations over the local HTTP API written to
 * `$DSH_HOME/qqbot-interceptor/api.json`.
 */
import { getActiveBridge } from './bridge'
import { BridgeError } from './util'
import type {
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

function requireBridge() {
  const bridge = getActiveBridge()
  if (!bridge) {
    throw new BridgeError(
      'NOT_ATTACHED',
      'dsh-qqbot-interceptor is not active in this process. ' +
        'For external scripts use the local HTTP API in $DSH_HOME/qqbot-interceptor/api.json.',
    )
  }
  return bridge
}

/** Read (and optionally long-poll) messages the bot received. */
export async function getInboundMessages(query: InboundQuery = {}): Promise<InboundResult> {
  return requireBridge().queryInboundAsync(query)
}

/** Send a text or markdown message as the bot; returns the QQ message id. */
export async function sendOutboundMessage(input: SendMessageInput): Promise<SendReceipt> {
  return requireBridge().send(input)
}

/** Auxiliary: read messages the bot has sent (this plugin and the qqbot plugin). */
export async function getOutboundMessages(query: OutboundQuery = {}): Promise<OutboundResult> {
  return requireBridge().queryOutboundAsync(query)
}

/** Auxiliary: read button/interaction events received by the bot. */
export async function getInteractions(query: InteractionQuery = {}): Promise<InteractionResult> {
  return requireBridge().queryInteractionsAsync(query)
}

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
