# ARK voice Mission Control

Voice is an optional adapter to the existing Mission AI conversation. It does not add a second planner, capability registry, physics engine, or rover controller.

## Architecture and API choice

Microphone → audio worklet (16 kHz mono PCM) → official ElevenLabs browser SDK / Scribe v2 Realtime → **committed** transcript → existing `MissionClient.interpret` → CSP → existing `normalizeCommand` → proposal approval → existing `CommandDispatcher` / simulation → actual `CommandResult` and fresh world snapshot → existing `MissionClient.respond` → ElevenLabs Python SDK streaming TTS → speakers.

Scribe partials appear live but never execute commands. Final-but-not-committed events also never execute. The microphone meter is RMS measured from the actual captured samples. Playback status follows scheduled audio, not a decorative waveform. Audio capture runs in an AudioWorklet, independently of Rapier stepping; requests and streaming playback are asynchronous. The browser SDK loads only when starting voice.

ElevenLabs Agents can call client/server tools, but also introduce conversation/planning configuration. Separate STT and TTS preserve ARK's existing CSP planner as the authority without synchronizing two tool-selection systems. No ElevenLabs Agent, `ELEVENLABS_AGENT_ID`, React wrapper, onboarding CLI, or additional backend service is needed. The onboarding command was not run because ARK already has the necessary Vite and FastAPI services and only needs SDK dependencies and four routes.

Official SDK versions verified and installed during implementation:

- Browser: `@elevenlabs/client` **1.35.0**, `Scribe.connect`, manual PCM audio, server VAD commits, `RealtimeEvents`.
- Python: `elevenlabs` **2.77.0**, `AsyncElevenLabs.tokens.single_use.create('realtime_scribe')` and `text_to_speech.stream`.
- STT: `scribe_v2_realtime`, language `en`.
- Default TTS: `eleven_flash_v2_5`, configurable; output is signed little-endian PCM at 24 kHz, streamed through FastAPI without saving audio files.

