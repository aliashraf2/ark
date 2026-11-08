<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  import { SimulationEngine } from './lib/core/SimulationEngine'
  import type { EnvironmentInfo } from './lib/core/EnvironmentManager'
  import { scenariosForPlanet } from '../../../packages/physics/src/environment/eventPresets'
  import MissionPanel from './lib/mission/MissionPanel.svelte'
  import { PhysicsWorld } from '../../../packages/physics/src/physics/PhysicsWorld'
  import {
    ExternalController,
    ManualController,
    NavigationController,
    type ManualKeyState,
  } from '../../../packages/physics/src/robotics/controllers'
  import type { RoverSnapshot } from '../../../packages/physics/src/robotics/RoverConfig'
  import type { TelemetryState } from '../../../packages/physics/src/types/SimulationTypes'
  import type { PlanetId } from '../../../packages/physics/src/worlds/PlanetConfig'
  import { profilesForPlanet } from '../../../packages/physics/src/worlds/planetPresets'

  let container: HTMLDivElement
  let engine: SimulationEngine | null = null
  let debugMode = false
  let weatherQuality: 'high' | 'low' = 'high'
  let loading = true
  let initError: string | null = null
  let envInfo: EnvironmentInfo | null = null

  // UI States
  let dockOpen = true
  let showHud = true
  let showShortcuts = false
  let activeTab: 'world' | 'weather' | 'scenarios' | 'robot' | 'mission' = 'world'
  let activeCameraMode: 'orbit' | 'sphere' | 'box' | 'topdown' = 'orbit'
  let toastMessage: string | null = null
  let toastTimer: number | null = null

  // Inputs & Controls
  let seedInput = ''
  let windSpeedVal = 8
  let windDirectionVal = 270
  let temperatureVal = 15
  let tractionVal = 1.0
  let cloudVal = 0.0
  let dustVal = 0.0
  let aeroEnabled = true
  let envError: string | null = null

  // Robotics (Milestone 5)
  let roverIds: string[] = []
  let selectedRover: string | null = null
  let roverSnapshots: RoverSnapshot[] = []
  let roverControlMode: 'manual' | 'navigation' | 'external' = 'manual'
  let roverModes: Record<string, 'manual' | 'navigation' | 'external'> = {}
  let manualKeys: ManualKeyState = {
    forward: false,
    reverse: false,
    turnLeft: false,
    turnRight: false,
    brake: false,
  }
  let missionTargetX = 10
  let missionTargetZ = 10
  let followRoverEnabled = false
  let roverRaysVisible = false

  let telemetry: TelemetryState = {
    time: 0,
    position: { x: 0, y: 0, z: 0 },
    velocityY: 0,
    velocity: { x: 0, y: 0, z: 0 },
    gravity: { x: 0, y: -9.81, z: 0 },
    status: 'running',
    surface: '—',
    environment: null,
  }

  onMount(async () => {
    try {
      await PhysicsWorld.init()
      engine = new SimulationEngine(
        container,
        (nextTelemetry) => {
          telemetry = nextTelemetry
          refreshRovers()
        },
        (nextEnv) => {
          envInfo = nextEnv
          seedInput = String(nextEnv.seed)
        },
      )
      envInfo = engine.environmentInfo
      seedInput = String(engine.environmentInfo.seed)
      
      const currentEnv = engine.environmentState
      if (currentEnv) {
        windSpeedVal = Math.round(Math.hypot(currentEnv.wind.x, currentEnv.wind.y, currentEnv.wind.z))
        temperatureVal = Math.round(currentEnv.temperature - 273.15)
        tractionVal = Number(currentEnv.tractionMultiplier.toFixed(2))
        cloudVal = Number(currentEnv.cloudOpacity.toFixed(2))
        dustVal = Number(currentEnv.dustTau.toFixed(2))
        aeroEnabled = currentEnv.aeroEnabled
      }

      engine.start()
      window.addEventListener('keydown', handleKeydown)
      window.addEventListener('keyup', handleKeyup)
      // TEMPORARY diagnosis hook (removed before milestone sign-off).
      ;(window as unknown as { __arkDebug: unknown }).__arkDebug = { getEngine: () => engine }
    } catch (error) {
      initError = error instanceof Error ? error.message : 'Failed to initialize the physics engine.'
    } finally {
      loading = false
    }
  })

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown)
    window.removeEventListener('keyup', handleKeyup)
    if (toastTimer) clearTimeout(toastTimer)
    engine?.destroy()
    engine = null
  })

  function showToast(msg: string): void {
    toastMessage = msg
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      toastMessage = null
    }, 2800)
  }

  function togglePause(): void {
    engine?.togglePause()
    telemetry = {
      ...telemetry,
      status: engine?.status ?? telemetry.status,
    }
  }

  function resetSimulation(): void {
    engine?.reset()
    showToast('Simulation reset to origin')
  }

  function dropSimulation(): void {
    engine?.drop()
    showToast('Robot dropped from spawn altitude')
  }

  function handleDebugToggle(): void {
    debugMode = !debugMode
    engine?.setDebugMode(debugMode)
  }

  function toggleWeatherQuality(): void {
    weatherQuality = weatherQuality === 'high' ? 'low' : 'high'
    engine?.setWeatherQuality(weatherQuality)
    showToast(`Particle effects: ${weatherQuality.toUpperCase()}`)
  }

  function setCameraMode(mode: 'orbit' | 'sphere' | 'box' | 'topdown'): void {
    activeCameraMode = mode
    if (mode === 'sphere') {
      engine?.focusSphere()
      showToast('Camera: Tracking Robot')
    } else if (mode === 'box') {
      engine?.focusBox()
      showToast('Camera: Tracking Wind Rig')
    } else if (mode === 'topdown') {
      engine?.setTopDownView()
      showToast('Camera: Satellite Top-Down')
    } else {
      engine?.resetCamera()
      showToast('Camera: Free Orbit')
    }
  }

  function toggleFullscreen(): void {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {})
    } else {
      document.exitFullscreen().catch(() => {})
    }
  }

  function selectPlanet(planet: PlanetId): void {
    if (envInfo?.planet !== planet) {
      engine?.switchPlanet(planet)
      if (planet === 'mars') {
        temperatureVal = -60
        dustVal = 0.5
      } else {
        temperatureVal = 15
        cloudVal = 0.2
      }
      showToast(`Transferred to ${planet.toUpperCase()}`)
    }
  }

  function regenerateWorld(): void {
    const parsed = Number.parseInt(seedInput, 10)
    engine?.regenerateTerrain(Number.isInteger(parsed) ? parsed : undefined)
    showToast(`Terrain regenerated (Seed: ${seedInput})`)
  }

  function randomizeSeed(): void {
    engine?.regenerateTerrain()
    showToast('New procedural seed applied')
  }

  function copySeed(): void {
    if (seedInput) {
      navigator.clipboard?.writeText(seedInput).then(() => {
        showToast(`Seed ${seedInput} copied`)
      })
    }
  }

  function handleProfileChange(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement | null
    if (select && envInfo && select.value !== envInfo.profileId) {
      engine?.setTerrainProfile(select.value)
      showToast(`Terrain profile: ${select.options[select.selectedIndex].text}`)
    }
  }

  function resetWorld(): void {
    engine?.resetWorld()
    showToast('World restored to default baseline')
  }

  function runEnvOp(operation: () => void): void {
    try {
      operation()
      envError = null
    } catch (error) {
      envError = error instanceof Error ? error.message : 'Environment operation failed.'
    }
  }

  // Reactive atmosphere controls
  function handleWindChange(): void {
    runEnvOp(() => {
      engine?.setWind(Number(windSpeedVal), Number(windDirectionVal))
    })
  }

  function setWindPreset(speed: number, dir?: number): void {
    windSpeedVal = speed
    if (dir !== undefined) windDirectionVal = dir
    handleWindChange()
  }

  function handleTempChange(): void {
    runEnvOp(() => {
      engine?.setTemperatureCelsius(Number(temperatureVal))
    })
  }

  function handleTractionChange(): void {
    runEnvOp(() => {
      engine?.setTractionMultiplier(Number(tractionVal))
    })
  }

  function handleCloudChange(): void {
    runEnvOp(() => {
      engine?.setCloudOpacity(Number(cloudVal))
    })
  }

  function handleDustChange(): void {
    runEnvOp(() => {
      engine?.setDustTau(Number(dustVal))
    })
  }

  function toggleAeroSwitch(): void {
    aeroEnabled = !aeroEnabled
    runEnvOp(() => {
      engine?.setAeroEnabled(aeroEnabled)
    })
    showToast(`Aerodynamics: ${aeroEnabled ? 'ENABLED' : 'DISABLED'}`)
  }

  function startRain(): void {
    runEnvOp(() => {
      engine?.startEvent({
        type: 'rain',
        rampUp: 15,
        hold: 120,
        rampDown: 15,
        targets: { precipitation: 14, cloudOpacity: 0.85 },
      })
      showToast('Event started: Earth Rainfall')
    })
  }

  function startDustStorm(): void {
    runEnvOp(() => {
      engine?.startEvent({
        type: 'dust-storm',
        rampUp: 30,
        hold: 180,
        rampDown: 45,
        targets: { dustTau: 2.5, wind: { x: -18, y: 0, z: 8 } },
      })
      showToast('Event started: Martian Dust Storm')
    })
  }

  function startGust(): void {
    runEnvOp(() => {
      engine?.startEvent({
        type: 'wind',
        rampUp: 4,
        hold: 24,
        rampDown: 8,
        priority: 2,
        targets: { wind: { x: 18, y: 0, z: 0 } },
      })
      showToast('Event started: High-Velocity Gust')
    })
  }

  function stopEnvEvent(id: string): void {
    runEnvOp(() => {
      engine?.stopEvent(id)
      showToast(`Event cancelled: ${id}`)
    })
  }

  function resetEnvironment(): void {
    runEnvOp(() => {
      engine?.resetEnvironment()
      const currentEnv = engine?.environmentState
      if (currentEnv) {
        windSpeedVal = Math.round(Math.hypot(currentEnv.wind.x, currentEnv.wind.y, currentEnv.wind.z))
        temperatureVal = Math.round(currentEnv.temperature - 273.15)
        tractionVal = 1.0
        cloudVal = currentEnv.cloudOpacity
        dustVal = currentEnv.dustTau
      }
      showToast('Atmosphere restored to planet nominal')
    })
  }

  function applyScenario(scenarioId: string): void {
    runEnvOp(() => {
      engine?.applyScenario(scenarioId)
      showToast(`Scenario active: ${scenarioId}`)
    })
  }

  /** Re-sync manual controls after agent-driven environment changes. */
  function syncControlsFromEngine(): void {
    const currentEnv = engine?.environmentState
    if (currentEnv) {
      windSpeedVal = Math.round(Math.hypot(currentEnv.wind.x, currentEnv.wind.y, currentEnv.wind.z))
      temperatureVal = Math.round(currentEnv.temperature - 273.15)
      tractionVal = Number(currentEnv.tractionMultiplier.toFixed(2))
      cloudVal = Number(currentEnv.cloudOpacity.toFixed(2))
      dustVal = Number(currentEnv.dustTau.toFixed(2))
    }
    envInfo = engine?.environmentInfo ?? envInfo
    if (envInfo) seedInput = String(envInfo.seed)
  }

  // ---- Robotics (Milestone 5) ----

  const ROVER_SPAWN_OFFSETS: ReadonlyArray<{ x: number; z: number }> = [
    { x: 6, z: 0 },
    { x: 6, z: 5 },
    { x: -6, z: 0 },
    { x: -6, z: 5 },
    { x: 0, z: 7 },
    { x: 0, z: -7 },
  ]

  function refreshRovers(): void {
    if (!engine) return
    roverIds = engine.robots.ids()
    if (selectedRover && !roverIds.includes(selectedRover)) {
      selectedRover = roverIds[0] ?? null
    }
    roverSnapshots = roverIds
      .map((id) => engine?.robots.snapshot(id) ?? null)
      .filter((snapshot): snapshot is RoverSnapshot => snapshot !== null)
  }

  // Reactive (not a template function call): Svelte must re-render rover
  // readouts on every telemetry tick, and no-arg function calls in markup
  // are not invalidated by the array reassignment in refreshRovers().
  $: selectedSnap = roverSnapshots.find((snapshot) => snapshot.id === selectedRover) ?? null

  function spawnRoverUI(): void {
    if (!engine || !envInfo) return
    const halfExtent = envInfo.terrainWidth / 2 - 6
    const offset = ROVER_SPAWN_OFFSETS[roverIds.length % ROVER_SPAWN_OFFSETS.length] ?? { x: 6, z: 0 }
    const x = Math.max(-halfExtent, Math.min(halfExtent, offset.x))
    const z = Math.max(-halfExtent, Math.min(halfExtent, offset.z))
    const id = engine.spawnRover(x, z)
    roverModes[id] = 'manual'
    selectedRover = id
    roverControlMode = 'manual'
    refreshRovers()
    showToast(`Rover ${id} deployed`)
  }

  function removeSelectedRover(): void {
    if (!engine || !selectedRover) return
    const id = selectedRover
    if (followRoverEnabled && engine.followRover === id) {
      followRoverEnabled = false
    }
    engine.removeRover(id)
    delete roverModes[id]
    selectedRover = null
    refreshRovers()
    showToast(`Rover ${id} removed`)
  }

  function selectRover(id: string): void {
    selectedRover = id
    roverControlMode = roverModes[id] ?? 'manual'
    if (followRoverEnabled && engine) {
      engine.setFollowRover(id)
    }
  }

  function setRoverMode(mode: 'manual' | 'navigation' | 'external'): void {
    if (!engine || !selectedRover) return
    roverControlMode = mode
    roverModes[selectedRover] = mode
    if (mode === 'manual') {
      const controller = new ManualController()
      controller.setKeys(manualKeys)
      engine.robots.setController(selectedRover, controller)
    } else if (mode === 'navigation') {
      engine.robots.setController(selectedRover, new NavigationController())
      showToast('Autonomous waypoint control engaged')
    } else {
      // Placeholder policy: hold position. Real policies attach programmatically
      // (see RoverEnv) or via a future policy loader — never LLM per-frame control.
      engine.robots.setController(
        selectedRover,
        new ExternalController(() => ({ left: 0, right: 0, brake: true, eStop: false })),
      )
      showToast('External controller mode (holding position)')
    }
  }

  function pushManualKeys(): void {
    if (!engine || !selectedRover) return
    const controller = engine.robots.getController(selectedRover)
    if (controller instanceof ManualController) {
      controller.setKeys(manualKeys)
    }
  }

  function startRoverMission(): void {
    if (!engine || !selectedRover || !envInfo) return
    const halfExtent = envInfo.terrainWidth / 2 - 4
    const clamp = (value: number): number => Math.max(-halfExtent, Math.min(halfExtent, value))
    const rover = engine.robots.get(selectedRover)
    if (!rover) return
    const existing = engine.robots.missions.missionForRover(selectedRover)
    if (existing) {
      if (existing.status === 'active') {
        showToast('Mission already active')
        return
      }
      engine.robots.missions.start(existing.id)
    } else {
      const mission = engine.robots.missions.create(
        selectedRover,
        rover.position,
        { x: clamp(Number(missionTargetX)), y: 0, z: clamp(Number(missionTargetZ)) },
        2,
        180,
      )
      engine.robots.missions.start(mission.id)
    }
    if ((roverModes[selectedRover] ?? 'manual') !== 'navigation') {
      setRoverMode('navigation')
    }
    refreshRovers()
    showToast(`Mission active: navigate to (${missionTargetX}, ${missionTargetZ})`)
  }

  function resetRoverMission(): void {
    if (!engine || !selectedRover) return
    const mission = engine.robots.missions.missionForRover(selectedRover)
    if (mission) {
      engine.robots.missions.resetMission(mission.id)
      refreshRovers()
      showToast('Mission reset to pending')
    }
  }

  function toggleFollowRover(): void {
    if (!engine || !selectedRover) return
    followRoverEnabled = !followRoverEnabled
    engine.setFollowRover(followRoverEnabled ? selectedRover : null)
    showToast(followRoverEnabled ? 'Camera: Following Rover' : 'Camera: Free Orbit')
  }

  function toggleRoverRays(): void {
    if (!engine) return
    roverRaysVisible = !roverRaysVisible
    engine.robots.setRaysVisible(roverRaysVisible)
  }

  function manualDriveActive(): boolean {
    return (
      selectedRover !== null &&
      (roverModes[selectedRover] ?? 'manual') === 'manual' &&
      !controlsDisabled
    )
  }

  function applyDriveKey(key: string, pressed: boolean): boolean {
    if (!manualDriveActive()) return false
    if (key === 'ArrowUp') manualKeys.forward = pressed
    else if (key === 'ArrowDown') manualKeys.reverse = pressed
    else if (key === 'ArrowLeft') manualKeys.turnLeft = pressed
    else if (key === 'ArrowRight') manualKeys.turnRight = pressed
    else if (key === 'b' || key === 'B') manualKeys.brake = pressed
    else return false
    pushManualKeys()
    return true
  }

  function handleKeyup(event: KeyboardEvent): void {
    applyDriveKey(event.key, false)
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName)) {
      return
    }
    if (applyDriveKey(event.key, true)) {
      event.preventDefault()
      return
    }
    if (event.code === 'Space') {
      event.preventDefault()
      togglePause()
    } else if (event.key === 'r' || event.key === 'R') {
      resetSimulation()
    } else if (event.key === 'd' || event.key === 'D') {
      dropSimulation()
    } else if (event.key === '1') {
      selectPlanet('earth')
    } else if (event.key === '2') {
      selectPlanet('mars')
    } else if (event.key === 'h' || event.key === 'H') {
      showHud = !showHud
    } else if (event.key === 'm' || event.key === 'M') {
      dockOpen = !dockOpen
    } else if (event.key === 'c' || event.key === 'C') {
      setCameraMode('sphere')
    } else if (event.key === 'f' || event.key === 'F') {
      toggleFullscreen()
    } else if (event.key === '?') {
      showShortcuts = !showShortcuts
    }
  }

  // Reactive Telemetry Helpers
  $: pauseLabel = telemetry.status === 'running' ? 'Pause' : 'Resume'
  $: controlsDisabled = loading || initError !== null
  $: profiles = envInfo ? profilesForPlanet(envInfo.planet) : []
  $: scenarios = envInfo ? scenariosForPlanet(envInfo.planet) : []
  
  // Mission Elapsed Time formatter
  $: metFormatted = (() => {
    const totalSec = Math.max(0, telemetry.time)
    const m = Math.floor(totalSec / 60)
    const s = Math.floor(totalSec % 60)
    const ms = Math.floor((totalSec % 1) * 100)
    return `T+ ${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`
  })()

  // Kinematics & Velocity
  $: speedMps = telemetry.velocity
    ? Math.hypot(telemetry.velocity.x, telemetry.velocityY, telemetry.velocity.z)
    : Math.abs(telemetry.velocityY)
  $: speedKmh = speedMps * 3.6
  $: speedPercent = Math.min(100, (speedMps / 15) * 100)

  // Environmental Snapshot Data
  $: env = telemetry.environment
  $: currentWindSpeed = env ? Math.hypot(env.wind.x, env.wind.y, env.wind.z) : 0
  $: currentWindDeg = env ? Math.round(((Math.atan2(env.wind.z, env.wind.x) * 180) / Math.PI + 360) % 360) : 0
  
  $: beaufortDesc = (() => {
    const s = currentWindSpeed
    if (s < 0.5) return 'Calm Air'
    if (s < 3.3) return 'Light Air'
    if (s < 5.5) return 'Light Breeze'
    if (s < 8.0) return 'Gentle Breeze'
    if (s < 10.8) return 'Moderate Breeze'
    if (s < 13.9) return 'Fresh Breeze'
    if (s < 17.2) return 'Strong Wind'
    if (s < 20.8) return 'Near Gale'
    if (s < 24.5) return 'Gale Force'
    if (s < 28.5) return 'Severe Gale'
    if (s < 32.7) return 'Storm'
    return 'Violent Storm'
  })()

  $: atmosphereText = envInfo
    ? `${(envInfo.atmospherePressure / 1000).toFixed(1)} kPa · ${envInfo.atmosphereDensity} kg/m³`
    : '—'
  $: gravityText = `${Math.abs(telemetry.gravity.y).toFixed(2)} m/s² (${(Math.abs(telemetry.gravity.y) / 9.81).toFixed(2)}G)`
  $: tempCelsius = env ? (env.temperature - 273.15).toFixed(1) : '—'
  $: solarIrradianceText = env ? `${env.solarIrradiance.toFixed(0)} W/m²` : '—'
  $: visibilityText = env
    ? env.visibility >= 1000
      ? `${(env.visibility / 1000).toFixed(1)} km`
      : `${env.visibility.toFixed(0)} m`
    : '—'
