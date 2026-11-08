import type { Vector3 } from '../../../../../../packages/physics/src/types/SimulationTypes'
import { NavigationController } from '../../../../../../packages/physics/src/robotics/controllers'
import type { RobotManager } from '../../../../../../packages/physics/src/robotics/RobotManager'
import { RobotCapabilityRegistry, type RobotRole } from '../capabilities/RobotCapabilityRegistry'
import { CommunicationNetwork, type DeliveredRobotMessage } from '../communication/CommunicationNetwork'
import type { RobotMessage, RobotMessageType } from '../communication/MessageProtocol'
import { allocateTask, type CooperativeTask, type RobotCandidate } from './TaskAllocator'
import { FailureDetector } from '../recovery/FailureDetector'
import { rescueDistance, transitionRescue, type RescueMission, type RescuePhase } from '../missions/RescueMission'

export interface CooperativeRescueRoverView {
  id: string
  role: RobotRole
  capabilities: string[]
  position: Vector3
  batteryPercent: number
  motorEnabled: boolean
  missionStatus: string
  communication: 'online' | 'offline'
}

export interface CooperativeRescueSnapshot {
  mission: RescueMission | null
  rovers: CooperativeRescueRoverView[]
  task: CooperativeTask | null
  tether: { engaged: boolean; tensionN: number; rescuedDistanceM: number }
  messages: Array<{ timeS: number; senderId: string; recipientId: string; type: string; text: string }>
  events: Array<{ timeS: number; text: string }>
  network: { pending: number; dropped: number; rangeM: number; latencyS: number }
}

interface ScheduledFailure { atS: number; roverId: string }

/** Orchestrates a mission over existing rover instances and one shared physics world. */
export class CooperativeRescueCoordinator {
  public readonly capabilities = new RobotCapabilityRegistry()
  public readonly network = new CommunicationNetwork({ rangeM: 40, latencyS: 0.25, lossProbability: 0 }, 7)
  private readonly detector = new FailureDetector()
  private readonly inbox = new Map<string, DeliveredRobotMessage[]>()
  private readonly messages: CooperativeRescueSnapshot['messages'] = []
  private readonly events: CooperativeRescueSnapshot['events'] = []
  private mission: RescueMission | null = null
  private task: CooperativeTask | null = null
  private scheduledFailure: ScheduledFailure | null = null
  private messageSequence = 0
  private lastStatusAt = 0
  private tetherEngaged = false
  private tetherTensionN = 0
  private lastTowDirection: Vector3 | null = null

  constructor(
    private readonly robots: RobotManager,
    private readonly spawn: (x: number, z: number, seed?: number) => string,
  ) {}

  public startMarsRescue(seed: number, nowS: number): string {
    this.dispose()
    const terrainOffsets = [{ x: -8, z: -5 }, { x: -3, z: 0 }, { x: -4, z: -1 }]
    const explorerId = this.spawn(terrainOffsets[0]!.x, terrainOffsets[0]!.z, seed + 11)
    const carrierId = this.spawn(terrainOffsets[1]!.x, terrainOffsets[1]!.z, seed + 23)
    const supportId = this.spawn(terrainOffsets[2]!.x, terrainOffsets[2]!.z, seed + 37)
    this.capabilities.register(explorerId, 'explorer')
    this.capabilities.register(carrierId, 'carrier')
    this.capabilities.register(supportId, 'support')
    const initialPositions = this.positionMap()
    for (const id of [explorerId, carrierId, supportId]) {
      this.send(id, 'CAPABILITY_ADVERTISEMENT', nowS, { role: this.capabilities.get(id)?.role }, initialPositions)
    }
    for (const id of [carrierId, supportId]) this.robots.setController(id, new NavigationController())
    const explorer = this.robots.get(explorerId)!
    const target = { x: explorer.position.x + 18, y: 0, z: explorer.position.z + 10 }
    this.startNavigation(explorerId, target, 1, 150)
    this.mission = {
      id: `rescue-${seed}`, explorerId, responderId: null, failure: null, phase: 'idle',
      startTimeS: nowS, failurePosition: null,
      safeTarget: { x: explorer.position.x - 10, y: 0, z: explorer.position.z - 8 },
      elapsedS: 0, rescuedDistanceM: 0,
    }
    this.transition('exploring')
    this.scheduledFailure = { atS: nowS + 6, roverId: explorerId }
    this.event(nowS, 'Three role-specific rovers deployed in the shared Mars simulation; drive-motor fault scheduled at 6 s.')
    return explorerId
  }

