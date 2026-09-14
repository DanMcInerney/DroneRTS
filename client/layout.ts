import { RTS_CONFIG } from '../shared/rts';

/** Player interface only. None of these labels are part of drone camera captures. */
export const defaultMission = 'Eliminate the enemy team. Find resources, coordinate with your teammates, and decide together how to equip your drones. Share what you discover.';

export const layout = `
  <header class="topbar">
    <a class="brand" href="/" aria-label="Fleet home"><span class="brand-symbol" aria-hidden="true">F</span>FLEET<span class="brand-label">CINCINNATI / SWARM RTS</span></a>
    <div class="header-links"><a class="admin-link" href="#admin">Admin <span aria-hidden="true">↗</span></a><div class="connection"><span class="status-dot" id="connection-dot"></span><span id="connection-text">Connecting to simulator</span></div></div>
  </header>
  <main>
    <section class="mission-header">
      <div><div class="eyebrow">CINCINNATI, OHIO <span>/</span> 3 V 3 AUTONOMOUS COMBAT</div><h1>One city. Two swarms.</h1><p id="fleet-intro">Scout the riverfront. Mine salvage. Be the last team flying.</p></div>
      <div class="session-controls"><button id="reset" class="button button-subtle" title="Reset the match after stopping">Reset match</button><button id="stop" class="button button-stop" disabled><span class="stop-icon" aria-hidden="true"></span>Stop match</button><button id="start" class="button button-primary" disabled><span class="play-icon" aria-hidden="true"></span>Launch match</button></div>
    </section>
    <section class="session-strip" aria-label="Session status">
      <div class="session-state"><span class="status-dot" id="runtime-dot"></span><strong id="runtime-status">STANDBY</strong><span id="runtime-message">Connect to the local server to begin.</span></div>
      <div class="session-metadata"><span class="model-chip">LUNA <span>/ XHIGH</span></span><span class="session-clock" id="clock">00:00.0</span><span class="version-label" id="mission-version">MISSION —</span></div>
    </section>
    <div id="alert" class="alert" role="alert" hidden><span id="alert-text"></span><button id="dismiss-alert" aria-label="Dismiss notice">×</button></div>
    <section class="match-scoreboard" aria-label="Team scores" id="match-scoreboard">
      <article class="team-score team-blue"><div class="team-identity"><span class="team-insignia">◆</span><div><span class="eyebrow">YOUR TEAM</span><h2>Blue swarm</h2></div></div><div class="team-metrics"><div><strong id="blue-alive">3<span> / 3</span></strong><span>DRONES ALIVE</span></div><div><strong id="blue-credits">0</strong><span>SHARED CREDITS</span></div></div><div class="team-roster" id="blue-roster"></div></article>
      <div class="match-divider"><span id="match-phase">READY</span><strong>VS</strong><span>LAST TEAM<br>STANDING</span></div>
      <article class="team-score team-red"><div class="team-identity"><span class="team-insignia">◆</span><div><span class="eyebrow">ENEMY TEAM</span><h2>Red swarm</h2></div></div><div class="team-metrics"><div><strong id="red-alive">3<span> / 3</span></strong><span>DRONES ALIVE</span></div><div><strong id="red-credits">0</strong><span>SHARED CREDITS</span></div></div><div class="team-roster" id="red-roster"></div></article>
    </section>
    <div class="world-views" id="world-views">
      <section class="overview-panel panel" aria-label="Live overhead map">
        <header class="panel-header"><div><span class="eyebrow">SPECTATOR TACTICAL MAP</span><h2>The Cincinnati front <span class="map-live"><i></i> LIVE</span></h2></div><div class="map-actions"><button class="button button-stop" id="map-entire" aria-pressed="false">Cincinnati</button><button class="button button-stop" id="map-downtown" aria-pressed="true">Battlefield</button></div></header>
        <div class="overview-body"><div class="overview-map" id="overview-map" role="button" tabindex="0" aria-label="Enter god view at this map location"><span class="map-north" aria-hidden="true">↑<br>N</span><div class="map-legend"><span class="legend-blue">● Blue</span><span class="legend-red">● Red</span><span class="legend-resource">◆ Salvage</span></div><span class="map-enter-hint">Click anywhere for God view <span>↗</span></span><div class="match-result" id="match-result" hidden role="status"><span class="eyebrow">MATCH COMPLETE</span><h2 id="result-title"></h2><p id="result-description"></p><button class="button button-primary" id="play-again">New match <span>↗</span></button></div></div>
          <aside class="map-sidebar"><div><span class="eyebrow">FINITE RESOURCES · SHARED INCOME</span><h3>Control the salvage.</h3><p>Every deposit is an opportunity—and a place the other team may be heading.</p></div><div class="resource-list" id="resource-list"></div><div class="map-fleet-list" id="map-fleet-list"></div><div class="map-explore-help"><strong>Go inside the city.</strong><p>Explore with <kbd>WASD</kbd>, mouse look, and <kbd>Shift</kbd> for speed.</p><span><kbd>Q / E</kbd> Down / up &nbsp; <kbd>Esc</kbd> Exit</span></div></aside></div>
        <footer class="map-footer"><span>North up · scroll to zoom · arrows show heading · dashed destinations</span><span>Spectator intelligence · agents see only their cameras</span></footer>
      </section>
      <section class="fleet-feeds" id="fleet-feeds" aria-label="Drone camera views"></section>
    </div>
    <section class="mechanics-strip" aria-label="How to play">
      <div class="mechanics-intro"><span class="eyebrow">THE RULES OF ENGAGEMENT</span><h2>Learn. Equip. Survive.</h2><p>The drones learn the world through their own cameras and share discoveries over team radio.</p></div>
      <div class="item-rule"><span class="item-icon" aria-hidden="true">↗</span><strong>Gun <b>${RTS_CONFIG.prices.gun} CR</b></strong><p>Aim the camera, fire a physical bullet. Travel time, gravity, cover and friendly fire matter.</p></div>
      <div class="item-rule"><span class="item-icon" aria-hidden="true">⬡</span><strong>Armor <b>${RTS_CONFIG.prices.armor} CR</b></strong><p>Survive one bullet, a crash, or a ram. Armor breaks on impact. Unarmored contact is fatal.</p></div>
      <div class="item-rule"><span class="item-icon" aria-hidden="true">◆</span><strong>Mining tool <b>${RTS_CONFIG.prices.miner} CR</b></strong><p>Gather salvage ${RTS_CONFIG.minerRate / RTS_CONFIG.miningRate}× faster. Income goes directly into the shared team wallet.</p></div>
    </section>
    <section class="workspace-panels">
      <article class="radio-panel panel">
        <header class="panel-header"><div><span class="eyebrow">TWO INDEPENDENT TEAM RADIOS</span><h2>On the radio<span class="count-badge" id="radio-count">0</span></h2></div><label class="follow-toggle"><input id="follow-radio" type="checkbox" checked /> Follow live</label></header>
        <div id="radio-log" class="radio-log" role="log" aria-label="Messages sent between drones" aria-live="polite" aria-relevant="additions"></div>
        <footer class="radio-footer"><span><i></i> Zenoh peer messages</span><span>Team goals · independent decisions</span></footer>
      </article>
      <article class="command-panel panel">
        <header class="panel-header"><div><span class="eyebrow">YOUR BLUE SWARM</span><h2>Mission control</h2></div><span class="command-number">↗</span></header>
        <form id="mission-form"><label class="input-label" for="instruction">Give your team a new objective</label><textarea id="instruction" name="instruction" maxlength="4000" rows="4" placeholder="${defaultMission}">${defaultMission}</textarea><div class="input-hint"><span>Relayed unchanged to the blue team.</span><span>Ctrl ↵</span></div><button id="send" class="button button-send" type="submit" disabled>Send to blue swarm <span aria-hidden="true">↗</span></button><p class="mission-feedback" id="mission-feedback" aria-live="polite">Launch starts both teams with the same elimination objective.</p></form>
        <div class="speed-control"><div><label for="speed">Simulation speed</label><output id="speed-value" for="speed">1×</output></div><input id="speed" type="range" min="0.25" max="2" step="0.25" value="1" /><div class="speed-caption"><span>Give them time to think</span><span>Move faster</span></div></div>
      </article>
      <article class="combat-panel panel"><header class="panel-header"><div><span class="eyebrow">PLAYER INTELLIGENCE</span><h2>Combat & economy</h2></div><span class="count-badge" id="combat-count">0</span></header><div class="combat-log" id="combat-log" role="log" aria-label="Match events"><p class="combat-empty">First contact is still ahead. Mining, equipment purchases and combat events appear here.</p></div></article>
    </section>
    <details class="network-lab panel"><summary class="network-heading"><div><span class="eyebrow">NETWORK LAB</span><h2>Inspect the peer mesh</h2><p>Native Zenoh peers and MAVLink packets. Isolate a drone to interrupt its team radio.</p></div><span id="network-status">Launch the match to connect.</span></summary><div class="network-peers" id="network-peers"></div><p class="network-note">An isolated drone keeps sensing and following its last received mission. Radio traffic queues until reconnection or expiry. These loopback connections simulate partitions, not RF propagation.</p></details>
    <footer class="page-footer"><span><span class="footer-mark">F</span> Cincinnati, simplified. <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Map data © OpenStreetMap contributors</a><a href="https://services.arcgis.com/JyZag7oO4NteHGiq/ArcGIS/rest/services/Open_Data_Feature_Collection/FeatureServer" target="_blank" rel="noreferrer">River & city bounds: CAGIS</a></span><span id="session-id">Two swarms. Six independent pilots.</span></footer>
  </main>`;
