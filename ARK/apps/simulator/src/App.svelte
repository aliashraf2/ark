<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  import { SimulationEngine } from './lib/core/SimulationEngine'
  import { PhysicsWorld } from './lib/physics/PhysicsWorld'
  import type { TelemetryState } from './lib/types/SimulationTypes'

  let container: HTMLDivElement
  let engine: SimulationEngine | null = null
  let debugMode = false
  let loading = true
  let initError: string | null = null
  let telemetry: TelemetryState = {
    time: 0,
    position: { x: 0, y: 0, z: 0 },
    velocityY: 0,
    gravity: { x: 0, y: -9.81, z: 0 },
    status: 'running',
  }

  onMount(async () => {
    try {
      await PhysicsWorld.init()
      engine = new SimulationEngine(container, (nextTelemetry) => {
        telemetry = nextTelemetry
      })
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

  $: pauseLabel = telemetry.status === 'running' ? 'Pause' : 'Resume'
  $: gravityText = `${Math.abs(telemetry.gravity.y).toFixed(2)} m/s²`
  $: positionText = `${telemetry.position.x.toFixed(2)}, ${telemetry.position.y.toFixed(2)}, ${telemetry.position.z.toFixed(2)}`
  $: controlsDisabled = loading || initError !== null
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
        <h1>Physics Foundation</h1>
      </div>
    </div>

    <div class="button-row">
      <button type="button" on:click={togglePause} disabled={controlsDisabled}>{pauseLabel}</button>
      <button type="button" class="secondary" on:click={resetSimulation} disabled={controlsDisabled}>Reset</button>
      <button type="button" class="secondary" on:click={dropSimulation} disabled={controlsDisabled}>Drop Sphere</button>
    </div>

    <label class="debug-toggle">
      <input type="checkbox" bind:checked={debugMode} on:change={handleDebugToggle} disabled={controlsDisabled} />
      <span>Debug overlay</span>
    </label>

    <section class="info-block">
      <h2>Gravity</h2>
      <p>{gravityText}</p>
    </section>

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
          <dt>Status</dt>
          <dd>{telemetry.status === 'running' ? 'Running' : 'Paused'}</dd>
        </div>
      </dl>
    </section>
  </aside>
</div>