  public beforePhysics(): void {
    if (!this.tetherEngaged || !this.mission?.failurePosition || !this.mission.responderId) return
    const disabled = this.robots.get(this.mission.explorerId)
    const support = this.robots.get(this.mission.responderId)
    if (!disabled || !support) return
    const dx = support.position.x - disabled.position.x
    const dz = support.position.z - disabled.position.z
    const distance = Math.hypot(dx, dz) || 1
    // Effective tow-hook spacing (center distance minus the two hook offsets).
    const extension = distance - 0.6
    if (extension <= 0) { this.tetherTensionN = 0; return }
    const ux = dx / distance
    const uz = dz / distance
    const relativeSpeed = ((support.inertial.linearVelocity.x - disabled.inertial.linearVelocity.x) * ux) +
      ((support.inertial.linearVelocity.z - disabled.inertial.linearVelocity.z) * uz)
    // Maintain enough tension to overcome Mars regolith contact friction,
    // while capping the force to avoid an unrealistic launch impulse.
    const force = Math.max(0, Math.min(450, 260 + extension * 150 + relativeSpeed * 24))
    this.tetherTensionN = force
    this.lastTowDirection = { x: ux, y: 0, z: uz }
    this.robots.applyExternalForce(this.mission.explorerId, { x: force * ux, y: 0, z: force * uz })
    this.robots.applyExternalForce(this.mission.responderId, { x: -force * ux, y: 0, z: -force * uz })
  }

  public update(dt: number, timeS: number): void {
    if (!this.mission) return
    this.mission.elapsedS += dt
    const positions = this.positionMap()
    if (this.scheduledFailure && timeS >= this.scheduledFailure.atS && this.mission.phase === 'exploring') {
      const failedId = this.scheduledFailure.roverId
      this.scheduledFailure = null
      this.robots.disableDriveMotor(failedId)
      const rover = this.robots.get(failedId)!
      this.mission.failurePosition = rover.position
      this.mission.failure = 'drive-motor-failure'
      this.transition('assistance-requested')
      this.send(failedId, 'ASSISTANCE_REQUEST', timeS, { reason: 'drive-motor-failure', missionId: this.mission.id }, positions)
      this.event(timeS, `${failedId} detected drive motor failure and broadcast an assistance request.`)
    }
    if (timeS - this.lastStatusAt >= 1) {
      this.lastStatusAt = timeS
      for (const id of this.robots.ids()) this.send(id, 'STATUS_UPDATE', timeS, {}, positions)
    }
    for (const delivery of this.network.update(timeS, positions)) this.receive(delivery, timeS)
    if (this.mission.phase === 'exploring') {
      const explorer = this.robots.get(this.mission.explorerId)
      if (explorer) {
        const upY = 1 - 2 * (explorer.rotation.x ** 2 + explorer.rotation.z ** 2)
        this.detector.observe(explorer.id, {
          dt, position: explorer.position,
          distanceToGoal: null, commandedEffort: explorer.commandedEffort,
          motorEnabled: explorer.motorEnabled, batteryPercent: explorer.battery().percent, upY,
        })
      }
    }
    this.updateMissions(dt, timeS)
  }

  public snapshot(): CooperativeRescueSnapshot {
    const rovers = this.robots.ids().flatMap((id) => {
      const rover = this.robots.get(id)
      const profile = this.capabilities.get(id)
      if (!rover || !profile) return []
      return [{
        id, role: profile.role, capabilities: profile.capabilities.filter((item) => item.available).map((item) => item.id),
        position: rover.position, batteryPercent: rover.battery().percent, motorEnabled: rover.motorEnabled,
        missionStatus: this.robots.missions.missionForRover(id)?.status ?? 'idle', communication: 'online' as const,
      }]
    })
    return {
      mission: this.mission ? { ...this.mission, failurePosition: this.mission.failurePosition ? { ...this.mission.failurePosition } : null,
        safeTarget: { ...this.mission.safeTarget } } : null,
      rovers, task: this.task ? { ...this.task, target: { ...this.task.target } } : null,
      tether: { engaged: this.tetherEngaged, tensionN: this.tetherTensionN, rescuedDistanceM: this.mission?.rescuedDistanceM ?? 0 },
      messages: this.messages.filter((message) => message.type !== 'STATUS_UPDATE').slice(-12), events: this.events.slice(-8),
      network: { pending: this.network.pendingCount, dropped: this.network.droppedCount, rangeM: this.network.settings.rangeM, latencyS: this.network.settings.latencyS },
    }
  }

