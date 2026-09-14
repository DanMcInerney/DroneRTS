import { isCargoRules } from '../shared/rts';
import './replay.css';
import './onboard.css';
import type { DroneId } from '../shared/types';
import type { ReplayPage } from '../shared/replay';
import { ReplayTimeline, type ReplayMoment } from './replay-model';
import { ReplayPlot, type ReplayExtent } from './replay-plot';
import { recordedOperations } from './equipment-presentation';
import { radioDeliveryPresentation } from './drone-radio';

const MAX_RECORDS = 60_000, MAX_BYTES = 64 * 1024 * 1024;
const clock = (time: number) => `${Math.floor(time / 60).toString().padStart(2, '0')}:${(time % 60).toFixed(1).padStart(4, '0')}`;

/** Owns replay fetching, transport controls and evidence display for the selected audit session. */
export class ReplayViewer {
  private model = new ReplayTimeline();
  private plot: ReplayPlot;
  private session = '';
  private active = false;
  private visible = false;
  private available = false;
  private generation = 0;
  private next = 0;
  private time = 0;
  private actor?: DroneId;
  private playing = false;
  private capped = false;
  private message = 'Select a session to inspect recorded flight paths and camera observations.';
  private controller?: AbortController;
  private imageController?: AbortController;
  private imageKey = '';
  private imageUrl = '';
  private timer?: ReturnType<typeof setTimeout>;
  private animation = 0;
  private lastPaint = 0;
  private previousFrame = 0;
  private eventKey = '';
  private observer: ResizeObserver;

  constructor(private host: HTMLElement) {
    host.innerHTML = `
      <section class="replay-section" id="admin-replay" aria-label="Recorded match replay">
        <div class="replay-heading"><div><div class="admin-kicker">MATCH REPLAY</div><h3>Find the turning point.</h3><p>Recorded paths, impacts and the camera evidence behind each decision.</p></div><span class="replay-badge" id="replay-badge">RECORDED EVIDENCE</span></div>
        <div class="replay-status" id="replay-status" role="status"></div>
        <div id="replay-workspace" hidden>
          <div class="replay-metrics" id="replay-metrics" aria-label="Match totals up to the selected time"></div>
          <div class="replay-layout">
            <div class="replay-map-panel"><div class="replay-map-top"><span>TACTICAL VIEW <small>· click a drone to inspect</small></span><select id="replay-extent" aria-label="Replay map extent"><option value="battlefield">Battlefield</option><option value="activity">Fit activity</option><option value="city">Entire city</option></select></div><canvas id="replay-canvas" aria-label="Recorded overhead flight paths, projectiles and impacts" role="img"></canvas><div class="replay-legend"><span><i class="replay-blue"></i> Blue</span><span><i class="replay-red"></i> Red</span><span><i class="replay-shot"></i> Sampled shots</span><span>⊗ Impact / loss</span><span>◆ Salvage</span></div></div>
            <aside class="replay-inspector" aria-label="Selected drone recorded evidence"><div class="replay-inspector-top"><label for="replay-actor">DRONE INSPECTOR</label><select id="replay-actor" aria-label="Replay drone"></select></div><div class="replay-camera-wrap"><img id="replay-camera" alt="Selected drone's actual recorded camera observation" hidden /><div id="replay-camera-empty">No camera observation acquired by this time.</div><span>RECORDED CAMERA</span></div><p id="replay-camera-time" class="replay-camera-time"></p><div id="replay-drone-state" class="replay-drone-state"></div></aside>
          </div>
          <div class="replay-transport"><div class="replay-controls"><button id="replay-previous" class="admin-button" type="button" aria-label="Previous recorded event">Ⅰ◀</button><button id="replay-play" class="admin-button replay-play" type="button" aria-label="Play replay">▶ Play</button><button id="replay-next" class="admin-button" type="button" aria-label="Next recorded event">▶Ⅰ</button><select id="replay-speed" aria-label="Replay speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option><option value="8">8×</option></select></div><label class="replay-scrubber"><span class="replay-time" id="replay-time">00:00.0 / 00:00.0</span><input type="range" id="replay-scrub" aria-label="Replay simulation time" min="0" max="1" step="0.01" value="0" /></label><button id="replay-latest" class="admin-text-button" type="button">Last frame ↗</button></div>
          <div class="replay-events-top"><span>DECISIONS, DELIVERY & EXECUTION</span><small>Click to seek · totals reflect the selected time</small></div><div class="replay-events" id="replay-events" aria-label="Replay commands, radio, scripts and combat events"></div>
          <details class="replay-sources"><summary>Historical routine source <span id="replay-source-count">0 versions</span></summary><p>Saved source is displayed as text. Archived code is never executed.</p><div id="replay-sources"></div></details>
          <p class="replay-note">Positions and shot trails use recorded samples. Gaps stay gaps; camera images are actual acquired observations, never reconstructed views.</p>
        </div>
      </section>`;
    this.plot = new ReplayPlot(this.el<HTMLCanvasElement>('replay-canvas'), id => { this.actor = id; this.el<HTMLSelectElement>('replay-actor').value = id; this.render(); });
    this.el('replay-play').addEventListener('click', () => {
      if (!this.playing && this.time >= this.model.finish) this.time = this.model.start;
      this.setPlaying(!this.playing);
    });
    this.el<HTMLInputElement>('replay-scrub').addEventListener('input', event => this.seek(Number((event.target as HTMLInputElement).value)));
    this.el('replay-latest').addEventListener('click', () => this.seek(this.model.finish));
    for (const [id, direction] of [['replay-previous', -1], ['replay-next', 1]] as const) this.el(id).addEventListener('click', () => {
      const next = this.model.adjacent(this.time, direction); if (next !== undefined) this.seek(next);
    });
    this.el<HTMLSelectElement>('replay-actor').addEventListener('change', event => { this.actor = (event.target as HTMLSelectElement).value as DroneId; this.render(); });
    this.el('replay-extent').addEventListener('change', () => this.render());
    this.observer = new ResizeObserver(() => { if (this.visible) this.render(); }); this.observer.observe(host);
    this.render();
  }

