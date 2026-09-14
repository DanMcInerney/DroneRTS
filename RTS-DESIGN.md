# Cincinnati RTS design

The PoC uses two independent teams of three persistent drones. Losing a drone permanently reduces a team's labor, reconnaissance and fighting capacity. The objective is elimination, with no respawn or hidden time-based winner.

## Fixed salvage creates places worth fighting over

Five finite deposits make exploration and territorial control useful. Each team starts near a small 80-credit deposit; three richer deposits sit between the teams in downtown Cincinnati. Starting cameras face the nearby salvage, but agents receive neither its location nor a tutorial telling them what they see. Each must recognize it and try interacting.

Income enters the team's shared bank immediately. Hauling and bases would consume most of a three-unit team's attention before combat becomes possible, so this first version keeps the decision centered on who gathers, who scouts and who carries equipment. Mining continues while an agent thinks or talks; moving away or exhausting the deposit stops it. Several drones can mine the same deposit, and opposing teams split its remaining salvage in proportion to their gathering rates.

The opening 80 credits cannot fully equip three drones: three complete 48-credit loadouts cost 144. A team can buy guns and protection early, invest in a faster miner, concentrate equipment on one unit or save for replacements. Richer downtown salvage supplies a reason to leave the opening position. Deposits do not regenerate.

## Three attachments, several roles

| Attachment | Decision it creates |
| --- | --- |
| Gun, 20 | Enables ranged attacks, but requires visual acquisition, camera aim and physical hits. Ammunition is unlimited; a cooldown limits firing. |
| Armor, 12 | A consumable survival margin against one projectile or collision. It also enables one deliberate ram against an unprotected drone. |
| Miner, 16 | Triples gathering speed, paying back through earlier access to equipment. The carrier still risks losing its investment if caught. |

A drone can carry one of each attachment and purchases only for itself. The shared bank makes radio coordination consequential: a teammate can spend funds another drone was saving. The server processes purchases atomically and never permits overspending. Equipment survives mission updates but disappears at match reset or death.

## Combat rewards observation

The gun points with the drone's camera. Bullets travel through the world with gravity and collide against buildings, terrain and moving drones; there is no target-selection API, aim assistance or hit confirmation sent to the shooter. Friendly fire and contact collisions make spacing matter. Swept collision checks prevent fast bullets and crossing flight paths from passing through thin obstacles or each other between frames.

Armor consumes one charge on an impact. An armored drone survives a ram while an unarmored participant dies; if both are armored, both lose protection and separate. Protected terrain impacts bounce away from the obstacle. Unprotected terrain or drone contact is fatal. Simultaneous elimination of both teams is a draw.

## A city, with a focused opening

The renderer retains sourced downtown streets and buildings, extends the map to Cincinnati's municipal outline and shows the winding Ohio River. The combat opening uses the detailed downtown area; the outer municipality is schematic terrain rather than an invented detailed reconstruction. A continuous ground plane and city overview replace the earlier raised square display slab. Roads and blocks supply cover and sightlines, while open air permits flanking and scouting.

The player can inspect both teams through six FPV feeds, the battlefield and city views, team banks, loadouts, resource counts, combat events and Admin. These are spectator interfaces. Agent cameras never contain the overlays or the God-view camera.

## Preserve the learning experiment

Each match starts with six clean-context native drone agents and two mechanical parents. Initial instructions identify the team and objective, mention resources and lethal collisions, and explain the available interaction protocol. They do not supply movement scale, axis direction, map geometry, resource coordinates, camera calibration, combat constants, enemy telemetry or prescribed tactics.

The drone receives its own image, local XYZ, heading and timestamp, plus delivered teammate/player mail. It learns by acting and observing, then may share measurements. `buy` becomes available only after that team first earns salvage; `fire` becomes available only after that drone buys a gun. All actors use gpt-5.6-luna with xhigh reasoning. Both team radios use real isolated Zenoh peer networks, and vehicle control uses MAVLink 2.

The implementation supports the complete economy and combat loop. Autonomous competence remains an observed outcome, not a scripted behavior: a newborn agent may wander, spend poorly or crash. [RTS-PLAYTEST.md](RTS-PLAYTEST.md) distinguishes rule verification from the actual live trials.