  public dispose(): void {
    for (const id of this.capabilities.list().map((profile) => profile.roverId)) {
      this.capabilities.remove(id)
      this.robots.remove(id)
    }
    this.network.reset()
    this.detector.reset()
    this.inbox.clear()
    this.messages.length = 0
    this.events.length = 0
    this.mission = null
    this.task = null
    this.scheduledFailure = null
    this.tetherEngaged = false
    this.tetherTensionN = 0
    this.lastTowDirection = null
  }

  private updateMissions(dt: number, timeS: number): void {
    if (!this.mission || !this.mission.responderId || !this.mission.failurePosition) return
    const explorer = this.robots.get(this.mission.explorerId)
    const support = this.robots.get(this.mission.responderId)
    if (!explorer || !support) return this.fail('rover removed', timeS)
    if (this.mission.elapsedS > 180) return this.fail('rescue timeout', timeS)
    if (this.mission.phase === 'responder-enroute' && rescueDistance(support.position, this.mission.failurePosition) < 2.2) {
      this.transition('rendezvous')
      this.tetherEngaged = true
      this.startNavigation(support.id, this.mission.safeTarget, 1.4, 180)
      this.transition('recovering')
      this.event(timeS, `${support.id} reached rendezvous; force-based recovery tether engaged.`)
    }
    if (this.mission.phase === 'recovering') {
      const moved = rescueDistance(this.mission.failurePosition, explorer.position)
      this.mission.rescuedDistanceM = moved
      if (moved >= 3.5 && rescueDistance(explorer.position, this.mission.safeTarget) < rescueDistance(this.mission.failurePosition, this.mission.safeTarget)) {
        this.tetherEngaged = false
        this.task = this.task ? { ...this.task, status: 'completed' } : null
        this.send(support.id, 'MISSION_COMPLETE', timeS, { missionId: this.mission.id, displacedM: moved }, this.positionMap())
        this.transition('completed')
        this.event(timeS, `Rescue succeeded after ${moved.toFixed(1)} m of measured rover displacement.`)
      }
    }
    void dt
  }

  private receive(delivery: DeliveredRobotMessage, timeS: number): void {
    const { recipientId, message } = delivery
    this.messages.push({ timeS, senderId: message.senderId, recipientId, type: message.type, text: this.messageText(message) })
    if (this.messages.length > 64) this.messages.shift()
    if (message.type === 'ASSISTANCE_REQUEST' && this.mission?.phase === 'assistance-requested') {
      this.inbox.set(recipientId, [...(this.inbox.get(recipientId) ?? []), delivery])
      if (this.mission.responderId) return
      const candidates: RobotCandidate[] = this.capabilities.list().map((profile) => {
        const rover = this.robots.get(profile.roverId)!
        const inboxHasRequest = (this.inbox.get(profile.roverId) ?? []).some((entry) => entry.message.type === 'ASSISTANCE_REQUEST')
        return { roverId: profile.roverId, profile, position: rover.position, batteryPercent: rover.battery().percent,
          available: profile.roverId !== this.mission!.explorerId && inboxHasRequest, risk: 0 }
      })
      const capableRecipientsHeard = candidates.some((candidate) =>
        candidate.roverId !== this.mission!.explorerId &&
        (this.inbox.get(candidate.roverId) ?? []).some((entry) => entry.message.type === 'ASSISTANCE_REQUEST') &&
        this.capabilities.get(candidate.roverId)?.capabilities.some((capability) => capability.id === 'tow' && capability.available),
      )
      // A broadcast is delivered to recipients independently. Wait for the
      // support rover's own packet before judging the candidate pool.
      if (!capableRecipientsHeard) return
      const requestTask: CooperativeTask = {
        id: `${this.mission.id}-tow`, kind: 'rescue', requiredCapabilities: ['tow'], priority: 10,
        target: this.mission.failurePosition!, status: 'requested', assignedRobotId: null,
        estimatedEnergyJ: 400, createdAtS: timeS, failureReason: null,
      }
      const allocation = allocateTask(requestTask, candidates)
      if (!allocation) return this.fail('no capable, reachable, sufficiently charged responder', timeS)
      this.task = { ...requestTask, status: 'assigned', assignedRobotId: allocation.roverId }
      this.mission.responderId = allocation.roverId
      this.transition('responder-assigned')
      this.send(this.mission.explorerId, 'TASK_PROPOSAL', timeS, { taskId: requestTask.id, target: requestTask.target, responderId: allocation.roverId }, this.positionMap(), allocation.roverId)
      this.event(timeS, `Capability and resource scoring assigned tow task to ${allocation.roverId}.`)
    }
    if (message.type === 'TASK_PROPOSAL' && recipientId === message.payload?.responderId && this.mission?.phase === 'responder-assigned') {
      const responderId = recipientId
      const rover = this.robots.get(responderId)
      if (!rover || !this.task) return
      this.task = { ...this.task, status: 'accepted' }
      this.send(responderId, 'TASK_ACCEPTED', timeS, { taskId: this.task.id }, this.positionMap(), this.mission.explorerId)
    }
    if (message.type === 'TASK_ACCEPTED' && recipientId === this.mission?.explorerId && this.mission.phase === 'responder-assigned') {
      this.task = this.task ? { ...this.task, status: 'navigating' } : null
      this.startNavigation(this.mission.responderId!, this.mission.failurePosition!, 1.8, 120)
      this.transition('responder-enroute')
      this.event(timeS, `${this.mission.responderId} acknowledged over radio and is navigating to the failure location.`)
    }
  }

