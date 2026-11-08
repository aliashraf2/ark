<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  import { SimulationEngine } from './lib/core/SimulationEngine'
  import type { EnvironmentInfo } from './lib/core/EnvironmentManager'
  import { PhysicsWorld } from './lib/physics/PhysicsWorld'
  import type { TelemetryState } from './lib/types/SimulationTypes'
  import type { PlanetId } from './lib/worlds/PlanetConfig'
  import { profilesForPlanet } from './lib/worlds/planetPresets'

  let container: HTMLDivElement
  let engine: SimulationEngine | null = null
  let debugMode = false
  let loading = true
  let initError: string | null = null
  let envInfo: EnvironmentInfo | null = null
  let seedInput = ''
  let telemetry: TelemetryState = {
    time: 0,
    position: { x: 0, y: 0, z: 0 },
    velocityY: 0,
    gravity: { x: 0, y: -9.81, z: 0 },
    status: 'running',
    surface: '—',
  }

  onMount(async () => {
    try {
      await PhysicsWorld.init()
      engine = new SimulationEngine(
        container,
        (nextTelemetry) => {
          telemetry = nextTelemetry
        },
        (nextEnv) => {
          envInfo = nextEnv
          seedInput = String(nextEnv.seed)
        },
      )
      envInfo = engine.environmentInfo
      seedInput = String(engine.environmentInfo.seed)
      engine.start()
    } catch (error) {
      initError = error instanceof Error ? error.message : 'Failed to initialize the physics engine.'
    } finally {
      loading = false
    }
  })

  onDestroy(() => {
    engine?.destroy()
    engine = null
  })

  function togglePause(): void {
    engine?.togglePause()
    telemetry = {
      ...telemetry,
      status: engine?.status ?? telemetry.status,
    }
  }

  function resetSimulation(): void {
    engine?.reset()
  }

  function dropSimulation(): void {
    engine?.drop()
  }

  function handleDebugToggle(): void {
    engine?.setDebugMode(debugMode)
  }

  function selectPlanet(planet: PlanetId): void {
    if (envInfo?.planet !== planet) {
      engine?.switchPlanet(planet)
    }
  }

  function regenerateWorld(): void {
    const parsed = Number.parseInt(seedInput, 10)
    engine?.regenerateTerrain(Number.isInteger(parsed) ? parsed : undefined)
  }

  function randomizeSeed(): void {
    engine?.regenerateTerrain()
  }

  function handleProfileChange(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement | null
    if (select && envInfo && select.value !== envInfo.profileId) {
      engine?.setTerrainProfile(select.value)
    }
  }

  function resetWorld(): void {
    engine?.resetWorld()
  }

  $: pauseLabel = telemetry.status === 'running' ? 'Pause' : 'Resume'
  $: gravityText = `${Math.abs(telemetry.gravity.y).toFixed(2)} m/s²`
  $: positionText = `${telemetry.position.x.toFixed(2)}, ${telemetry.position.y.toFixed(2)}, ${telemetry.position.z.toFixed(2)}`
  $: controlsDisabled = loading || initError !== null
  $: profiles = envInfo ? profilesForPlanet(envInfo.planet) : []
  $: atmosphereText = envInfo
    ? `${envInfo.atmospherePressure.toLocaleString('en-US')} Pa · ${envInfo.atmosphereDensity} kg/m³`
    : '—'
  $: terrainText = envInfo
    ? `${envInfo.terrainWidth} × ${envInfo.terrainDepth} m · ${envInfo.subdivisions}² cells`
    : '—'
</script>

<div class="simulator-shell">
  <div class="scene-panel">
    <div class="scene-container" bind:this={container}></div>
    {#if loading}
      <div class="scene-overlay" role="status">
        <p>Initializing physics engine…</p>
      </div>
    {:else if initError !== null}
      <div class="scene-overlay error" role="alert">
        <p>Initialization failed</p>
        <p class="error-detail">{initError}</p>
      </div>
    {/if}
  </div>

  <aside class="control-panel">
    <div class="panel-header">
      <div>
        <p class="eyebrow">ARK</p>
        <h1>Planetary Simulation</h1>
      </div>
    </div>

    <section class="info-block">
      <h2>Planet</h2>
      <div class="planet-row" role="group" aria-label="Planet selector">
        <button
          type="button"
          class:active={envInfo?.planet === 'earth'}
          on:click={() => selectPlanet('earth')}
          disabled={controlsDisabled}>Earth</button
        >
        <button
          type="button"
          class:active={envInfo?.planet === 'mars'}
          on:click={() => selectPlanet('mars')}
          disabled={controlsDisabled}>Mars</button
        >
      </div>
      <dl class="env-list">
        <div>
          <dt>Gravity</dt>
          <dd>{gravityText}</dd>
        </div>
        <div>
          <dt>Atmosphere</dt>
          <dd>{atmosphereText}</dd>
        </div>
        <div>
          <dt>Seed</dt>
          <dd>{envInfo?.seed ?? '—'}</dd>
        </div>
        <div>
          <dt>Terrain</dt>
          <dd>{terrainText}</dd>
        </div>
      </dl>
    </section>

    <section class="info-block">
      <h2>Terrain</h2>
      <label class="field-label" for="terrain-profile">Profile</label>
      <select
        id="terrain-profile"
        class="profile-select"
        on:change={handleProfileChange}
        disabled={controlsDisabled}
        value={envInfo?.profileId ?? ''}
      >
        {#each profiles as profile (profile.id)}
          <option value={profile.id}>{profile.label}</option>
        {/each}
      </select>
      <label class="field-label" for="terrain-seed">World seed</label>
      <div class="seed-row">
        <input
          id="terrain-seed"
          class="seed-input"
          type="number"
          bind:value={seedInput}
          disabled={controlsDisabled}
        />
        <button type="button" class="secondary" on:click={regenerateWorld} disabled={controlsDisabled}>
          Regenerate
        </button>
      </div>
      <div class="button-row two-col">
        <button type="button" class="secondary" on:click={randomizeSeed} disabled={controlsDisabled}>
          Randomize
        </button>
        <button type="button" class="secondary" on:click={resetWorld} disabled={controlsDisabled}>
          Reset World
        </button>
      </div>
    </section>

    <div class="button-row">
      <button type="button" on:click={togglePause} disabled={controlsDisabled}>{pauseLabel}</button>
      <button type="button" class="secondary" on:click={resetSimulation} disabled={controlsDisabled}>Reset</button>
      <button type="button" class="secondary" on:click={dropSimulation} disabled={controlsDisabled}>Drop Sphere</button>
    </div>

    <label class="debug-toggle">
      <input type="checkbox" bind:checked={debugMode} on:change={handleDebugToggle} disabled={controlsDisabled} />
      <span>Debug overlay</span>
    </label>

    <section class="info-block telemetry-block">
      <h2>Simulation Telemetry</h2>
      <dl>
        <div>
          <dt>Time</dt>
          <dd>{telemetry.time.toFixed(2)} s</dd>
        </div>
        <div>
          <dt>Position</dt>
          <dd>{positionText} m</dd>
        </div>
        <div>
          <dt>Vertical velocity</dt>
          <dd>{telemetry.velocityY.toFixed(2)} m/s</dd>
        </div>
        <div>
          <dt>Surface</dt>
          <dd>{telemetry.surface}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{telemetry.status === 'running' ? 'Running' : 'Paused'}</dd>
        </div>
      </dl>
    </section>
  </aside>
</div>
