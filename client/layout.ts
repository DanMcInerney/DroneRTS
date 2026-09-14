import { CARGO_CONFIG, RTS_CONFIG } from '../shared/rts';
import { RTS_MISSION } from '../shared/mission';

/** Player interface only. None of these labels are part of drone camera captures. */
export const defaultMission = RTS_MISSION;

export const layout = `
  <header class="topbar dashboard-header">
    <a class="brand" href="/" aria-label="Fleet home"><span class="brand-symbol" aria-hidden="true">F</span>FLEET</a>
    <h1 class="header-title">One city. Two swarms.</h1>
    <section class="header-scores" aria-label="Team scores" id="match-scoreboard">
      <div class="header-team team-blue"><strong>BLUE</strong><span id="blue-alive" aria-label="Blue drones alive">3 / 3</span><span class="header-credits"><b id="blue-credits">0</b> CR</span></div>
      <span class="header-versus" aria-hidden="true">vs</span>
      <div class="header-team team-red"><strong>RED</strong><span id="red-alive" aria-label="Red drones alive">3 / 3</span><span class="header-credits"><b id="red-credits">0</b> CR</span></div>
    </section>
    <div class="header-status" aria-label="Session status"><span class="status-dot" id="runtime-dot"></span><span id="match-phase">READY</span><time id="clock">00:00.0</time></div>
    <div class="session-controls"><button id="reset" class="button button-subtle" title="Reset the match after stopping">Reset match</button><button id="stop" class="button button-stop" disabled><span class="stop-icon" aria-hidden="true"></span>Stop match</button><button id="start" class="button button-primary" disabled><span class="play-icon" aria-hidden="true"></span>Launch match</button></div>
    <a class="admin-link" href="#admin">Admin <span aria-hidden="true">↗</span></a>
    <span class="connection header-connection"><span class="status-dot" id="connection-dot"></span><span class="visually-hidden" id="connection-text">Connecting to simulator</span></span>
  </header>
  <main>
    <div id="alert" class="alert" role="alert" hidden><span id="alert-text"></span><button id="dismiss-alert" aria-label="Dismiss notice">×</button></div>
    <div class="world-views" id="world-views">
      <section class="fleet-feeds" id="fleet-feeds" aria-label="Drone camera views"></section>
    <section class="workspace-panels">
      <article class="command-panel panel">
        <header class="panel-header"><div><span class="eyebrow">YOUR BLUE SWARM</span><h2>Team chat</h2></div><span class="command-number">↗</span></header>
        <section id="player-chat" class="player-chat" aria-label="Blue team chat"></section>
        <form id="mission-form"><label class="input-label" for="instruction">Message your teammates</label><textarea id="instruction" name="instruction" maxlength="4000" rows="3" placeholder="Send a message to the blue drones…"></textarea><div class="input-hint"><span>Chat leaves their current objective and jobs active.</span><span>Ctrl ↵</span></div><button id="send" class="button button-send" type="submit" disabled>Send to blue team <span aria-hidden="true">↗</span></button><button id="replace-objective" class="button button-subtle objective-action" type="button" disabled title="Replace the blue objective with this text. Each drone cancels old work when the new objective arrives.">Use text as new objective</button><p class="mission-feedback" id="mission-feedback" aria-live="polite">Launch gives both teams the same objective and recognition briefing.</p></form>
        <p class="runtime-detail"><strong id="runtime-status">STANDBY</strong><span id="runtime-message">Connect to the local server to begin.</span><span id="mission-version">MISSION —</span></p><div class="speed-control"><div><label for="speed">Simulation speed</label><output id="speed-value" for="speed">1×</output></div><input id="speed" type="range" min="0.25" max="2" step="0.25" value="1" /><div class="speed-caption"><span>Give them time to think</span><span>Move faster</span></div></div>
      </article>
      <article class="combat-panel panel"><header class="panel-header"><div><span class="eyebrow">PLAYER INTELLIGENCE</span><h2>Combat & economy</h2></div><span class="count-badge" id="combat-count">0</span></header><div class="combat-log" id="combat-log" role="log" aria-label="Match events"><p class="combat-empty">First contact is still ahead. Mining, equipment purchases and combat events appear here.</p></div></article>
    </section>
    <details class="rules-panel panel"><summary>Rules & equipment <span>Two modules · Armor · Service pads</span></summary>
    <section class="mechanics-strip" aria-label="How to play">
      <div class="mechanics-intro"><span class="eyebrow">THE RULES OF ENGAGEMENT</span><h2>Discover. Haul. Survive.</h2><p>Each team starts with ${RTS_CONFIG.startingCredits} shared salvage. Find yellow crates on marked loading aprons, then carry salvage to a friendly base to bank it. Low, slow hovering loads in ${CARGO_CONFIG.pickupDuration}s and delivers in ${CARGO_CONFIG.deliveryDuration}s. Each drone fits two modules plus armor.</p></div>
      <div class="item-rule"><span class="item-icon" aria-hidden="true">↗</span><strong>Gun <b>${RTS_CONFIG.prices.gun} CR</b></strong><p>${RTS_CONFIG.magazineSize} rounds per magazine. Camera aim, gravity, cover and friendly fire matter. Rearm at a friendly base for ${RTS_CONFIG.rearmCost} salvage and ${RTS_CONFIG.serviceDuration} seconds.</p></div>
      <div class="item-rule"><span class="item-icon" aria-hidden="true">⬡</span><strong>Armor <b>${RTS_CONFIG.prices.armor} CR</b></strong><p>Every drone starts with one free armor charge. It absorbs one bullet or collision, then breaks and alerts the drone. Replacement armor costs ${RTS_CONFIG.prices.armor} salvage.</p></div>
      <div class="item-rule"><span class="item-icon" aria-hidden="true">◆</span><strong>Cargo module <b>${RTS_CONFIG.prices.cargo} CR</b></strong><p>The free grip holds ${CARGO_CONFIG.gripCapacity} salvage; a module doubles it to ${CARGO_CONFIG.moduleCapacity}. Loaded travel is ${Math.round((1 - CARGO_CONFIG.loadedSpeedMultiplier) * 100)}% slower. Stock becomes team income only after completed delivery. Empty pallets remain visible.</p></div>
      <div class="item-rule"><span class="item-icon" aria-hidden="true">◎</span><strong>Optics <b>${RTS_CONFIG.prices.optics} CR</b></strong><p>Switch between wide and magnified camera views. A closer look comes with a narrower view. Discoveries still travel over team radio.</p></div>
    </section>
    </details>
    <details class="network-lab panel"><summary class="network-heading"><div><span class="eyebrow">NETWORK LAB</span><h2>Inspect the peer mesh</h2><p>Native Zenoh peers and MAVLink packets. Isolate a drone to interrupt its team radio.</p></div><span id="network-status">Launch the match to connect.</span></summary><div class="network-peers" id="network-peers"></div><p class="network-note">An isolated drone keeps sensing and following its last received mission. Radio traffic queues until reconnection or expiry. These loopback connections simulate partitions, not RF propagation.</p></details>
      <section class="overview-panel panel" aria-label="Live overhead map">
        <header class="panel-header"><div><span class="eyebrow">SPECTATOR TACTICAL MAP</span><h2>The Cincinnati front <span class="map-live"><i></i> LIVE</span></h2></div><div class="map-actions"><button class="button button-stop" id="map-entire" aria-pressed="false">Cincinnati</button><button class="button button-stop" id="map-downtown" aria-pressed="true">Battlefield</button></div></header>
        <div class="overview-body"><div class="overview-map" id="overview-map" role="button" tabindex="0" aria-label="Enter god view at this map location"><span class="map-north" aria-hidden="true">↑<br>N</span><div class="map-legend"><span class="legend-blue">● Blue</span><span class="legend-red">● Red</span><span class="legend-resource">◆ Salvage</span></div><span class="map-enter-hint">Click anywhere for God view <span>↗</span></span><div class="match-result" id="match-result" hidden role="status"><span class="eyebrow">MATCH COMPLETE</span><h2 id="result-title"></h2><p id="result-description"></p><button class="button button-primary" id="play-again">New match <span>↗</span></button></div></div>
          <aside class="map-sidebar"><div><span class="eyebrow">FINITE RESOURCES · SHARED INCOME</span><h3>Bring the salvage home.</h3><p>Yellow crates sit on marked loading aprons. Low, slow hovering picks up cargo and delivers at a friendly base. Friendly bases also fit equipment and rearm guns. Flight has no endurance limit.</p></div><div class="haul-totals" id="haul-totals"></div><div class="resource-list" id="resource-list"></div><div class="map-fleet-list" id="map-fleet-list"></div><div class="map-explore-help"><strong>Go inside the city.</strong><p>Explore with <kbd>WASD</kbd>, mouse look, and <kbd>Shift</kbd> for speed.</p><span><kbd>Q / E</kbd> Down / up &nbsp; <kbd>Esc</kbd> Exit</span></div></aside></div>
        <footer class="map-footer"><span>North up · scroll to zoom · arrows show heading · dashed destinations</span><span>Spectator intelligence · drones use own sensors and actual radio</span></footer>
      </section>
    </div>
    <footer class="page-footer"><span><span class="footer-mark">F</span> Cincinnati, simplified. <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">Map data © OpenStreetMap contributors</a><a href="https://services.arcgis.com/JyZag7oO4NteHGiq/ArcGIS/rest/services/Open_Data_Feature_Collection/FeatureServer" target="_blank" rel="noreferrer">River & city bounds: CAGIS</a></span><span id="session-id">Two swarms. Six independent pilots.</span></footer>
  </main>`;
