import { randomBytes } from 'node:crypto'
import type { AttachmentInfo, AttachmentKind, Scope } from './types'

export class BridgeError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

export function nowIso(ms = Date.now()): string {
  return new Date(ms).toISOString()
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

export function toNonNegativeInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.trunc(n)
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function newToken(): string {
  return randomBytes(24).toString('hex')
}

export function classifyAttachment(contentType: string | undefined): AttachmentKind {
  const type = (contentType ?? '').toLowerCase()
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/') || type === 'voice' || type.includes('silk')) return 'voice'
  if (type.length > 0) return 'file'
  return 'unknown'
}

export interface RawAttachment {
  content_type?: string
  url?: string
  filename?: string
  size?: number
  asr_refer_text?: string
  voice_wav_url?: string
}

export function mapAttachment(
  attachment: RawAttachment | undefined,
  localPath?: string,
): AttachmentInfo {
  if (!attachment) return { kind: 'unknown' }
  const kind = classifyAttachment(attachment.content_type)
  const info: AttachmentInfo = { kind }
  if (attachment.content_type) info.contentType = attachment.content_type
  if (attachment.url) info.url = attachment.url
  if (attachment.filename) info.filename = attachment.filename
  if (typeof attachment.size === 'number') info.size = attachment.size
  if (localPath) info.localPath = localPath
  const asr = attachment.asr_refer_text?.trim()
  if (asr) info.asrText = asr
  return info
}

export function parseTarget(input: string): { scope: Scope; targetId: string } | undefined {
  const index = input.indexOf(':')
  if (index <= 0) return undefined
  const scope = input.slice(0, index)
  const targetId = input.slice(index + 1).trim()
  if (!targetId) return undefined
  if (scope !== 'c2c' && scope !== 'group') return undefined
  return { scope, targetId }
}

/** Clone plain JSON data so callers cannot mutate the ring buffers. */
export function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value
  try {
    return JSON.parse(JSON.stringify(value)) as T
  } catch {
    // Platform payloads can contain values JSON cannot round-trip (BigInt,
    // cycles). Keep the bridge alive; the caller only loses exotic fields.
    return value
  }
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>
  return {}
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
