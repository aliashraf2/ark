export const VOICE_LANGUAGE = 'en'

/** Anchored wake phrase: mentioning it inside another sentence does not wake ARK. */
export function wakeCommand(text: string): string | null {
  const normalized = text.normalize('NFKC').replace(/\s+/g, ' ').trim()
  const match = /^hi[\s,!.:-]*ark\b[\s,!.?:;—-]*(.*)$/i.exec(normalized)
  return match ? match[1]!.trim() : null
}

/** Keep numeric values, units and internal command identifiers intact. */
export function normalizeTranscript(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/^ark\b[\s,:.!-]*/i, '').trim()
}

export function isUnscopedConfirmation(text: string): boolean {
  return /^(yes|yeah|yep|ok|okay|confirm|approve|do it|go ahead|no|nope)[.!?]*$/i.test(text.trim())
}

export function speechText(text: string): string {
  return text.replace(/[✓✗⚠]/g, '').replace(/\*\*|`|^\s*[-*]\s+/gm, '').trim().slice(0, 4000)
}

/** Ignore recognized playback echoes without suppressing unrelated barge-in. */
export function isSpeechEcho(transcript: string, spoken: string): boolean {
  const signature = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const recognized = signature(transcript)
  const reply = signature(spoken)
  return !!recognized && (recognized === reply || (recognized.length >= 24 && reply.includes(recognized)))
}

/** Committed duplicates are suppressed across reconnects. Partial text never enters this gate. */
export class TranscriptGate {
  private seen = new Map<string, number>()
  accept(text: string, now = Date.now()): string | null {
    const normalized = normalizeTranscript(text)
    for (const [key, time] of this.seen) if (now - time > 8000) this.seen.delete(key)
    if (!normalized) return null
    const key = normalized.toLowerCase().replace(/[.!?]+$/, '')
    if (this.seen.has(key)) return null
    this.seen.set(key, now)
    return normalized
  }
}

export function pcmToFloat(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const samples = new Float32Array(Math.floor(bytes.length / 2))
  for (let index = 0; index < samples.length; index++) samples[index] = view.getInt16(index * 2, true) / 32768
  return samples
}