  private el<T extends HTMLElement = HTMLElement>(id: string) { return this.host.querySelector<T>(`#${id}`)!; }

  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) {
      this.generation++; this.controller?.abort(); this.controller = undefined; this.clearImage(); clearTimeout(this.timer); this.setPlaying(false);
    } else { this.render(); void this.load(); }
  }

  setSession(session: string, active = false) {
    this.active = active;
    if (session === this.session) return;
    this.generation++; this.controller?.abort(); this.controller = undefined; clearTimeout(this.timer); this.setPlaying(false); this.clearImage();
    this.session = session; this.model = new ReplayTimeline(); this.next = 0; this.time = 0; this.actor = undefined;
    this.available = false; this.capped = false; this.eventKey = ''; this.el('replay-events').replaceChildren();
    this.message = session ? 'Loading recorded evidence…' : 'Select a session to inspect recorded flight paths and camera observations.';
    this.render(); void this.load();
  }

  seek(time: number) {
    if (!this.available || !this.model.frames.length || !Number.isFinite(time)) return;
    this.setPlaying(false); this.time = Math.max(this.model.start, Math.min(this.model.finish, time)); this.render();
  }

  private async load() {
    if (!this.visible || !this.session || this.controller || this.capped || this.model.end) return;
    const controller = new AbortController(), generation = this.generation; this.controller = controller;
    try {
      let more = true;
      while (more && !this.capped) {
        const response = await fetch(`/api/diagnostics/sessions/${encodeURIComponent(this.session)}/replay?after=${this.next}`, { signal: controller.signal, cache: 'no-store' });
        if (!response.ok) throw new Error(`Replay request failed (${response.status}).`);
        const page = await response.json() as ReplayPage;
        if (generation !== this.generation || !this.visible) return;
        this.available = page.available;
        if (!page.available) { this.message = 'Replay is unavailable for this session. Older audit logs contain no recorded world frames or camera images.'; break; }
        if (this.model.count + page.records.length > MAX_RECORDS || page.next > MAX_BYTES) {
          this.capped = true; this.message = 'Replay viewer limit reached (60,000 records / 64 MB). The loaded interval remains available.'; break;
        }
        const wasEmpty = !this.model.frames.length;
        this.model.append(page.records);
        if (wasEmpty && this.model.frames.length) this.time = this.model.start;
        more = page.hasMore && page.next > this.next; this.next = page.next;
        this.message = more ? 'Loading the next recorded interval…' : this.model.frames.length ? '' : 'Recording is open. Waiting for the first world frame.';
        this.render();
      }
    } catch (error) {
      if (!controller.signal.aborted && generation === this.generation) this.message = error instanceof Error ? error.message : 'Could not load replay.';
    } finally {
      if (generation === this.generation) {
        this.controller = undefined; this.render();
        if (this.visible && this.active && !this.capped && !this.model.end) this.timer = setTimeout(() => void this.load(), 2000);
      }
    }
  }

  private setPlaying(value: boolean) {
    this.playing = value && this.visible && this.model.frames.length > 0;
    const button = this.el<HTMLButtonElement>('replay-play'); button.textContent = this.playing ? 'Ⅱ Pause' : '▶ Play'; button.setAttribute('aria-label', this.playing ? 'Pause replay' : 'Play replay');
    cancelAnimationFrame(this.animation); this.previousFrame = 0;
    if (this.playing) this.animation = requestAnimationFrame(at => this.animate(at));
  }

  private animate(at: number) {
    if (!this.visible || !this.playing) return;
    if (this.previousFrame) this.time = Math.min(this.model.finish, this.time + Math.min(0.25, (at - this.previousFrame) / 1000) * Number(this.el<HTMLSelectElement>('replay-speed').value));
    this.previousFrame = at;
    if (at - this.lastPaint > 80) { this.render(); this.lastPaint = at; }
    if (this.time >= this.model.finish) { this.render(); this.setPlaying(false); }
    else this.animation = requestAnimationFrame(next => this.animate(next));
  }

  private render() {
    const end = this.model.end;
    const endText = end ? `${end.reason === 'stopped' ? 'Recording complete.' : end.reason === 'limit' ? 'Recording limit reached.' : 'Recording stopped with an error.'}${end.message ? ` ${end.message}` : ''}${end.omittedImages ? ` ${end.omittedImages} camera images omitted.` : ''}` : '';
    this.el('replay-status').textContent = this.message || endText || `${this.model.count.toLocaleString()} records loaded${this.active ? ' · recording updates every 2 seconds' : ''}.`;
    this.el('replay-badge').textContent = `${this.capped || end?.reason === 'limit' ? 'BOUNDED RECORDING' : this.active && !end ? 'RECORDING SESSION' : 'RECORDED EVIDENCE'} · ${this.model.header?.rulesVersion ?? 'HISTORICAL RULES'}`;
    this.el('replay-workspace').hidden = !this.available || !this.model.frames.length;
    if (!this.available || !this.model.frames.length || !this.visible) return;
    const roster = this.model.header?.roster ?? [], select = this.el<HTMLSelectElement>('replay-actor');
    if (!this.actor || !roster.some(member => member.id === this.actor)) this.actor = roster[0]?.id;
    if (select.options.length !== roster.length || select.options[0]?.value !== roster[0]?.id) {
      select.replaceChildren(...roster.map(member => { const option = document.createElement('option'); option.value = member.id; option.textContent = member.label; return option; }));
    }
    select.value = this.actor ?? '';
    const sample = this.model.sample(this.time, this.actor), { metrics, frame, observation } = sample;
    const metric = (label: string, value: string, detail: string) => { const item = document.createElement('div'), title = document.createElement('span'), number = document.createElement('strong'), note = document.createElement('small'); title.textContent = label; number.textContent = value; note.textContent = detail; item.append(title, number, note); return item; };
    const cargoRules = isCargoRules(this.model.header?.rulesVersion ?? frame?.match?.rulesVersion);
    this.el('replay-metrics').replaceChildren(metric('SHOTS / DRONE HITS', `${metrics.shots} / ${metrics.hits}`, 'Recorded fire and contact events'), metric('DRONES LOST', String(metrics.deaths), `${metrics.terrain} terrain · ${metrics.ram} ram · ${metrics.bullet} bullet${metrics.power ? ` · ${metrics.power} power loss` : ''}${metrics.unknown ? ` · ${metrics.unknown} other` : ''}`), metric(cargoRules ? 'SALVAGE DELIVERED' : 'SALVAGE RECOVERED', metrics.salvage.toFixed(1), cargoRules ? `${frame?.drones.reduce((sum, drone) => sum + (drone.cargo?.amount ?? 0), 0) ?? 0} aboard · ${frame?.match?.salvageLost ?? 0} lost` : 'Both teams · recorded earned balance'));
    this.el('replay-time').textContent = `${clock(this.time)} / ${clock(this.model.finish)}`;
    const scrub = this.el<HTMLInputElement>('replay-scrub'); scrub.min = String(this.model.start); scrub.max = String(Math.max(this.model.start + 0.01, this.model.finish)); scrub.value = String(this.time); scrub.setAttribute('aria-valuetext', `${this.time.toFixed(2)} simulation seconds`);
    this.el<HTMLButtonElement>('replay-previous').disabled = this.model.adjacent(this.time, -1) === undefined;
    this.el<HTMLButtonElement>('replay-next').disabled = this.model.adjacent(this.time, 1) === undefined;
    this.plot.draw(this.model, sample, this.actor, this.el<HTMLSelectElement>('replay-extent').value as ReplayExtent);
    const drone = frame?.drones.find(item => item.id === this.actor), state = this.el('replay-drone-state');
    state.replaceChildren();
    if (drone) {
      const status = document.createElement('strong'); status.textContent = drone.alive === false ? 'DESTROYED' : drone.status || 'Active'; status.className = drone.alive === false ? 'replay-lost' : '';
      const pose = document.createElement('span'); pose.textContent = `XYZ ${drone.x.toFixed(3)}, ${drone.y.toFixed(3)}, ${drone.z.toFixed(3)} · heading ${(((360 - drone.yaw) % 360 + 360) % 360).toFixed(1)}°`;
      const itemLabels: Record<string, string> = { gun: 'Gun', cargo: 'Cargo module', miner: 'Drill', optics: 'Optics', armor: 'Armor', minerUpgrade: 'Drill upgrade', battery: 'Extra battery', jammer: 'Jammer' };
      const equipment = document.createElement('span'); equipment.textContent = `Attachments: ${Object.entries(drone.equipment ?? {}).filter(([, equipped]) => equipped).map(([item]) => itemLabels[item] ?? item).join(' · ') || 'none recorded'}`;
      state.append(status, pose, equipment);
      const operations = recordedOperations(drone, frame?.match, this.model.header?.rulesVersion);
      if (operations.length) { const line = document.createElement('span'); line.className = 'replay-operations'; line.textContent = operations.join(' · '); state.append(line); }
      const stamp = document.createElement('small'); stamp.textContent = `State sampled at ${frame!.simTime.toFixed(2)}s${drone.action ? ` · ${drone.action.kind}` : ''}`; state.append(stamp);
    } else state.textContent = 'This drone is absent from the selected frame.';
    this.el('replay-camera-time').textContent = observation ? `Acquired ${observation.simTime.toFixed(2)}s · ${(this.time - observation.simTime).toFixed(1)}s before cursor · ${new Date(observation.capturedAt).toLocaleTimeString()}` : 'Only observations acquired by the selected time appear here.';
    this.el('replay-camera-time').title = observation ? `Camera pose: XYZ ${observation.pose.x.toFixed(3)}, ${observation.pose.y.toFixed(3)}, ${observation.pose.z.toFixed(3)} · heading ${observation.pose.yaw.toFixed(1)}° · mission ${observation.mission}` : '';
    const image = observation?.imageAvailable && observation.imageId ? observation.imageId : '';
    void this.showImage(image, observation ? observation.omission || 'Image omitted from this observation.' : 'No camera observation acquired by this time.');
    this.renderEvents();
    this.renderSources(sample.sources);
  }

  private renderEvents() {
    const moments = this.model.moments, position = moments.findIndex(moment => moment.simTime > this.time), middle = position < 0 ? moments.length : position;
    const from = Math.max(0, middle - 30), rows = moments.slice(from, from + 80), key = `${moments.length}:${from}:${middle}`;
    if (key === this.eventKey) return; this.eventKey = key;
    const host = this.el('replay-events');
    if (!rows.length) { host.textContent = 'No commands or combat events in the loaded recording.'; return; }
    host.replaceChildren(...rows.map(moment => this.eventRow(moment)));
  }

  private eventRow(moment: ReplayMoment) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'replay-event'; button.dataset.simTime = String(moment.simTime);
    button.classList.toggle('replay-future', moment.simTime > this.time);
    const time = document.createElement('span'); time.textContent = clock(moment.simTime);
    const title = document.createElement('strong'), text = document.createElement('span');
    if (moment.type === 'event') { title.textContent = moment.event.type.replaceAll('_', ' '); text.textContent = moment.event.message; }
    else if (moment.type === 'command') { title.textContent = `${moment.drone} · ${moment.name}`; text.textContent = JSON.stringify(moment.args).slice(0, 180); }
    else if (moment.type === 'script-source') { title.textContent = `${moment.drone} · source v${moment.version}`; text.textContent = `${moment.path} · ${moment.sourceHash}${moment.omission ? ` · ${moment.omission}` : ''}`; }
    else if (moment.type === 'execution') { title.textContent = `${moment.drone} · SDK ${moment.operation}`; text.textContent = JSON.stringify({ args: moment.args, outcome: moment.outcome, error: moment.error }); }
    else if (moment.type === 'cancellation') { title.textContent = `${moment.drone} · cancelled`; text.textContent = `${moment.jobId} · ${moment.reason}`; }
    else { title.textContent = `${moment.message.from} → ${moment.message.to}`; text.textContent = `${moment.message.text} · ${radioDeliveryPresentation(moment.message)}`; }
    button.title = text.textContent;
    if (moment.type === 'event') button.dataset.eventType = moment.event.type;
    button.append(time, title, text); button.addEventListener('click', () => this.seek(moment.simTime)); return button;
  }

  private sourceKey = '';
  private renderSources(sources: import('../shared/replay').ReplayScriptSource[]) {
    const key = `${this.session}:${this.actor}:${sources.map(source => `${source.path}:${source.version}:${source.sourceHash}`).join('|')}`;
    if (key === this.sourceKey) return; this.sourceKey = key;
    this.el('replay-source-count').textContent = `${sources.length} recorded version${sources.length === 1 ? '' : 's'}`;
    this.el('replay-sources').replaceChildren(...sources.slice(-12).reverse().map(source => {
      const details = document.createElement('details'), summary = document.createElement('summary'), hash = document.createElement('p'), pre = document.createElement('pre');
      summary.textContent = `${source.path} · v${source.version} · ${source.sourceBytes} bytes · ${clock(source.simTime)}`;
      hash.textContent = `SHA256 ${source.sourceHash}`;
      pre.textContent = source.source ?? source.omission ?? 'Source was not archived.';
      details.append(summary, hash, pre); return details;
    }));
    if (sources.length > 12) { const note = document.createElement('p'); note.textContent = 'Showing the latest 12 recorded sources at the cursor. Seek earlier to inspect prior versions.'; this.el('replay-sources').append(note); }
  }

  private clearImage() {
    this.imageController?.abort(); this.imageController = undefined; this.imageKey = '';
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl); this.imageUrl = '';
    const image = this.el<HTMLImageElement>('replay-camera'); image.removeAttribute('src'); image.hidden = true;
  }

  private async showImage(imageId: string, missing: string) {
    const key = `${this.session}:${imageId || missing}`; if (key === this.imageKey) return;
    this.clearImage(); this.imageKey = key;
    const empty = this.el('replay-camera-empty'); empty.hidden = false; empty.textContent = imageId ? 'Loading recorded camera…' : missing;
    if (!imageId || !this.visible) return;
    const controller = new AbortController(); this.imageController = controller;
    try {
      const response = await fetch(`/api/diagnostics/sessions/${encodeURIComponent(this.session)}/replay/images/${encodeURIComponent(imageId)}`, { signal: controller.signal });
      if (!response.ok) throw new Error('Recorded image is unavailable on disk.');
      const blob = await response.blob(); if (controller.signal.aborted || this.imageKey !== key || !this.visible) return;
      this.imageUrl = URL.createObjectURL(blob); const image = this.el<HTMLImageElement>('replay-camera'); image.src = this.imageUrl; image.hidden = false; empty.hidden = true;
    } catch (error) { if (!controller.signal.aborted && this.imageKey === key) empty.textContent = error instanceof Error ? error.message : 'Recorded image could not be loaded.'; }
  }
}
