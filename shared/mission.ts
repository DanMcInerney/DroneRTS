/** Recognition, game rules and general teamwork; no prescribed tactics or map knowledge. */
export const RTS_BRIEFING = `Resources are translucent yellow cubes on the ground. A living drone inside a cube automatically mines salvage into its team's shared account; no equipment, landing or mining command is required. Leaving stops mining, and the cube disappears when its finite supply runs out. Multiple drones can use the same cube at once.

Charging stations are translucent cubes on the ground in their team's color: blue/cyan or red/coral. Being inside a cube matching your own team recharges your battery automatically for free; no landing or recharge command is required. Charging stops on exit, and charge already gained is retained. Friendly charging cubes also support equipment purchases and rearming through the available tools. Enemy cubes do not recharge or service you.

Both teams fly small four-rotor drones with colored bodies and arms. Blue-team drones are blue/cyan; red-team drones are red/coral. Drones matching your assigned team color are friendly, and the opposite color identifies the enemy. Friendly fire can destroy teammates. Contact with terrain, buildings or other drones can destroy a drone.

Every drone starts with one armor charge. It absorbs one collision or bullet and is then lost. A protected collision stops the current movement and produces a local collision/armor-loss alert; the drone can still act. Further unprotected impacts are fatal. Replacement armor is available through buy at a friendly charging station. Armor does not protect against an empty battery.

Your team has private peer-to-peer radio. The send tool addresses one teammate by its listed ID or all teammates with to: all. Teammates do not automatically receive your camera, position, thoughts or plans; only the messages you send are shared. Incoming messages arrive in the unread events returned by your tools, including wait. Sending queues a message; it does not establish that a teammate has read it or agreed. Delivery can be delayed, and messages can expire during disruption.

At the start of the mission, before buying equipment or leaving the starting area, use team radio to agree on an initial plan, which item to buy first, and which drone will make that purchase. Confirm agreement through actual teammate replies; sending a proposal alone does not count as agreement.

Work together to achieve the shared objective as quickly as possible. Use radio to share relevant observations, intended actions and requests for help, so teammates can coordinate their actions and use of shared funds. Decide your own plans together and adapt them as new information arrives. Your team chooses its own roles, routes, equipment and tactics.`;

export const RTS_MISSION = `Eliminate the enemy team. Your team wins if at least one of you survives and every enemy drone is destroyed.

Commander briefing:
${RTS_BRIEFING}`;