References: [Scribe JavaScript SDK](https://elevenlabs.io/docs/eleven-api/resources/libraries/scribe-stt/javascript-scribe), [client streaming and authentication](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/client-side-streaming), [single-use tokens](https://elevenlabs.io/docs/api-reference/tokens/create), [TTS streaming](https://elevenlabs.io/docs/api-reference/text-to-speech/stream), [Agents client tools](https://elevenlabs.io/docs/eleven-agents/customization/tools/client-tools), [API key restrictions](https://elevenlabs.io/docs/overview/administration/workspaces/api-keys).

## Configuration

**Recommended: configure directly in the dashboard.** Open **Mission AI → Voice Mission Control**, paste your ElevenLabs API key, and click **Connect ElevenLabs**. Leave Voice ID empty to auto-select an available account voice, or enter a specific voice ID. The backend checks Scribe token authorization and generates a short TTS connection sample to verify voice/model access (this uses a small amount of TTS credit). A rejected replacement leaves the previous working connection intact.

Dashboard credentials stay in backend memory until it restarts; they are not written to `.env`, browser storage, or API responses. The password field clears on submission. Re-enter the key after a backend restart. The existing Agent Link form configures the separate Gemini/Anthropic/Muse Mission Control key.

The environment-variable setup below remains an optional fallback; **no `.env` editing is needed for dashboard setup**.

From the **inner** `ARK` directory:

```bash
npm ci
uv sync --project services/agent --frozen
cp services/agent/.env.example services/agent/.env
```

Fill in `services/agent/.env` using an editor. Never put a private key in a `VITE_*` variable or browser code:

```dotenv
ELEVENLABS_API_KEY=your-private-key
ELEVENLABS_VOICE_ID=a-voice-id-available-to-your-account
ELEVENLABS_TTS_MODEL=eleven_flash_v2_5
ELEVENLABS_LANGUAGE=en
GEMINI_API_KEY=your-mission-control-key
# Or ANTHROPIC_API_KEY instead of GEMINI_API_KEY.
```

Use ElevenLabs **Voices** to select a voice accessible to your account and copy its ID. There is deliberately no hardcoded account voice. Select a TTS model accessible to that account that supports English and PCM output. The backend applies restrained stability/similarity/style settings; ARK's existing summary prompts request calm, precise, concise statements about simulated values. Restart the backend after changing environment configuration. A Gemini/Anthropic/Muse key can also be configured through the existing Agent Link UI.

Restrict the ElevenLabs key to the STT and TTS operations this integration uses, including issuance of a realtime Scribe single-use token; set a credit limit. Enable additional permissions only if required by your account. Dashboard auto-selection uses the official [List voices API](https://elevenlabs.io/docs/api-reference/voices/search) and requires Voices read permission. Enter a voice ID explicitly to avoid listing voices. An account restriction, unavailable voice/model, provider outage, or exhausted quota produces a visible error.

The permanent key stays server-side. `/api/voice/token` returns only a single-use Scribe token (documented expiry: 15 minutes, consumed when used) with `Cache-Control: no-store`. Every reconnect obtains a fresh token. Tokens are not persisted or logged. `/api/voice/configure` validates dashboard credentials and installs an in-memory connection. `/api/voice/config` returns readiness and public voice/model/language settings without returning the key. `/api/voice/speech` proxies bounded text to TTS and streams the result. Provider errors are sanitized.

For **localhost development**, keep Uvicorn bound to `127.0.0.1`. Voice routes require a custom header and enforce localhost Host and allowed Origin before spending credits; CORS preflights allow that header. Optional `ARK_CORS_ORIGINS` narrows the allowed browser origins. These local guards do not authenticate other local processes/users. For public hosting, use the [Vultr deployment](deploy/vultr/README.md), which adds HTTPS, dashboard authentication, a private backend and gateway token/Host/Origin validation. That deployment serves a trusted operator/team with shared keys; unrelated users require separate accounts and quotas. Do not publish the development server as-is.

`.env` and runtime data are already gitignored. `.env.example` contains placeholders only. No credentials were available in the implementation environment.

## Start

```bash
cd "/Users/aliashraf/Desktop/Fall 26/ark/ARK"
./scripts/dev.sh
```

Open <http://localhost:5173>, choose **Mission AI**, connect ElevenLabs, then click **Enable Hi ARK**. Allow the microphone in the browser. Browser permission requires this initial click; a disconnected page cannot hear a wake phrase. Localhost is a secure context; remote use requires HTTPS. Chrome is the primary manual test target. The simulation and typed chat do not depend on starting voice.

Use headphones for reliable interruption without speaker echo. By default ARK waits for the committed phrase **“Hi ARK.”** The greeting itself goes to your linked LLM, and its answer is spoken using ElevenLabs. The conversation then stays active: ask follow-up questions without repeating the wake phrase. Alternatively say **“Hi ARK, take me to Mars”** in one utterance. Partial transcripts cannot activate ARK. Mentions of “Hi ARK” inside unrelated sentences do not wake it. Muting, stopping or reconnecting ends activation. Uncheck **Start the conversation with “Hi ARK”** to talk immediately after starting voice.

Both connections are required: **Agent Link must show LLM READY and ElevenLabs must show LINKED.** The UI displays the selected LLM in the speech path, and voice startup refuses to open capture if the backend reports no linked LLM. ElevenLabs does not generate the conversational answer; it recognizes the question and speaks the selected LLM's response. Ordinary questions and greetings use the read-only `answer_question` capability in the existing CSP registry. Simulation questions still use live snapshots, and simulation actions still require validated commands/approvals. Recent conversation context (up to 12 user/assistant entries, 2000 characters each) is supplied for follow-ups, never as approval or proof of current world state.

Wake listening uses the existing ElevenLabs Scribe stream, rather than a separate local keyword model: **microphone audio continues going to ElevenLabs and can incur STT charges while enabled, including before activation.** The measured meter and status show when capture is live. Click **Stop voice** to stop capture/transmission entirely.

After activation, speak one complete instruction and wait for its committed transcript. With safe auto-execution off (the default), review the intervention and click **Confirm & Execute**. Planet switches, resets, terrain regeneration, extreme overrides and synthesized actions retain confirmation even if safe auto-execution is enabled. A bare “yes,” “approve,” “no,” or similar utterance never approves or dismisses anything; use the controls on the specific proposal. The proposal displays its request ID, and synthesis approval includes the exact reviewed steps.

If you speak while the LLM is answering, your latest utterance follows automatically when that turn finishes. The UI reports that it is waiting. Stop voice or Cancel pending request clears it. If a simulation proposal needs approval, the follow-up stays a draft in the existing text input and does not run automatically. Finish/dismiss that proposal, then send the draft explicitly. Every accepted speech turn has a UUID; repeated committed transcripts within eight seconds are suppressed across reconnects. Old-session callbacks and cancelled HTTP responses cannot stage commands. The dispatcher also prevents execution more than once per command ID, including after a partial failure.

## Stop, interruption and cancellation

| Control | Effect |
| --- | --- |
| Mute microphone | Disables the actual capture track. Silence keeps Scribe connected; committed transcripts received while muted are ignored. |
| Mute ARK | Stops speech and suppresses further playback; response text remains visible. |
| Interrupt speech / speak over ARK | Aborts only TTS fetching/playback and stops scheduled audio. It does not undo actions or approve/cancel a proposal. |
| Cancel pending request | Aborts the browser's pending planner/summary wait and invalidates that proposal. Server-side planning may finish, but its late result cannot execute locally. Already-applied actions remain applied. |
| Stop voice | Releases microphone tracks, worklet, audio nodes/context, socket and fetches. Cancels unexecuted requests originating from voice; typed requests are independent. |
| Stop a weather event | A separate normal Mission Control command, `stop_weather_event`, using the specific event ID from current state. Stopping audio/session does not cancel events. |

Connection loss closes capture and cancels unexecuted voice work. Explicit **Reconnect voice** obtains a new token and session without replaying commands. There is no automatic retry of physical actions. A planner request cannot forcibly interrupt a synchronous simulation method that has already begun; execution results/audit remain authoritative.

## Demo and actual capability limits

Say “Hi ARK” once to start the conversation. Subsequent questions and commands need no repeated wake phrase.

1. **Planet:** Say “Hi ARK, take me to Mars.” Review `switch_planet` and click **Confirm & Execute**. The spoken completion follows the actual switch and acknowledgement.
2. **Weather:** On Mars say “Create a dust storm that reduces solar illumination by fifty percent.” Existing CSP may request clarification or propose a supported composition. Dust optical depth and scheduled ramp phases do **not** promise exact 50% attenuation; do not treat the requested percentage as a measurement. A deterministic supported weather instruction is “Start a dust storm with dust optical depth 0.7, ramp up over five seconds, hold for thirty seconds, then ramp down over five seconds.” Approve it, let simulation time advance, then ask “What is the current simulated solar illumination?” ARK must read the snapshot and report the actual modeled result. Manual solar multiplier is a separate supported control that compounds with weather.
3. **Rover control:** Say “Spawn a rover and start its navigation mission.” The repository has rover physics/controllers, but the current **15-command Mission Control protocol does not expose rover spawning/navigation**. This request must be reported as unsupported/missing capability, without deploying a rover. Adding robotics capabilities is a separate protocol extension; this voice integration does not invent them.
4. **Telemetry:** “What planet are we on?” or “What is the wind speed?” uses the existing `explain_world` / live snapshot path. “What is the rover's current velocity?” must explain that rover telemetry is absent from the Mission Control snapshot. Sphere/box velocity is test-body telemetry, not rover velocity or battery data.
5. **Error:** Ask for “a hurricane on Mars” or another unsupported capability. Expect clarification/refusal with no fabricated execution. If the backend or ElevenLabs is unavailable, expect a visible error while simulation/text controls remain usable.

English is the only enabled language. Official models support more languages, but this integration rejects other language settings until they have implementation and end-to-end verification. Numbers, physical units and capability identifiers are not translated.

## Verification

```bash
./scripts/test.sh all
# Or independently:
./scripts/test.sh backend
./scripts/test.sh web
./scripts/test.sh headless
```

Coverage includes configuration/token security, origin rejection, provider error sanitization, PCM streaming/decoding, actual microphone-level computation, permission failure, session initialization/loss/reconnect, partial vs committed text, deduplication, cancellation races, interruption, resource cleanup, English-only handling, exact-step synthesis approval, local confirmation gates, Svelte voice/text routing, actual environment-model changes and acknowledgements, deferred completion speech, unsupported rover requests, and existing physics/RL regression tests.

Mocks stand in for ElevenLabs, microphones, browser audio devices and LLM responses in automated tests. Component tests exercise the real MissionClient, local validator, dispatcher and EnvironmentController. The headless regression exercises Rapier. `VoiceConversation.test.ts` connects real Scribe-event handling, MissionClient, the Svelte panel, proposal validation, dispatcher acknowledgements, response text, the ElevenLabs speech endpoint and PCM playback with mocked external services/audio hardware. It covers follow-up history and speech arriving while a reply is pending. None of these is a real microphone-to-ElevenLabs conversation.

**Live voice verification is pending credentials.** After configuration, run the five scenarios above with a microphone and speakers, including deny/reallow microphone access, interruption during speech, mute/unmute, stop while planning, and reconnect after a network interruption. Verify the simulation state and audit trail, not just the spoken words. Provider availability, account voice/model access, microphone recognition accuracy and echo handling remain unverified until that live test is performed.

Implementation verification results: **278 frontend/simulator tests passed**, **77 backend tests passed**, Svelte/TypeScript **0 errors and 0 warnings**, production build passed, and Mars/seed-42/300-step headless determinism passed with maximum state difference **0**. The build retains the existing large-simulation-bundle advisory; the optional ElevenLabs SDK is split into a separate lazy-loaded chunk. Pytest reports an existing asyncio fixture-scope deprecation notice. The headless check needed permission outside the execution sandbox for tsx's local IPC pipe.

Manual Chrome verification of the first implementation confirmed that the voice panel renders, starting voice reports missing server-side ElevenLabs configuration, the microphone meter remains at zero without capture, and simulation time continues advancing. This was a localhost UI/error-path check, not a live provider conversation.

## Files added or modified

Added:

- `apps/simulator/src/lib/mission/voice/VoiceSession.ts` — session, SDK transport, committed transcripts, deduplication, interruption and lifecycle.
- `apps/simulator/src/lib/mission/voice/VoiceAudio.ts` — microphone capture, streamed PCM playback and resource ownership.
- `apps/simulator/src/lib/mission/voice/VoiceProtocol.ts` — pure transcript/response/PCM helpers.
- `apps/simulator/src/lib/mission/voice/VoiceControls.svelte` — optional voice controls, wake-phrase settings and live status/transcripts.
- `apps/simulator/src/lib/mission/voice/VoiceConversation.test.ts` — transcript → selected LLM → spoken reply integration and simulation-acknowledgement regression.
- `apps/simulator/src/lib/mission/voice/VoiceSetup.svelte` and `VoiceSetup.test.ts` — dashboard key/voice/model setup, validation and transient credential handling.
- `apps/simulator/public/ark-pcm-worklet.js` — measured audio activity and PCM capture off the UI thread.
- `apps/simulator/src/lib/mission/ProposalSafety.ts` — shared proposal staging using the existing validator.
- `services/agent/voice.py` — secure config, single-use token and streamed speech routes.
- `apps/simulator/src/lib/mission/voice/VoiceSession.test.ts`, `VoiceAudio.test.ts`, `apps/simulator/src/lib/mission/MissionPanel.test.ts`, `services/agent/tests/test_voice.py` — transport, lifecycle, audio and UI regression coverage.
- `VOICE.md` — architecture, configuration, usage, demo, limits and verification.

Modified:

- `apps/simulator/src/lib/mission/MissionPanel.svelte` — shared typed/spoken submission, request-specific cancellation/approval, verified speech and voice controls.
- `apps/simulator/src/lib/mission/MissionClient.ts` — request cancellation and exact reviewed synthesis steps.
- `apps/simulator/src/lib/mission/CommandDispatcher.ts` and its test file — truthful missing-event/read failures, verified snapshot availability and partial-failure deduplication.
- `services/agent/app.py` — voice router, CORS header and synthesis approval payload.
- `services/agent/agent.py` and `tests/test_agent.py` — grounded Mission Control speaking style, explicit telemetry limits and exact-step synthesis approval.
- `services/agent/.env.example` — placeholder-only ElevenLabs settings.
- `apps/simulator/package.json`, root `package-lock.json`, `services/agent/pyproject.toml`, `services/agent/uv.lock` — official SDKs and component-test dependencies.
- `apps/simulator/vite.config.ts` — test-only Svelte component-test support.
- `README.md` — voice setup guide link.
