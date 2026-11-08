export type RobotRole = 'explorer' | 'carrier' | 'support'
export type CapabilityId = 'navigate' | 'observe_terrain' | 'detect_obstacles' | 'transport_payload' | 'assist_recovery' | 'tow'

export interface RobotCapability {
  id: CapabilityId
  available: boolean
  resourceCost: number
  requirements: readonly string[]
  physicalPrerequisites: readonly string[]
}

export interface RobotProfile {
  roverId: string
  role: RobotRole
  capabilities: readonly RobotCapability[]
}

export const ROLE_CAPABILITIES: Readonly<Record<RobotRole, readonly CapabilityId[]>> = Object.freeze({
  explorer: ['navigate', 'observe_terrain', 'detect_obstacles'],
  carrier: ['navigate', 'transport_payload'],
  support: ['navigate', 'assist_recovery', 'tow'],
})

export class RobotCapabilityRegistry {
  private readonly profiles = new Map<string, RobotProfile>()

  public register(roverId: string, role: RobotRole, capabilities: readonly CapabilityId[] = ROLE_CAPABILITIES[role]): RobotProfile {
    const unique = [...new Set(capabilities)]
    const profile: RobotProfile = {
      roverId,
      role,
      capabilities: unique.map((id) => ({
        id,
        available: true,
        resourceCost: id === 'tow' ? 500 : id === 'transport_payload' ? 200 : 50,
        requirements: id === 'tow' ? ['active tow tether'] : [],
        physicalPrerequisites: id === 'tow' ? ['force-based recovery tether'] : [],
      })),
    }
    this.profiles.set(roverId, profile)
    return cloneProfile(profile)
  }

  public get(roverId: string): RobotProfile | null {
    const profile = this.profiles.get(roverId)
    return profile ? cloneProfile(profile) : null
  }

  public list(): RobotProfile[] {
    return [...this.profiles.values()].map(cloneProfile)
  }

  public setAvailable(roverId: string, capabilityId: CapabilityId, available: boolean): boolean {
    const profile = this.profiles.get(roverId)
    if (!profile) return false
    const capabilities = profile.capabilities.map((capability) =>
      capability.id === capabilityId ? { ...capability, available } : capability,
    )
    if (!capabilities.some((capability) => capability.id === capabilityId)) return false
    this.profiles.set(roverId, { ...profile, capabilities })
    return true
  }

  public remove(roverId: string): void {
    this.profiles.delete(roverId)
  }
}

export function hasCapabilities(profile: RobotProfile | null, required: readonly CapabilityId[]): boolean {
  if (!profile) return false
  const available = new Set(profile.capabilities.filter((item) => item.available).map((item) => item.id))
  return required.every((id) => available.has(id))
}

function cloneProfile(profile: RobotProfile): RobotProfile {
  return {
    ...profile,
    capabilities: profile.capabilities.map((capability) => ({
      ...capability,
      requirements: [...capability.requirements],
      physicalPrerequisites: [...capability.physicalPrerequisites],
    })),
  }
}

