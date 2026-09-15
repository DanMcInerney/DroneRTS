import './cockpit.css';
import type { CockpitEvent, CockpitSnapshot } from '../shared/cockpit';
import { dronePresentation } from './drone-presentation';
import { COCKPIT_EVENT_LIMIT, json, mergeCockpitEvents, outputRows, timestamp } from './cockpit-model';
import { mountCockpitCards } from './cockpit-cards';

/** Read-only observer route. The mounted flight deck still supplies camera captures. */
export function mountCockpit(initialIds: readonly string[]) {
  const page = document.createElement('section'); page.className = 'cockpit-page'; page.hidden = true; page.setAttribute('aria-label', 'Drone cockpit');
  page.innerHTML = `
    <header class="cockpit-topbar"><a href="#" class="cockpit-back">← <span>Flight deck</span></a><a href="#" class="cockpit-wordmark">FLEET <span>/</span> COCKPIT</a><a href="#admin" class="cockpit-audit-link">Full audit log ↗</a></header>
    <div class="cockpit-content">
      <div class="cockpit-page-heading"><div><div class="cockpit-kicker">INSIDE THE AGENT</div><h1><span class="cockpit-identity">Drone</span><span class="cockpit-title-divider">/</span>Flight recorder</h1><p>Every delivered observation. Every recorded interaction.</p></div><label class="cockpit-select-label">INSPECT DRONE<select class="cockpit-selector" aria-label="Inspect drone"></select></label></div>
      <div class="cockpit-status-strip"><span class="cockpit-recording"><i></i><strong class="cockpit-status-text">CONNECTING</strong></span><span class="cockpit-session">SESSION —</span><span class="cockpit-delivery">NO DELIVERIES</span><span class="cockpit-updated">Awaiting recorder</span></div>
      <div class="cockpit-error" role="alert" hidden></div>
      <div class="cockpit-grid" aria-label="Agent observation and action cards"></div>
      <section class="cockpit-output" aria-label="Live agent output"><header><div><span class="cockpit-mini-label">08 / AGENT ACTIVITY</span><h2>Live output <span class="cockpit-output-count">0</span></h2></div><button class="cockpit-follow" type="button" aria-pressed="true">Ⅱ Pause output</button></header><p class="cockpit-output-explainer">Emitted messages, tool activity, readable native reasoning and reasoning summaries. Records tool responses; model-read acknowledgement is unavailable.</p><div class="cockpit-feed-labels"><span>TIME</span><span>EVENT / EMITTED CONTENT</span><span>RECORDED</span></div><div class="cockpit-feed" role="log" aria-label="Recorded agent output" tabindex="0"></div><footer><span class="cockpit-window-note">Bounded to ${COCKPIT_EVENT_LIMIT} events</span><span>Only readable runtime-emitted text is shown. Encrypted content is unreadable; availability varies.</span></footer></section>
      <footer class="cockpit-page-footer"><span><i></i> Player inspection · evidence stays outside agent observations</span><span>ESC <b>Back to flight deck</b></span></footer>
    </div>`;
  document.body.append(page);
  const el = <T extends HTMLElement = HTMLElement>(selector: string) => page.querySelector<T>(selector)!;
  const select = el<HTMLSelectElement>('.cockpit-selector'), feed = el('.cockpit-feed'), follow = el<HTMLButtonElement>('.cockpit-follow');
  const cards = mountCockpitCards(el('.cockpit-grid'));
  const listeners = new AbortController();
  let ids: string[] = [], droneId: string | null = null, generation = 0, cursor = 0, sessionId: string | null = null;
  let events: CockpitEvent[] = [], latest: CockpitSnapshot | null = null, visible = false, following = true, trimmed = false, rendered = '';
  let request: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let restoreFocus: HTMLElement | null = null, previousOverflow = '';
  let etag: string | null = null;

  function setDrones(next: readonly string[]) {
    if (json(ids) === json(next)) return; ids = [...next];
    select.replaceChildren(...ids.map(id => { const option = document.createElement('option'); option.value = id; option.textContent = dronePresentation(id).label; return option; }));
    if (droneId) select.value = droneId;
  }
  function setFollowing(value: boolean) {
    following = value; follow.textContent = value ? 'Ⅱ Pause output' : '↓ Resume output'; follow.setAttribute('aria-pressed', String(value));
    follow.classList.toggle('paused', !value); if (value) renderOutput();
  }
  function streamEmpty() {
    const empty = document.createElement('div'); empty.className = 'cockpit-feed-empty';
    const icon = document.createElement('span'); icon.textContent = '›_';
    const body = document.createElement('div'), title = document.createElement('strong'), hint = document.createElement('p');
    title.textContent = 'The agent has not emitted output yet.'; hint.textContent = 'Activity appears here as the runtime records it.'; body.append(title, hint); empty.append(icon, body); feed.replaceChildren(empty);
  }
  function renderOutput(force = false) {
    el('.cockpit-output-count').textContent = String(outputRows(events).length);
    if (!following && !force) return;
    const signature = json(events); if (!force && rendered === signature) return; rendered = signature;
    if (!events.length) { streamEmpty(); return; }
    const rows = outputRows(events).map(event => {
      const row = document.createElement('article'); row.className = `cockpit-event cockpit-event-${event.kind}`;
      const time = document.createElement('time'); time.dateTime = event.at; time.textContent = timestamp(event.at);
      const body = document.createElement('div'); body.className = 'cockpit-event-content';
      const title = document.createElement('strong');
      title.textContent = event.kind === 'reasoning' ? 'Native reasoning' : event.kind === 'reasoning-status' ? 'Reasoning availability' : event.kind === 'summary' ? 'Reasoning summary' : event.kind === 'output' ? 'Agent message' : event.name ?? (event.kind === 'lifecycle' ? 'Runtime activity' : event.kind === 'call' ? 'Tool call' : 'Tool result');
      body.append(title);
      if (event.text) { const text = document.createElement('p'); text.textContent = event.text; body.append(text); }
      if (event.data !== undefined) {
        const details = document.createElement('details'); details.className = 'cockpit-json';
        const summary = document.createElement('summary'); summary.textContent = 'Recorded payload';
        const source = document.createElement('pre'); source.textContent = json(event.data); details.append(summary, source);
        details.addEventListener('toggle', () => { if (details.open) setFollowing(false); }); body.append(details);
      }
      const streaming = event.streaming ?? Boolean(event.delta); row.classList.toggle('is-streaming', streaming);
      const badge = document.createElement('span'); badge.className = 'cockpit-event-kind'; badge.textContent = streaming ? 'STREAMING' : event.kind === 'reasoning-status' ? 'AVAILABILITY' : event.kind;
      row.append(time, body, badge); return row;
    });
    const oldScroll = feed.scrollTop; feed.replaceChildren(...rows); feed.scrollTop = following ? feed.scrollHeight : oldScroll;
  }
  function setError(message = '') { const error = el('.cockpit-error'); error.textContent = message; error.hidden = !message; }
  function renderRecorderState(snapshot: CockpitSnapshot) {
    const stopped = snapshot.lastDelivery?.bundle?.stopped === true;
    const status = snapshot.running && !stopped ? 'LIVE RECORDER' : snapshot.sessionId ? 'SESSION STOPPED' : 'STANDBY';
    el('.cockpit-status-text').textContent = status; el('.cockpit-recording').classList.toggle('active', snapshot.running && !stopped);
  }
  function render(snapshot: CockpitSnapshot) {
    const reset = snapshot.reset || snapshot.sessionId !== sessionId;
    if (reset) { events = []; cursor = 0; trimmed = false; rendered = ''; cards.reset(); etag = null; }
    sessionId = snapshot.sessionId; cursor = snapshot.cursor; latest = snapshot;
    const merged = mergeCockpitEvents(events, snapshot.events); events = merged.events; trimmed ||= merged.trimmed || snapshot.truncated;
    renderRecorderState(snapshot);
    el('.cockpit-session').textContent = sessionId ? `SESSION ${sessionId.slice(0, 12)}` : 'NO SESSION'; el('.cockpit-session').title = sessionId ?? '';
    el('.cockpit-delivery').textContent = snapshot.lastDelivery ? `DELIVERY #${snapshot.lastDelivery.sequence} · ${snapshot.lastDelivery.tool}` : 'NO DELIVERIES';
    el('.cockpit-updated').textContent = `Evidence updated ${timestamp(snapshot.serverTime)}`;
    el('.cockpit-window-note').textContent = trimmed ? `${COCKPIT_EVENT_LIMIT}-event window · earlier evidence may be available in audit/replay` : `Bounded to ${COCKPIT_EVENT_LIMIT} events · recorded at the tool response boundary`;
    cards.update({ snapshot, events }); renderOutput(reset); setError();
  }
  async function poll(version: number) {
    if (!visible || version !== generation || !droneId) return;
    const controller = new AbortController(); request = controller;
    try {
      const params = new URLSearchParams({ after: String(cursor) }); if (sessionId) params.set('session', sessionId);
      const response = await fetch(`/api/cockpit/${encodeURIComponent(droneId)}?${params}`, { cache: 'no-store', signal: controller.signal, headers: etag ? { 'If-None-Match': etag } : {} });
      if (response.status === 304) { if (visible && version === generation && latest) { renderRecorderState(latest); setError(); } return; }
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? `Cockpit request failed (${response.status}).`);
      if (visible && version === generation) { render(body as CockpitSnapshot); etag = response.headers.get('ETag'); }
    } catch (error) {
      if (!visible || version !== generation || controller.signal.aborted) return;
      el('.cockpit-status-text').textContent = 'RECONNECTING'; el('.cockpit-recording').classList.remove('active');
      setError(`${error instanceof Error ? error.message : 'Cockpit recorder unavailable.'}${latest ? ' Showing the last recorded evidence.' : ''} Retrying…`);
    } finally { if (visible && version === generation) timer = setTimeout(() => void poll(version), 1000); }
  }
  function route() {
    const match = /^#cockpit\/(.+)$/.exec(location.hash);
    let next: string | null = null; if (match) { try { next = decodeURIComponent(match[1]); } catch { next = match[1]; } }
    if (next === droneId && visible === Boolean(next)) return;
    generation++; clearTimeout(timer); request?.abort();
    const wasVisible = visible; visible = Boolean(next); droneId = next; page.hidden = !visible;
    const app = document.querySelector<HTMLElement>('#app'); if (app && (wasVisible || visible)) app.inert = visible || location.hash === '#admin';
    if (!visible) {
      cards.reset();
      if (wasVisible) { document.body.style.overflow = location.hash === '#admin' ? 'hidden' : previousOverflow; if (location.hash !== '#admin') restoreFocus?.focus(); }
      return;
    }
    if (!wasVisible) { restoreFocus = document.activeElement as HTMLElement; previousOverflow = document.body.style.overflow; page.dataset.backgroundOverflow = previousOverflow; }
    document.body.style.overflow = 'hidden';
    sessionId = null; cursor = 0; events = []; latest = null; trimmed = false; rendered = ''; etag = null; cards.reset(); setError();
    const identity = dronePresentation(next!); el('.cockpit-identity').textContent = identity.label; page.style.setProperty('--cockpit-accent', identity.color); select.value = next!;
    page.setAttribute('aria-label', `${identity.label} cockpit`); el('.cockpit-status-text').textContent = 'CONNECTING'; el('.cockpit-recording').classList.remove('active');
    el('.cockpit-session').textContent = 'SESSION —'; el('.cockpit-delivery').textContent = 'NO DELIVERIES'; el('.cockpit-updated').textContent = 'Awaiting recorder';
    setFollowing(true); renderOutput(true); page.scrollTop = 0; if (!wasVisible) el<HTMLAnchorElement>('.cockpit-back').focus();
    void poll(generation);
  }
  select.addEventListener('change', () => { location.hash = `cockpit/${encodeURIComponent(select.value)}`; }, { signal: listeners.signal });
  follow.addEventListener('click', () => setFollowing(!following), { signal: listeners.signal });
  feed.addEventListener('scroll', () => { if (following && feed.scrollHeight - feed.clientHeight - feed.scrollTop > 36) setFollowing(false); }, { signal: listeners.signal });
  page.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); location.hash = ''; }
    if (event.key === 'Tab') {
      const controls = Array.from(page.querySelectorAll<HTMLElement>('a,button:not(:disabled),select,summary,[tabindex="0"]')).filter(element => element.getClientRects().length);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
      if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus(); }
    }
  }, { signal: listeners.signal });
  window.addEventListener('hashchange', route, { signal: listeners.signal }); setDrones(initialIds); route();
  return { setDrones, dispose() { generation++; visible = false; clearTimeout(timer); request?.abort(); cards.reset(); listeners.abort(); page.remove(); } };
}
