import RAPIER from '@dimforge/rapier3d-compat'

import type { PhysicsConfig, Vector3 } from '../types/SimulationTypes'

export class RigidBodyFactory {
  public static createGround(world: RAPIER.World, config: PhysicsConfig): RAPIER.RigidBody {
    const groundBody = world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, config.groundHeight - 0.1, 0),
    )

    // Cuboid half-extent 0.1 in Y puts the collider top surface exactly at groundHeight.
    const groundCollider = RAPIER.ColliderDesc.cuboid(30, 0.1, 30)
      .setRestitution(config.groundRestitution)
      .setFriction(config.groundFriction)

    world.createCollider(groundCollider, groundBody)

    return groundBody
  }

  public static createSphere(world: RAPIER.World, config: PhysicsConfig): RAPIER.RigidBody {
    const body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(
          config.sphereInitialPosition.x,
          config.sphereInitialPosition.y,
          config.sphereInitialPosition.z,
        )
        // Zero linear damping: no air resistance, so free fall matches y(t) = y0 - 0.5*g*t^2.
        .setLinearDamping(0)
        .setAngularDamping(0.2)
        .setCanSleep(true),
    )

    // Mass is derived by Rapier from density and collider volume:
    // m = density * (4/3)*PI*r^3.
    const sphereCollider = RAPIER.ColliderDesc.ball(config.sphereRadius)
      .setDensity(config.sphereDensity)
      .setRestitution(config.sphereRestitution)
      .setFriction(config.sphereFriction)

    world.createCollider(sphereCollider, body)

    return body
  }

  public static resetBodyTranslation(body: RAPIER.RigidBody, position: Vector3): void {
    body.setTranslation({ x: position.x, y: position.y, z: position.z }, true)
    body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    body.setAngvel({ x: 0, y: 0, z: 0 }, true)
  }
}
