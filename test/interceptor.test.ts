import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { QQBot, contentSanitizer, mentionGate } from '@tencent-connect/qqbot-nodejs'
import { Bridge, getOrCreateBridge } from '../src/bridge'
import { installPatch } from '../src/patch'
import type { LoggerLike } from '../src/types'

const silent: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

function makeBot(): any {
  const bot = new QQBot({
    appId: 'test-app',
    appSecret: 'test-secret',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  })
  // Mirror the two middlewares that shape the record: mention detection and
  // @-marker sanitization. The rest of qqbot's chain is irrelevant here.
  bot.use(mentionGate({ requireMentionInGroup: true }))
  bot.use(contentSanitizer({ parseFaceTags: true }))
  return bot
}

function rawMessage(overrides: Record<string, unknown> = {}): any {
  return {
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    senderId: 'user-openid-1',
    senderName: 'Alice',
    content: '<@!test-app> hello bot',
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    groupOpenid: 'group-openid-1',
    mentions: [{ member_openid: 'test-app', nickname: 'Bot', is_you: true }],
    ...overrides,
  }
}

const bridge: Bridge = getOrCreateBridge()
let baseline = 0

before(() => {
  const patch = installPatch()
  assert.equal(patch.ok, true, patch.error)
  bridge.bindPatch(patch.binding ?? null, patch.error)
  bridge.attach({ mode: 'intercept', port: 0 }, silent)
})

after(() => {
  bridge.detach()
})

test('intercept holds a message until it is released into dsh', async () => {
  const bot = makeBot()
  let handled = 0
  bot.on('message', async () => {
    handled += 1
  })
  baseline = bridge.queryInbound({ limit: 1 }).nextSince

  const raw = rawMessage()
  await bot.handleInboundMessage(raw)
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(handled, 0, 'intercept mode must not call the qqbot message handler')
  const result = bridge.queryInbound({ since: baseline })
  assert.equal(result.messages.length, 1)
  const message = result.messages[0]
  assert.ok(message)
  assert.equal(message.status, 'intercepted')
  assert.equal(message.actionable, true)
  assert.equal(message.scope, 'group')
  assert.equal(message.peerId, 'group-openid-1')
  assert.equal(message.wasMentioned, true)
  assert.equal(message.content, 'hello bot')
  assert.equal(message.replyTarget?.msgId, raw.messageId)

  bridge.release(message.id)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(handled, 1, 'release must invoke the original qqbot message handler')
  assert.equal(bridge.queryInbound({ since: baseline }).messages[0]?.status, 'released')
})

test('observe lets the message through and still taps it', async () => {
  const bot = makeBot()
  let handled = 0
  bot.on('message', async () => {
    handled += 1
  })
  bridge.setMode('observe')
  baseline = bridge.queryInbound({ limit: 1 }).nextSince

  await bot.handleInboundMessage(rawMessage())
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(handled, 1)
  const message = bridge.queryInbound({ since: baseline }).messages[0]
  assert.ok(message)
  assert.equal(message.status, 'passed')
  bridge.setMode('intercept')
})

test('send records outbound traffic from both the plugin and qqbot', async () => {
  const bot = makeBot()
  await bot.handleInboundMessage(rawMessage())
  const outboundBaseline = bridge.queryOutbound({ limit: 1 }).nextSince
  const sent: any[] = []
  bot.messageApi.sendRaw = async (_scope: string, _targetId: string, _creds: unknown, body: any) => {
    sent.push(body)
    return { id: `mid-${sent.length}` }
  }

  const direct = await bot.send({
    target: { scope: 'group', targetId: 'group-openid-1', msgId: 'm1' },
    content: 'direct from qqbot',
  })
  assert.equal(direct.id, 'mid-1')

  const receipt = await bridge.send({ target: 'group:group-openid-1', text: 'from the api' })
  assert.equal(receipt.messageId, 'mid-2')
  assert.equal(receipt.type, 'text')

  const outbox = bridge.queryOutbound({ since: outboundBaseline }).messages
  assert.equal(outbox.length, 2)
  assert.equal(outbox[0]?.via, 'qqbot')
  assert.equal(outbox[0]?.content, 'direct from qqbot')
  assert.equal(outbox[1]?.via, 'api')
  assert.equal(outbox[1]?.content, 'from the api')
  assert.equal(outbox[1]?.messageId, 'mid-2')
})

test('button interactions are held and acknowledged in intercept mode', async () => {
  const bot = makeBot()
  await bot.handleInboundMessage(rawMessage())
  let handled = 0
  const acks: Array<[string, number]> = []
  bot.on('interaction', async () => {
    handled += 1
  })
  bot.acknowledgeInteraction = async (id: string, code: number) => {
    acks.push([id, code])
    return {}
  }
  const since = bridge.queryInteractions({ limit: 1 }).nextSince
  const event = {
    id: 'interaction-1',
    scene: 'group',
    group_openid: 'group-openid-1',
    user_openid: 'user-openid-1',
    data: { resolved: { button_data: '{"t":"question","q":"q1","v":0}' } },
  }

  await bot.emit('interaction', { bot, event, state: {}, receivedAt: Date.now() }, event)
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(handled, 0)
  const result = bridge.queryInteractions({ since })
  assert.equal(result.interactions.length, 1)
  assert.equal(result.interactions[0]?.status, 'held')
  assert.equal(result.interactions[0]?.acked, true)
  assert.deepEqual(acks, [['interaction-1', 0]])
})

test('duplicate gateway deliveries are captured once', async () => {
  const bot = makeBot()
  baseline = bridge.queryInbound({ limit: 1 }).nextSince
  const raw = rawMessage({ messageId: 'duplicate-msg' })
  await bot.handleInboundMessage(raw)
  await bot.handleInboundMessage({ ...raw })
  const messages = bridge.queryInbound({ since: baseline }).messages
  assert.equal(messages.length, 1)
})
