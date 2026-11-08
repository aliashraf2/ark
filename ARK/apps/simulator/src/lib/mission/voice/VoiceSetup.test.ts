// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, expect, it, vi } from 'vitest'
import VoiceSetup from './VoiceSetup.svelte'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

it('connects from the dashboard, clears the password and never writes browser storage', async () => {
  const store = vi.spyOn(Storage.prototype, 'setItem')
  const requests: RequestInit[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => {
    requests.push(init)
    return init.method === 'GET' ? json({ configured: false }) : json({
      configured: true, voice_id: 'account-voice', voice_name: 'Mission Voice', tts_model: 'eleven_flash_v2_5',
    })
  }))
  const configured = vi.fn()
  render(VoiceSetup, { baseUrl: 'http://localhost:8000', onConfigured: configured })
  const key = screen.getByLabelText('ElevenLabs API key') as HTMLInputElement
  await fireEvent.input(key, { target: { value: 'test-private-key' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Connect ElevenLabs' }))
  await screen.findByText('LINKED')
  expect(key.value).toBe('')
  expect(requests.find((request) => request.method === 'POST')).toMatchObject({ headers: { 'X-ARK-Voice': '1' } })
  expect(JSON.parse(String(requests.find((request) => request.method === 'POST')!.body))).toEqual({
    api_key: 'test-private-key', voice_id: '', model_id: 'eleven_flash_v2_5',
  })
  expect(configured).toHaveBeenCalledTimes(1)
  expect(store).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('test-private-key')
})

it('shows connection failure without keeping a rejected key in the form', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => init.method === 'GET'
    ? json({ configured: false }) : json({ detail: 'Connection rejected.' }, 502)))
  render(VoiceSetup, { baseUrl: 'http://localhost:8000' })
  const key = screen.getByLabelText('ElevenLabs API key') as HTMLInputElement
  await fireEvent.input(key, { target: { value: 'test-rejected-key' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Connect ElevenLabs' }))
  await screen.findByText('Connection rejected.')
  expect(key.value).toBe('')
})

it('loads public connection settings without loading any saved key into the browser', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ configured: true, voice_id: 'voice-id', tts_model: 'model-id' })))
  render(VoiceSetup, { baseUrl: 'http://localhost:8000' })
  await screen.findByText('LINKED')
  expect(screen.queryByLabelText('ElevenLabs API key')).toBeNull()
  await fireEvent.click(screen.getByRole('button', { name: 'Replace ElevenLabs key' }))
  await waitFor(() => expect((screen.getByLabelText('ElevenLabs API key') as HTMLInputElement).value).toBe(''))
  expect((screen.getByLabelText('Voice ID (optional)') as HTMLInputElement).value).toBe('voice-id')
})
