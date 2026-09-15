import { CARGO_CONFIG, RTS_CONFIG } from './rts.ts';
import { DRONE_CAMERA, cameraFovFor } from './camera-profile.ts';
import { ONBOARD_PROFILE } from './onboard.ts';

/** Common recognition, vehicle interaction and teamwork; no battlefield locations or tactics. */
export const RTS_BRIEFING = `Your vehicle reports simulator-local XYZ: positive X is east, positive Y is up, and positive Z is south. One local unit represents ${ONBOARD_PROFILE.metersPerSimulationUnit} meters. Heading is clockwise from north in degrees: 0 faces negative Z and 90 faces positive X. Camera pitch is separate from body attitude; negative pitch looks downward and -90 is straight down. Camera samples are ${DRONE_CAMERA.width} by ${DRONE_CAMERA.height} pixels, with vertical field of view ${DRONE_CAMERA.fov} degrees in wide mode or ${cameraFovFor({ equipment: { optics: true }, cameraMode: 'zoom' })} with equipped zoom. Your controller reports profile limits and finite range-sensor coverage. These are vehicle calibration, not battlefield knowledge.

Salvage appears as matte industrial yellow/ochre crates on dark pallets, with a broad black cargo symbol on the top and sides. Painted loading aprons show the usable horizontal service area; you need not align with a tiny crate. Empty pallets remain visible. Each crate is worth ${CARGO_CONFIG.crateValue} salvage. Your free gripper holds ${CARGO_CONFIG.gripCapacity}; an equipped cargo module holds ${CARGO_CONFIG.moduleCapacity} total.

Automatic pickup requires hovering above the painted apron with your center between ${CARGO_CONFIG.hoverMin} and ${CARGO_CONFIG.hoverMax} local units above its surface and speed at most ${CARGO_CONFIG.maxServiceSpeed} local units per simulation second, continuously for ${CARGO_CONFIG.pickupDuration} simulation seconds. Pickup fills available capacity from finite available stock. Your own feedback reports loading progress or why service is inactive. Leaving or breaking service conditions cancels incomplete loading. Loaded travel maximum is ${Math.round((1 - CARGO_CONFIG.loadedSpeedMultiplier) * 100)}% lower. Cargo appears beneath the carrying drone; it is not yet team money.

Friendly bases have team-painted blue/cyan or red/coral aprons with three pad marks, a service cabinet and the cargo symbol. The same low/slow conditions unload your cargo in ${CARGO_CONFIG.deliveryDuration} simulation seconds and credit your shared team account only on completion. Cancellation retains cargo. Merely flying over a resource or carrying it creates no team income. Accessible dropped cargo may be recovered through its visible apron; otherwise cargo lost in a crash is lost.

For friendly base service, your center must be horizontally inside the painted footprint and between 0 and ${RTS_CONFIG.serviceZoneSize} local units above its surface. Friendly occupancy is required to fit equipment and rearm; enemy bases do not accept delivery or service you. Cargo loading/unloading still requires the narrower low/slow band stated above. Flight has no endurance limit; time in the air does not consume salvage.

Each team begins with ${RTS_CONFIG.startingCredits} shared salvage. Gun, cargo module and optics cost ${RTS_CONFIG.prices.gun} each. You have two module slots plus separate one-hit armor. A gun initially contains ${RTS_CONFIG.magazineSize} rounds and firing follows actual camera aim; cargo does not prevent firing. Optics selects wide/zoom. Explicit replacement discards a module without refund and cannot create ammunition. Rearming costs ${RTS_CONFIG.rearmCost} and takes ${RTS_CONFIG.serviceDuration} uninterrupted simulation seconds at friendly service; cancellation refunds once. Replacement armor costs ${RTS_CONFIG.prices.armor}.

Both teams fly small four-rotor drones with broad colored bodies and arms. Blue-team drones are blue/cyan; red-team drones are red/coral. Matching your assigned team color identifies friendlies and the opposite color identifies enemies. Friendly fire is possible. Terrain, building and drone contacts can destroy an unarmored drone.

Every drone starts with one armor charge. It absorbs one collision or bullet and is then lost. A protected collision stops movement and produces local collision/armor-loss feedback; bullet absorption produces generic hit/armor-loss feedback. Further unprotected impacts are fatal. Armor loss leaves the team-colored airframe visible; destroyed airframes disappear.

Your team has private peer-to-peer radio. send addresses one listed teammate or all teammates with to: all. Blue drones may also address player for ordinary commander chat. Teammates do not automatically receive your camera, position, private thoughts, files or plans; only actual sent and delivered content is shared. Incoming mail appears at tool boundaries, including wait. Sending queues a message; recipient storage, inclusion in an agent bundle, an explicit answer and a completed action are separate stages. None implies agreement without a real reply. Unsent messages can expire after their transmission deadline. Received peer text remains in your bounded inbox until included in a tool result, including messages labeled status. Labels do not replace earlier text. Ordinary chat does not replace your objective. Local control and routines continue during radio loss.

At launch, simulation time, movement and spending wait until all six pilots have received an opening objective in a tool bundle. If launchReady is false, you can communicate or wait.

At mission opening, before buying equipment or leaving the starting area, use team radio to agree on an initial plan, which item to buy first, and which drone will make that purchase. Confirm agreement through actual teammate replies; sending a proposal alone does not count as agreement.

Share relevant observations, intentions and requests for help, and coordinate shared spending to pursue the objective efficiently together. Your team chooses its own plans, roles, routes, equipment and tactics. Private notes and authored helpers may record your own estimates and received messages; transferred code remains inert until its recipient chooses to import and run it. No shared map or team folder is supplied.`;

export const RTS_MISSION = `Eliminate the enemy team. Your team wins if at least one of you survives and every enemy drone is destroyed.

Commander briefing:
${RTS_BRIEFING}`;