</script>

<main class="ark-viewport">
  <!-- 3D WebGL Canvas Layer -->
  <div class="canvas-container" bind:this={container}></div>

  <!-- Loading State -->
  {#if loading}
    <div class="viewport-loader" role="status">
      <div class="loader-spinner"></div>
      <p class="loader-text">INITIALIZING SYNTHETIC PHYSICS ENGINE…</p>
    </div>
  {:else if initError !== null}
    <div class="viewport-error" role="alert">
      <span class="error-badge">Physics Core Error</span>
      <h2 class="error-title">Initialization Fault</h2>
      <p class="error-detail">{initError}</p>
      <button type="button" class="action-btn primary" on:click={() => window.location.reload()}>
        Reboot Engine
      </button>
    </div>
  {/if}

  <!-- TOP GLOBAL MISSION BAR (APPLE / SPACEX MISSION CONTROL) -->
  <header class="mission-header">
    <div class="brand-section">
      <div class="brand-logo" title="ARK Synthetic Autonomy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 17 12 22 22 17" />
          <polyline points="2 12 12 17 22 12" />
        </svg>
      </div>
      <div class="brand-titles">
        <div class="brand-name">
          <span>ARK</span>
          <span class="engine-status-pill">
            <span class="status-beacon" class:paused={telemetry.status === 'paused'}></span>
            {telemetry.status === 'running' ? '60Hz ACTIVE' : 'PAUSED'}
          </span>
        </div>
        <span class="brand-tag">Autonomous Robotics Planetary Sim</span>
      </div>
    </div>

    <!-- Center Clock & Planet Selector -->
    <div class="header-center">
      <div class="planet-segmented" role="group" aria-label="Target World">
        <button
          type="button"
          class="planet-tab-btn earth"
          class:active={envInfo?.planet === 'earth'}
          on:click={() => selectPlanet('earth')}
          disabled={controlsDisabled}
        >
          <svg class="planet-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <span>Earth (1.00G)</span>
        </button>
        <button
          type="button"
          class="planet-tab-btn mars"
          class:active={envInfo?.planet === 'mars'}
          on:click={() => selectPlanet('mars')}
          disabled={controlsDisabled}
        >
          <svg class="planet-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="9" />
            <path d="M18 6l3.5-3.5M21.5 2.5h-4M21.5 2.5v4" />
          </svg>
          <span>Mars (0.38G)</span>
        </button>
      </div>

      <div class="met-clock" title="Mission Elapsed Time">
        <span class="met-label">MET</span>
        <span class="met-digits">{metFormatted}</span>
      </div>
    </div>

    <!-- Right Global Action Bar -->
    <div class="header-actions">
      <button
        type="button"
        class="action-btn primary"
        class:paused={telemetry.status === 'paused'}
        on:click={togglePause}
        disabled={controlsDisabled}
        title="Toggle simulation pause [Space]"
      >
        {#if telemetry.status === 'running'}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="4" width="4" height="16" rx="1" />
            <rect x="14" y="4" width="4" height="16" rx="1" />
          </svg>
          <span>Pause</span>
        {:else}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
          <span>Resume</span>
        {/if}
      </button>

      <button
        type="button"
        class="action-btn"
        on:click={resetSimulation}
        disabled={controlsDisabled}
        title="Reset simulation [R]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="1 4 1 10 7 10" />
          <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
        </svg>
        <span>Reset</span>
      </button>

      <button
        type="button"
        class="action-btn"
        on:click={dropSimulation}
        disabled={controlsDisabled}
        title="Drop robot from spawn [D]"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 2v14M19 9l-7 7-7-7M5 20h14" />
        </svg>
        <span>Drop Robot</span>
      </button>

      <button
        type="button"
        class="action-btn icon-only"
        on:click={() => (showShortcuts = true)}
        title="Keybindings [?]"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3M12 17h.01" />
        </svg>
      </button>

      <button
        type="button"
        class="action-btn icon-only"
        class:primary={dockOpen}
        on:click={() => (dockOpen = !dockOpen)}
        title="Toggle Mission Dock [M]"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M15 3v18" />
        </svg>
      </button>
    </div>
  </header>

  <!-- HUD: TOP-LEFT PLANETARY TELEMETRY -->
  {#if showHud}
    <div class="hud-planet-badge" class:mars={envInfo?.planet === 'mars'} class:earth={envInfo?.planet === 'earth'}>
      <div class="hud-title-row">
        <span class="hud-planet-name">
          {envInfo?.planet === 'mars' ? 'MARS // SOL-IV' : 'EARTH // SOL-III'}
        </span>
        <span class="hud-planet-coord">SYS-NOMINAL</span>
      </div>
      <div class="hud-metric-grid">
        <div class="hud-metric-item">
          <span class="hud-metric-label">Gravity</span>
          <span class="hud-metric-val">{gravityText}</span>
        </div>
        <div class="hud-metric-item">
          <span class="hud-metric-label">Atmosphere</span>
          <span class="hud-metric-val">{atmosphereText}</span>
        </div>
        <div class="hud-metric-item">
          <span class="hud-metric-label">Solar Irradiance</span>
          <span class="hud-metric-val">{solarIrradianceText}</span>
        </div>
        <div class="hud-metric-item">
          <span class="hud-metric-label">Visibility</span>
          <span class="hud-metric-val">{visibilityText}</span>
        </div>
      </div>
    </div>
  {/if}

  <!-- HUD: TOP-RIGHT TACTICAL CAMERA TOOLBAR -->
  <div class="hud-tactical-tools" class:dock-closed={!dockOpen}>
    <button
      type="button"
      class="cam-tool-btn"
      class:active={activeCameraMode === 'orbit'}
      on:click={() => setCameraMode('orbit')}
      title="Free orbital camera"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M3 12a9 9 0 1 0 18 0 9 9 0 0 0-18 0" />
      </svg>
      <span>Orbit</span>
    </button>

    <button
      type="button"
      class="cam-tool-btn"
      class:active={activeCameraMode === 'sphere'}
      on:click={() => setCameraMode('sphere')}
      title="Focus and track robot payload [C]"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="8" />
        <line x1="12" y1="2" x2="12" y2="4" />
        <line x1="12" y1="20" x2="12" y2="22" />
        <line x1="2" y1="12" x2="4" y2="12" />
        <line x1="20" y1="12" x2="22" y2="12" />
      </svg>
      <span>Robot</span>
    </button>

    <button
      type="button"
      class="cam-tool-btn"
      class:active={activeCameraMode === 'box'}
      on:click={() => setCameraMode('box')}
      title="Focus wind aerodynamic test rig"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      </svg>
      <span>Wind Rig</span>
    </button>

    <button
      type="button"
      class="cam-tool-btn"
      class:active={activeCameraMode === 'topdown'}
      on:click={() => setCameraMode('topdown')}
      title="Satellite bird's eye view"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="12 2 19 21 12 17 5 21 12 2" />
      </svg>
      <span>Top-Down</span>
    </button>

    <div class="tool-divider"></div>

    <button
      type="button"
      class="cam-tool-btn"
      class:active={debugMode}
      on:click={handleDebugToggle}
      title="Toggle physics wireframe / coordinate axes"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="4" y1="9" x2="20" y2="9" />
        <line x1="4" y1="15" x2="20" y2="15" />
        <line x1="10" y1="3" x2="8" y2="21" />
        <line x1="16" y1="3" x2="14" y2="21" />
      </svg>
      <span>Debug</span>
    </button>

    <button
      type="button"
      class="cam-tool-btn"
      class:active={weatherQuality === 'high'}
      on:click={toggleWeatherQuality}
      title="Toggle weather particle density"
    >
      <span>{weatherQuality === 'high' ? 'HQ FX' : 'FAST'}</span>
    </button>

    <button
      type="button"
      class="cam-tool-btn"
      class:active={showHud}
      on:click={() => (showHud = !showHud)}
      title="Toggle HUD flight display [H]"
    >
      <span>HUD</span>
    </button>
  </div>

  <!-- HUD: BOTTOM-LEFT ROBOT TELEMETRY RIBBON -->
  {#if showHud}
    <div class="hud-telemetry-ribbon">
      <div class="telemetry-header">
        <div class="telemetry-title">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <circle cx="12" cy="12" r="10" />
            <circle cx="12" cy="12" r="3" />
          </svg>
          <span>Robot Kinematics</span>
        </div>
        <span class="telemetry-agent-status">
          {telemetry.status === 'running' ? 'TRACKING' : 'IDLE'}
        </span>
      </div>

      <!-- XYZ Position Readout -->
      <div class="telemetry-coords-row">
        <div class="coord-chip">
          <div class="coord-label">
            <span class="axis-dot x"></span>
            <span>POS X</span>
          </div>
          <span class="coord-val">{telemetry.position.x.toFixed(2)}m</span>
        </div>
        <div class="coord-chip">
          <div class="coord-label">
            <span class="axis-dot y"></span>
            <span>ALT Y</span>
          </div>
          <span class="coord-val">{telemetry.position.y.toFixed(2)}m</span>
        </div>
        <div class="coord-chip">
          <div class="coord-label">
            <span class="axis-dot z"></span>
            <span>POS Z</span>
          </div>
          <span class="coord-val">{telemetry.position.z.toFixed(2)}m</span>
        </div>
      </div>

      <!-- Linear Speedometer & Gauge -->
      <div class="speed-bar-container">
        <div class="speed-metric-row">
          <span class="speed-label">Ground Velocity</span>
          <div class="speed-val-wrap">
            <span class="speed-primary">{speedMps.toFixed(2)} m/s</span>
            <span class="speed-secondary">({speedKmh.toFixed(1)} km/h)</span>
          </div>
        </div>
        <div class="speed-track">
          <div class="speed-fill" style="width: {speedPercent}%"></div>
        </div>
      </div>

      <!-- Surface & Traction -->
      <div class="surface-traction-row">
        <div class="surface-stat">
          <span class="surface-stat-label">Contact Material</span>
          <span class="surface-stat-val">{telemetry.surface}</span>
        </div>
        <div class="surface-stat">
          <span class="surface-stat-label">Vertical Velocity</span>
          <span class="surface-stat-val">
            {telemetry.velocityY >= 0 ? '▲ +' : '▼ '}
            {telemetry.velocityY.toFixed(2)} m/s
          </span>
        </div>
      </div>
    </div>

    <!-- HUD: BOTTOM-CENTER WIND VECTOR COMPASS -->
    <div class="hud-wind-compass">
      <div class="compass-dial-wrap">
        <span class="compass-cardinal-n">N</span>
        <div class="compass-needle" style="transform: rotate({currentWindDeg}deg)"></div>
      </div>
      <div class="wind-readout">
        <span class="wind-speed-text">{currentWindSpeed.toFixed(1)} m/s · {currentWindDeg}°</span>
        <span class="wind-desc-text">{beaufortDesc} · Aero {aeroEnabled ? 'Active' : 'Off'}</span>
      </div>
    </div>
  {/if}

  <!-- FLOATING MISSION COMMAND CENTER (RIGHT GLASS DOCK) -->
  <aside class="mission-dock" class:collapsed={!dockOpen}>
    <!-- Navigation Tabs -->
    <div class="dock-nav-tabs" role="tablist">
      <button
        type="button"
        class="dock-tab-btn"
        role="tab"
        aria-selected={activeTab === 'world'}
        class:active={activeTab === 'world'}
        on:click={() => (activeTab = 'world')}
      >
        <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
        <span class="tab-title">World</span>
      </button>

      <button
        type="button"
        class="dock-tab-btn"
        role="tab"
        aria-selected={activeTab === 'weather'}
        class:active={activeTab === 'weather'}
        on:click={() => (activeTab = 'weather')}
      >
        <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2" />
        </svg>
        <span class="tab-title">Atmosphere</span>
      </button>

      <button
        type="button"
        class="dock-tab-btn"
        role="tab"
        aria-selected={activeTab === 'scenarios'}
        class:active={activeTab === 'scenarios'}
        on:click={() => (activeTab = 'scenarios')}
      >
        <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
        <span class="tab-title">Scenarios</span>
      </button>

      <button
        type="button"
        class="dock-tab-btn"
        role="tab"
        aria-selected={activeTab === 'robot'}
        class:active={activeTab === 'robot'}
        on:click={() => (activeTab = 'robot')}
      >
        <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="10" rx="2" />
          <circle cx="12" cy="5" r="2" />
          <path d="M12 7v4M8 15h.01M16 15h.01" />
        </svg>
        <span class="tab-title">Payload</span>
      </button>

      <button
        type="button"
        class="dock-tab-btn"
        role="tab"
        aria-selected={activeTab === 'mission'}
        class:active={activeTab === 'mission'}
        on:click={() => (activeTab = 'mission')}
      >
        <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
        <span class="tab-title">Mission AI</span>
      </button>
    </div>

    <!-- Scrollable Body Content -->
    <div class="dock-body">
      <div class="dock-tab-pane" class:hidden={activeTab !== 'world'} role="tabpanel">
        <!-- World & Terrain Profile -->
        <div class="dock-section">
          <div class="section-title-row">
            <h3 class="section-title">Terrain Profile</h3>
            <span class="section-badge">{envInfo?.planet.toUpperCase()}</span>
          </div>

          <div class="control-group">
            <label class="control-label" for="terrain-profile-select">Topography Mode</label>
            <select
              id="terrain-profile-select"
              class="ark-select"
              on:change={handleProfileChange}
              disabled={controlsDisabled}
              value={envInfo?.profileId ?? ''}
            >
              {#each profiles as profile (profile.id)}
                <option value={profile.id}>{profile.label}</option>
              {/each}
            </select>
          </div>

          <!-- World Seed Generator -->
          <div class="control-group">
            <label class="control-label" for="terrain-seed-input">Procedural Seed</label>
            <div class="seed-action-row">
              <input
                id="terrain-seed-input"
                class="ark-input mono"
                type="number"
                bind:value={seedInput}
                disabled={controlsDisabled}
              />
              <button
                type="button"
                class="icon-action-btn"
                on:click={randomizeSeed}
                disabled={controlsDisabled}
                title="Generate Random Seed"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
                </svg>
              </button>
              <button
                type="button"
                class="icon-action-btn"
                on:click={copySeed}
                disabled={controlsDisabled}
                title="Copy Seed to Clipboard"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            </div>
          </div>

          <div class="event-triggers-grid">
            <button
              type="button"
              class="event-trigger-btn"
              on:click={regenerateWorld}
              disabled={controlsDisabled}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="1 4 1 10 7 10" />
                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
              </svg>
              <span>Regenerate</span>
            </button>
            <button
              type="button"
              class="event-trigger-btn"
              on:click={resetWorld}
              disabled={controlsDisabled}
            >
              <span>Reset World</span>
            </button>
          </div>
        </div>

        <!-- Planetary Specs Card -->
        <div class="dock-section">
          <div class="section-title-row">
            <h3 class="section-title">Physical Constants</h3>
            <span class="section-badge">SOL // CONST</span>
          </div>

          <div class="hud-metric-grid">
            <div class="hud-metric-item">
              <span class="hud-metric-label">Gravity Constant</span>
              <span class="hud-metric-val">{gravityText}</span>
            </div>
            <div class="hud-metric-item">
              <span class="hud-metric-label">Atmosphere</span>
              <span class="hud-metric-val">{atmosphereText}</span>
            </div>
            <div class="hud-metric-item">
              <span class="hud-metric-label">Domain Dimensions</span>
              <span class="hud-metric-val">100 × 100 m</span>
            </div>
            <div class="hud-metric-item">
              <span class="hud-metric-label">Mesh Resolution</span>
              <span class="hud-metric-val">128² Cells</span>
            </div>
          </div>
        </div>
      </div>
      <div class="dock-tab-pane" class:hidden={activeTab !== 'weather'} role="tabpanel">
        <!-- Atmosphere & Dynamic Weather Controls -->
        <div class="dock-section">
          <div class="section-title-row">
            <h3 class="section-title">Wind & Aerodynamics</h3>
            <span class="section-badge">{currentWindSpeed.toFixed(1)} m/s</span>
          </div>

          <!-- Wind Speed Slider -->
          <div class="control-group">
            <div class="control-label-row">
              <span class="control-label">Velocity (m/s)</span>
              <span class="control-val-badge">{windSpeedVal} m/s</span>
            </div>
            <input
              class="ark-slider"
              type="range"
              min="0"
              max="60"
              step="1"
              bind:value={windSpeedVal}
              on:input={handleWindChange}
              disabled={controlsDisabled}
            />
            <div class="presets-pill-row">
              <button type="button" class="preset-pill" on:click={() => setWindPreset(2)}>Calm (2)</button>
              <button type="button" class="preset-pill" on:click={() => setWindPreset(8)}>Breeze (8)</button>
              <button type="button" class="preset-pill" on:click={() => setWindPreset(16)}>Gale (16)</button>
              <button type="button" class="preset-pill" on:click={() => setWindPreset(30)}>Storm (30)</button>
            </div>
          </div>

          <!-- Wind Direction Slider -->
          <div class="control-group">
            <div class="control-label-row">
              <span class="control-label">Direction Heading</span>
              <span class="control-val-badge">{windDirectionVal}°</span>
            </div>
            <input
              class="ark-slider"
              type="range"
              min="0"
              max="360"
              step="5"
              bind:value={windDirectionVal}
              on:input={handleWindChange}
              disabled={controlsDisabled}
            />
            <div class="presets-pill-row">
              <button type="button" class="preset-pill" on:click={() => setWindPreset(windSpeedVal, 0)}>N (0°)</button>
              <button type="button" class="preset-pill" on:click={() => setWindPreset(windSpeedVal, 90)}>E (90°)</button>
              <button type="button" class="preset-pill" on:click={() => setWindPreset(windSpeedVal, 180)}>S (180°)</button>
              <button type="button" class="preset-pill" on:click={() => setWindPreset(windSpeedVal, 270)}>W (270°)</button>
            </div>
          </div>

          <!-- Aerodynamic Switch -->
          <div class="switch-row">
            <div class="switch-label-wrap">
              <span class="switch-title">Aerodynamic Forces</span>
              <span class="switch-subtext">Apply air resistance and lift drag to payloads</span>
            </div>
            <label class="apple-switch">
              <input type="checkbox" checked={aeroEnabled} on:change={toggleAeroSwitch} disabled={controlsDisabled} />
              <span class="switch-slider"></span>
            </label>
          </div>
        </div>

        <!-- Thermodynamics & Surface Friction -->
        <div class="dock-section">
          <div class="section-title-row">
            <h3 class="section-title">Surface & Atmosphere</h3>
            <span class="section-badge">{tempCelsius}°C</span>
          </div>

          <!-- Temperature -->
          <div class="control-group">
            <div class="control-label-row">
              <span class="control-label">Surface Temperature</span>
              <span class="control-val-badge">{temperatureVal}°C</span>
            </div>
            <input
              class="ark-slider"
              type="range"
              min="-120"
              max="50"
              step="1"
              bind:value={temperatureVal}
              on:input={handleTempChange}
              disabled={controlsDisabled}
            />
          </div>

          <!-- Traction Multiplier -->
          <div class="control-group">
            <div class="control-label-row">
              <span class="control-label">Surface Traction</span>
              <span class="control-val-badge">×{tractionVal.toFixed(2)}</span>
            </div>
            <input
              class="ark-slider"
              type="range"
              min="0.2"
              max="1.5"
              step="0.05"
              bind:value={tractionVal}
              on:input={handleTractionChange}
              disabled={controlsDisabled}
            />
            <div class="presets-pill-row">
              <button type="button" class="preset-pill" on:click={() => { tractionVal = 0.25; handleTractionChange() }}>Ice (0.25)</button>
              <button type="button" class="preset-pill" on:click={() => { tractionVal = 0.65; handleTractionChange() }}>Wet Soil (0.65)</button>
              <button type="button" class="preset-pill" on:click={() => { tractionVal = 1.0; handleTractionChange() }}>Nominal (1.0)</button>
              <button type="button" class="preset-pill" on:click={() => { tractionVal = 1.4; handleTractionChange() }}>High Grip (1.4)</button>
            </div>
          </div>

          <!-- Planet specific opacity -->
          {#if envInfo?.planet === 'earth'}
            <div class="control-group">
              <div class="control-label-row">
                <span class="control-label">Cloud Opacity</span>
                <span class="control-val-badge">{(cloudVal * 100).toFixed(0)}%</span>
              </div>
              <input
                class="ark-slider"
                type="range"
                min="0"
                max="1"
                step="0.05"
                bind:value={cloudVal}
                on:input={handleCloudChange}
                disabled={controlsDisabled}
              />
            </div>
          {:else}
            <div class="control-group">
              <div class="control-label-row">
                <span class="control-label">Dust Optical Depth (τ)</span>
                <span class="control-val-badge">{dustVal.toFixed(2)}</span>
              </div>
              <input
                class="ark-slider"
                type="range"
                min="0"
                max="5"
                step="0.1"
                bind:value={dustVal}
                on:input={handleDustChange}
                disabled={controlsDisabled}
              />
            </div>
          {/if}
        </div>

        <!-- Weather Event Triggers -->
        <div class="dock-section">
          <div class="section-title-row">
            <h3 class="section-title">Trigger Planetary Events</h3>
            <span class="section-badge">DYNAMIC FX</span>
          </div>

          <div class="event-triggers-grid">
            {#if envInfo?.planet === 'earth'}
              <button
                type="button"
                class="event-trigger-btn warning"
                on:click={startRain}
                disabled={controlsDisabled}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="16" y1="13" x2="16" y2="21" />
                  <line x1="8" y1="13" x2="8" y2="21" />
                  <line x1="12" y1="15" x2="12" y2="23" />
                  <path d="M20 16.58A5 5 0 0 0 18 7h-1.26A8 8 0 1 0 4 15.25" />
                </svg>
                <span>Trigger Rain</span>
              </button>
            {:else}
              <button
                type="button"
                class="event-trigger-btn danger"
                on:click={startDustStorm}
                disabled={controlsDisabled}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2" />
                </svg>
                <span>Dust Storm</span>
              </button>
            {/if}

            <button
              type="button"
              class="event-trigger-btn"
              on:click={startGust}
              disabled={controlsDisabled}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />
              </svg>
              <span>Microburst</span>
            </button>
          </div>

          <!-- Active Events List -->
          {#if env && env.activeEventIds.length > 0}
            <div class="active-events-list">
              {#each env.activeEventIds as eventId (eventId)}
                <div class="active-event-card">
                  <span>{eventId}</span>
                  <button
                    type="button"
                    class="event-dismiss-btn"
                    on:click={() => stopEnvEvent(eventId)}
                    title="Stop Event"
                  >
                    ✕ Stop
                  </button>
                </div>
              {/each}
            </div>
          {/if}

          <button
            type="button"
            class="event-trigger-btn"
            on:click={resetEnvironment}
            disabled={controlsDisabled}
          >
            <span>Restore Nominal Atmosphere</span>
          </button>
        </div>
      </div>
      <div class="dock-tab-pane" class:hidden={activeTab !== 'scenarios'} role="tabpanel">
        <!-- Autonomous Robot Training Scenarios -->
        <div class="dock-section">
          <div class="section-title-row">
            <h3 class="section-title">Autonomy Benchmark Scenarios</h3>
            <span class="section-badge">{scenarios.length} READY</span>
          </div>

          <div class="scenarios-grid">
            {#each scenarios as scenario (scenario.id)}
              <div
                class="scenario-card"
                role="button"
                tabindex="0"
                on:click={() => applyScenario(scenario.id)}
                on:keydown={(e) => e.key === 'Enter' && applyScenario(scenario.id)}
              >
                <div class="scenario-title-row">
                  <span class="scenario-name">{scenario.label}</span>
                  <span class="scenario-tag">{scenario.planet}</span>
                </div>
                <p class="scenario-desc">{scenario.description}</p>
              </div>
            {/each}
          </div>
        </div>
      </div>
      <div class="dock-tab-pane" class:hidden={activeTab !== 'robot'} role="tabpanel">
        <!-- Rover Fleet (Milestone 5) -->
        <div class="dock-section">
          <div class="section-title-row">
            <h3 class="section-title">Rover Fleet</h3>
            <span class="section-badge">{roverIds.length} ACTIVE</span>
          </div>

          {#if roverIds.length === 0}
            <p class="mission-hint">No rovers deployed. Spawn one to begin surface operations.</p>
          {:else}
            <div class="presets-pill-row">
              {#each roverIds as id (id)}
                <button
                  type="button"
                  class="preset-pill"
                  class:active={id === selectedRover}
                  on:click={() => selectRover(id)}
                >
                  {id}
                </button>
              {/each}
            </div>
          {/if}

          <div class="event-triggers-grid">
            <button
              type="button"
              class="event-trigger-btn"
              on:click={spawnRoverUI}
              disabled={controlsDisabled}
            >
              <span>Spawn Rover</span>
            </button>
            <button
              type="button"
              class="event-trigger-btn"
              on:click={removeSelectedRover}
              disabled={controlsDisabled || !selectedRover}
            >
              <span>Remove</span>
            </button>
          </div>
        </div>

        {#if selectedSnap}
          {@const snap = selectedSnap}
          <div class="dock-section">
            <div class="section-title-row">
              <h3 class="section-title">Control · {selectedRover}</h3>
              <span class="section-badge">{roverControlMode.toUpperCase()}</span>
            </div>

            <div class="presets-pill-row">
              <button
                type="button"
                class="preset-pill"
                class:active={roverControlMode === 'manual'}
                on:click={() => setRoverMode('manual')}
              >
                Manual
              </button>
              <button
                type="button"
                class="preset-pill"
                class:active={roverControlMode === 'navigation'}
                on:click={() => setRoverMode('navigation')}
              >
                Auto Nav
              </button>
              <button
                type="button"
                class="preset-pill"
                class:active={roverControlMode === 'external'}
                on:click={() => setRoverMode('external')}
              >
                External
              </button>
            </div>
            {#if roverControlMode === 'manual'}
              <p class="mission-hint">Drive: ↑ forward · ↓ reverse · ←/→ turn · B brake</p>
            {/if}

            <div class="hud-metric-grid">
              <div class="hud-metric-item">
                <span class="hud-metric-label">Battery</span>
                <span class="hud-metric-val">{((snap?.battery.percent ?? 0) * 100).toFixed(0)}%</span>
              </div>
              <div class="hud-metric-item">
                <span class="hud-metric-label">Speed</span>
                <span class="hud-metric-val">{(snap?.speed ?? 0).toFixed(1)} m/s</span>
              </div>
              <div class="hud-metric-item">
                <span class="hud-metric-label">Position</span>
                <span class="hud-metric-val mono">
                  {(snap?.position.x ?? 0).toFixed(1)}, {(snap?.position.z ?? 0).toFixed(1)}
                </span>
              </div>
              <div class="hud-metric-item">
                <span class="hud-metric-label">Heading</span>
                <span class="hud-metric-val">
                  {(((((snap?.yawRad ?? 0) * 180) / Math.PI) % 360 + 360) % 360).toFixed(0)}°
                </span>
              </div>
            </div>
            <div class="rover-battery-track" title="Battery charge">
              <div
                class="rover-battery-fill"
                class:low={(snap?.battery.percent ?? 1) < 0.25}
                style={`width: ${((snap?.battery.percent ?? 0) * 100).toFixed(1)}%`}
              ></div>
            </div>
          </div>

          <div class="dock-section">
            <div class="section-title-row">
              <h3 class="section-title">Navigation Mission</h3>
              <span class="section-badge">{(snap?.missionStatus ?? 'none').toUpperCase()}</span>
            </div>
            <div class="control-group">
              <div class="control-label-row">
                <span class="control-label">Target X (m)</span>
                <span class="control-label">Target Z (m)</span>
              </div>
              <div class="seed-action-row">
                <input
                  class="ark-input mono"
                  type="number"
                  bind:value={missionTargetX}
                  disabled={controlsDisabled}
                  aria-label="Mission target X"
                />
                <input
                  class="ark-input mono"
                  type="number"
                  bind:value={missionTargetZ}
                  disabled={controlsDisabled}
                  aria-label="Mission target Z"
                />
              </div>
            </div>
            <div class="event-triggers-grid">
              <button
                type="button"
                class="event-trigger-btn"
                on:click={startRoverMission}
                disabled={controlsDisabled}
              >
                <span>Start Mission</span>
              </button>
              <button
                type="button"
                class="event-trigger-btn"
                on:click={resetRoverMission}
                disabled={controlsDisabled}
              >
                <span>Reset Mission</span>
              </button>
            </div>
          </div>

          <div class="dock-section">
            <div class="section-title-row">
              <h3 class="section-title">Rover Camera</h3>
            </div>
            <div class="event-triggers-grid">
              <button
                type="button"
                class="event-trigger-btn"
                on:click={() => selectedRover && engine?.focusRover(selectedRover)}
                disabled={controlsDisabled}
              >
                <span>Focus Rover</span>
              </button>
              <button
                type="button"
                class="event-trigger-btn"
                class:active={followRoverEnabled}
                on:click={toggleFollowRover}
                disabled={controlsDisabled}
              >
                <span>{followRoverEnabled ? 'Stop Follow' : 'Follow'}</span>
              </button>
            </div>
            <div class="switch-row">
              <div class="switch-label-wrap">
                <span class="switch-title">Sensor-ray visualization</span>
                <span class="switch-subtext">Show the 5 distance-sensor rays</span>
              </div>
              <label class="apple-switch">
                <input
                  type="checkbox"
                  checked={roverRaysVisible}
                  on:change={toggleRoverRays}
                  disabled={controlsDisabled}
                />
                <span class="switch-slider"></span>
              </label>
            </div>
          </div>
        {/if}

        <!-- Payload Specifications -->
        <div class="dock-section">
          <div class="section-title-row">
            <h3 class="section-title">Robot Payload Alpha</h3>
            <span class="section-badge">SPHERE TESTBED</span>
          </div>

          <div class="hud-metric-grid">
            <div class="hud-metric-item">
              <span class="hud-metric-label">Radius</span>
              <span class="hud-metric-val">0.50 m</span>
            </div>
            <div class="hud-metric-item">
              <span class="hud-metric-label">Mass</span>
              <span class="hud-metric-val">15.70 kg</span>
            </div>
            <div class="hud-metric-item">
              <span class="hud-metric-label">Restitution</span>
              <span class="hud-metric-val">0.35</span>
            </div>
            <div class="hud-metric-item">
              <span class="hud-metric-label">Surface Friction</span>
              <span class="hud-metric-val">0.60</span>
            </div>
          </div>

          <div class="event-triggers-grid">
            <button type="button" class="event-trigger-btn" on:click={dropSimulation} disabled={controlsDisabled}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2v14M19 9l-7 7-7-7M5 20h14" />
              </svg>
              <span>Drop from Spawn</span>
            </button>
            <button type="button" class="event-trigger-btn" on:click={() => setCameraMode('sphere')}>
              <span>Track with Camera</span>
            </button>
          </div>
        </div>

        <div class="dock-section">
          <div class="section-title-row">
            <h3 class="section-title">Wind Test Rig Beta</h3>
            <span class="section-badge">AERODYNAMIC RIG</span>
          </div>

          <div class="hud-metric-grid">
            <div class="hud-metric-item">
              <span class="hud-metric-label">Geometry</span>
              <span class="hud-metric-val">0.5m Cube</span>
            </div>
            <div class="hud-metric-item">
              <span class="hud-metric-label">Drag Coeff (Cd)</span>
              <span class="hud-metric-val">1.05</span>
            </div>
            <div class="hud-metric-item">
              <span class="hud-metric-label">Frontal Area</span>
              <span class="hud-metric-val">0.25 m²</span>
            </div>
            <div class="hud-metric-item">
              <span class="hud-metric-label">Coupled Drag</span>
              <span class="hud-metric-val">{aeroEnabled ? 'Active' : 'Bypassed'}</span>
            </div>
          </div>

          <button type="button" class="event-trigger-btn" on:click={() => setCameraMode('box')}>
            <span>Focus Aerodynamic Rig</span>
          </button>
        </div>
      </div>
      <div class="dock-tab-pane" class:hidden={activeTab !== 'mission'} role="tabpanel">
        <MissionPanel
          {engine}
          disabled={controlsDisabled}
          onEnvironmentChanged={syncControlsFromEngine}
          notify={showToast}
        />
      </div>

      {#if envError}
        <div class="active-event-card" style="border-color: #ef4444; color: #fca5a5;">
          <span>{envError}</span>
        </div>
      {/if}
    </div>
  </aside>

  <!-- KEYBOARD SHORTCUTS MODAL -->
  {#if showShortcuts}
    <div
      class="shortcuts-modal-backdrop"
      role="button"
      tabindex="0"
      on:click={() => (showShortcuts = false)}
      on:keydown={(e) => (e.key === 'Escape' || e.key === 'Enter') && (showShortcuts = false)}
    >
      <div
        class="shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        tabindex="-1"
        on:click|stopPropagation
        on:keydown|stopPropagation
      >
        <div class="shortcuts-header">
          <h3 id="shortcuts-title" class="section-title" style="font-size: 0.9rem; color: #fff;">
            Tactical Keybindings
          </h3>
          <button type="button" class="event-dismiss-btn" on:click={() => (showShortcuts = false)}>✕</button>
        </div>

        <div class="shortcuts-list">
          <div class="shortcut-row">
            <span class="shortcut-desc">Pause / Resume</span>
            <kbd class="key-kbd">Space</kbd>
          </div>
          <div class="shortcut-row">
            <span class="shortcut-desc">Reset Sim</span>
            <kbd class="key-kbd">R</kbd>
          </div>
          <div class="shortcut-row">
            <span class="shortcut-desc">Drop Robot</span>
            <kbd class="key-kbd">D</kbd>
          </div>
          <div class="shortcut-row">
            <span class="shortcut-desc">Track Robot Cam</span>
            <kbd class="key-kbd">C</kbd>
          </div>
          <div class="shortcut-row">
            <span class="shortcut-desc">Target Earth</span>
            <kbd class="key-kbd">1</kbd>
          </div>
          <div class="shortcut-row">
            <span class="shortcut-desc">Target Mars</span>
            <kbd class="key-kbd">2</kbd>
          </div>
          <div class="shortcut-row">
            <span class="shortcut-desc">Toggle View HUD</span>
            <kbd class="key-kbd">H</kbd>
          </div>
          <div class="shortcut-row">
            <span class="shortcut-desc">Toggle Mission Dock</span>
            <kbd class="key-kbd">M</kbd>
          </div>
          <div class="shortcut-row">
            <span class="shortcut-desc">Toggle Fullscreen</span>
            <kbd class="key-kbd">F</kbd>
          </div>
          <div class="shortcut-row">
            <span class="shortcut-desc">Shortcuts Guide</span>
            <kbd class="key-kbd">?</kbd>
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- TOAST NOTIFICATION -->
  {#if toastMessage}
    <div class="ark-toast" class:dock-closed={!dockOpen} role="status">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-cyan)" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <span>{toastMessage}</span>
    </div>
  {/if}
</main>