  private startNavigation(roverId: string, target: Vector3, tolerance: number, timeout: number): void {
    const rover = this.robots.get(roverId)
    if (!rover) return
    const current = this.robots.missions.missionForRover(roverId)
    if (current) {
      this.robots.missions.abort(current.id)
    }
    const mission = this.robots.missions.create(roverId, rover.position, target, tolerance, timeout)
    this.robots.missions.start(mission.id)
    this.robots.setController(roverId, new NavigationController())
  }

  private send(senderId: string, type: RobotMessageType, timeS: number, payload: Record<string, unknown>, positions: ReadonlyMap<string, Vector3>, recipientId?: string): void {
    const rover = this.robots.get(senderId)
    const profile = this.capabilities.get(senderId)
    if (!rover || !profile) return
    const message: RobotMessage = {
      messageId: `m${++this.messageSequence}`, senderId, ...(recipientId ? { recipientId } : {}), type,
      simulationTimeS: Math.max(0, timeS), position: rover.position, batteryPercent: rover.battery().percent,
      missionStatus: this.robots.missions.missionForRover(senderId)?.status ?? 'idle',
      capabilities: profile.capabilities.filter((capability) => capability.available).map((capability) => capability.id),
      ...(payload.taskId ? { taskId: String(payload.taskId) } : {}), payload,
    }
    this.network.send(message, positions)
  }

  private positionMap(): Map<string, Vector3> {
    return new Map(this.robots.ids().flatMap((id) => {
      const rover = this.robots.get(id)
      return rover ? [[id, rover.position] as const] : []
    }))
  }

  private transition(phase: RescuePhase): void {
    if (this.mission) this.mission = transitionRescue(this.mission, phase)
  }

  private fail(reason: string, timeS: number): void {
    if (!this.mission || ['completed', 'failed'].includes(this.mission.phase)) return
    this.mission.failure = reason
    this.tetherEngaged = false
    this.task = this.task ? { ...this.task, status: 'failed', failureReason: reason } : null
    this.transition('failed')
    this.event(timeS, `Rescue failed: ${reason}.`)
  }

  private event(timeS: number, text: string): void {
    this.events.push({ timeS, text })
    if (this.events.length > 32) this.events.shift()
  }

  private messageText(message: RobotMessage): string {
    if (message.type === 'ASSISTANCE_REQUEST') return `Assistance requested: ${String(message.payload?.reason ?? 'failure')}`
    if (message.type === 'TASK_PROPOSAL') return 'Tow task proposal received'
    if (message.type === 'TASK_ACCEPTED') return 'Tow task accepted'
    return message.type.toLowerCase().replaceAll('_', ' ')
  }
}
