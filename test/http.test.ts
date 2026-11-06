import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { QQBot, contentSanitizer, mentionGate } from '@tencent-connect/qqbot-nodejs'
import { getOrCreateBridge } from '../src/bridge'
import { installPatch } from '../src/patch'
import type { LoggerLike } from '../src/types'

const silent: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

const PORT = 17873
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'test-token'
const bridge = getOrCreateBridge()

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeBot(): any {
  const bot = new QQBot({
    appId: 'http-test-app',
    appSecret: 'http-test-secret',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  })
  bot.use(mentionGate({ requireMentionInGroup: true }))
  bot.use(contentSanitizer({ parseFaceTags: true }))
  return bot
}

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra }
}

before(async () => {
  const patch = installPatch()
  assert.equal(patch.ok, true, patch.error)
  bridge.bindPatch(patch.binding ?? null, patch.error)
  bridge.attach({ mode: 'intercept', port: PORT, token: TOKEN }, silent)
  let ready = false
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`)
      if (response.ok) {
        ready = true
        break
      }
    } catch {
      // not listening yet
    }
    await sleep(20)
  }
  assert.equal(ready, true, 'HTTP API did not start')
})

after(() => {
  bridge.detach()
})

test('health is public and reports the runtime state', async () => {
  const response = await fetch(`${BASE}/health`)
  assert.equal(response.status, 200)
  const body: any = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.plugin, 'dsh-qqbot-interceptor')
  assert.equal(body.patched, true)
  assert.equal(body.mode, 'intercept')
})

test('protected routes require the token', async () => {
  const response = await fetch(`${BASE}/inbox`)
  assert.equal(response.status, 401)
})

test('inbox, send, release and mode work over HTTP', async () => {
  const bot = makeBot()
  let handled = 0
  bot.on('message', async () => {
    handled += 1
  })
  const sent: any[] = []
  bot.messageApi.sendRaw = async (_scope: string, _targetId: string, _creds: unknown, body: any) => {
    sent.push(body)
    return { id: `http-mid-${sent.length}` }
  }

  const raw = {
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    kind: 'group',
    senderId: 'user-openid-http',
    senderName: 'Bob',
    content: '<@!http-test-app> ping',
    messageId: 'http-msg-1',
    timestamp: new Date().toISOString(),
    groupOpenid: 'group-openid-http',
    mentions: [{ member_openid: 'http-test-app', is_you: true }],
  }
  await bot.handleInboundMessage(raw)
  await sleep(20)

  const inboxResponse = await fetch(`${BASE}/inbox?actionable=1`, { headers: auth() })
  assert.equal(inboxResponse.status, 200)
  const inbox: any = await inboxResponse.json()
  assert.equal(inbox.messages.length, 1)
  const message = inbox.messages[0]
  assert.equal(message.senderName, 'Bob')
  assert.equal(message.content, 'ping')
  assert.equal(message.status, 'intercepted')

  const sendResponse = await fetch(`${BASE}/send`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ replyTo: message.id, text: 'pong' }),
  })
  assert.equal(sendResponse.status, 200)
  const sendBody: any = await sendResponse.json()
  assert.equal(sendBody.receipt.messageId, 'http-mid-1')
  assert.equal(sendBody.receipt.target, 'group:group-openid-http')
  assert.equal(sent[0]?.msg_id, 'http-msg-1')
  assert.equal(sent[0]?.content, 'pong')

  const releaseResponse = await fetch(`${BASE}/release`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ id: message.id }),
  })
  assert.equal(releaseResponse.status, 200)
  await sleep(50)
  assert.equal(handled, 1)

  const modeResponse = await fetch(`${BASE}/mode`, {
    method: 'POST',
    headers: auth({ 'content-type': 'application/json' }),
    body: JSON.stringify({ mode: 'observe' }),
  })
  assert.equal(modeResponse.status, 200)
  const modeBody: any = await modeResponse.json()
  assert.equal(modeBody.mode, 'observe')
})
