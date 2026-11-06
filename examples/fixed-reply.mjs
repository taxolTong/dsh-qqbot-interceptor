#!/usr/bin/env node
/**
 * Example controller: a fixed reply for every message that addresses the bot.
 *
 * This file deliberately contains no dsh import: it is a plain Node process
 * that talks to the interceptor's local HTTP API. That is the whole point —
 * user interactions never enter a dsh agent turn, so no dsh system prompt or
 * tool context is paid for each reply.
 *
 * Usage:
 *   node examples/fixed-reply.mjs
 *   REPLY_TEMPLATE='{sender} 你@我说了「{content}」' node examples/fixed-reply.mjs
 *   ONCE=1 node examples/fixed-reply.mjs        # answer one message then exit
 *   DRY_RUN=1 node examples/fixed-reply.mjs     # log replies without sending
 *
 * Environment:
 *   QQBOT_INTERCEPTOR_API   path to api.json (default $DSH_HOME/qqbot-interceptor/api.json)
 *   QQBOT_INTERCEPTOR_URL   override base URL (default from api.json)
 *   QQBOT_INTERCEPTOR_TOKEN override token (default from api.json)
 *   REPLY_TEMPLATE          template with {sender}, {senderId}, {content}, {scope}
 *   SINCE                   initial inbox cursor (default: current tail, so old buffered
 *                           messages are not answered; set SINCE=0 to replay them)
 *   POLL_MS                 long-poll window in ms (default 25000)
 *   ONCE                    set to 1 to exit after the first reply
 *   DRY_RUN                 set to 1 to only log
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_TEMPLATE = '{sender} 谁@我说了「{content}」'

function apiPath() {
  if (process.env.QQBOT_INTERCEPTOR_API) return process.env.QQBOT_INTERCEPTOR_API
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'qqbot-interceptor', 'api.json')
}

async function loadEndpoint() {
  if (process.env.QQBOT_INTERCEPTOR_URL && process.env.QQBOT_INTERCEPTOR_TOKEN) {
    return {
      url: process.env.QQBOT_INTERCEPTOR_URL.replace(/\/+$/, ''),
      token: process.env.QQBOT_INTERCEPTOR_TOKEN,
      path: '(environment)',
    }
  }
  const path = apiPath()
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new Error(
      `cannot read ${path}. Is dsh-qqbot-interceptor loaded? Start dsh with the plugin row enabled.`,
    )
  }
  const info = JSON.parse(raw)
  return { url: String(info.url).replace(/\/+$/, ''), token: String(info.token), path }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function render(template, message) {
  const sender = message.senderName || message.senderId || '有人'
  return template
    .replaceAll('{sender}', sender)
    .replaceAll('{senderId}', message.senderId ?? '')
    .replaceAll('{content}', message.content || '（空消息）')
    .replaceAll('{scope}', message.scope ?? '')
}

function log(...args) {
  console.log(`[fixed-reply ${new Date().toLocaleTimeString()}]`, ...args)
}

async function main() {
  const endpoint = await loadEndpoint()
  const template = process.env.REPLY_TEMPLATE || DEFAULT_TEMPLATE
  const once = process.env.ONCE === '1'
  const dryRun = process.env.DRY_RUN === '1'
  const pollMs = Math.max(0, Math.min(60_000, Number(process.env.POLL_MS ?? 25_000)))
  let since = process.env.SINCE === undefined ? Number.NaN : Number(process.env.SINCE)
  if (!Number.isFinite(since)) since = 0

  const headers = { authorization: `Bearer ${endpoint.token}` }
  log(`endpoint ${endpoint.url} (${endpoint.path})`)
  log(`template ${JSON.stringify(template)}${dryRun ? ' [dry-run]' : ''}`)

  // By default start at the current tail: a controller started now should not
  // answer messages that were buffered before it existed.
  if (process.env.SINCE === undefined) {
    try {
      const tail = await fetch(`${endpoint.url}/inbox?limit=1`, { headers })
      if (tail.ok) {
        const body = await tail.json()
        if (typeof body.nextSince === 'number') since = body.nextSince
      }
    } catch {
      // keep 0
    }
  }

  const controller = new AbortController()
  const stop = () => {
    log('stopping')
    controller.abort()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  while (!controller.signal.aborted) {
    let response
    try {
      response = await fetch(
        `${endpoint.url}/inbox?since=${since}&waitMs=${pollMs}&limit=20&actionable=1`,
        { headers, signal: controller.signal },
      )
    } catch (error) {
      if (controller.signal.aborted) return
      log('inbox request failed:', error.message)
      await sleep(2000)
      continue
    }

    if (response.status === 401) {
      log('unauthorized: token in api.json is stale; reload the plugin or set QQBOT_INTERCEPTOR_TOKEN')
      await sleep(5000)
      continue
    }
    if (!response.ok) {
      log(`inbox HTTP ${response.status}; retrying`)
      await sleep(2000)
      continue
    }

    const body = await response.json()
    if (typeof body.nextSince === 'number') since = body.nextSince
    for (const message of body.messages ?? []) {
      if (message.status !== 'intercepted') continue
      if (!message.wasMentioned && message.scope !== 'c2c') continue
      const text = render(template, message)
      log(`← ${message.id} ${message.scope}:${message.peerId} ${message.senderName ?? message.senderId}: ${message.content}`)
      log(`→ ${text}`)

      if (!dryRun) {
        try {
          const sent = await fetch(`${endpoint.url}/send`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({ replyTo: message.id, text }),
            signal: controller.signal,
          })
          if (!sent.ok) {
            const detail = await sent.text()
            log(`send failed: HTTP ${sent.status} ${detail}`)
          }
        } catch (error) {
          if (controller.signal.aborted) return
          log('send failed:', error.message)
        }
      }
      if (once) {
        log('ONCE=1, exiting')
        return
      }
    }
  }
}

main().catch((error) => {
  console.error('[fixed-reply] fatal:', error.message)
  process.exit(1)
})
