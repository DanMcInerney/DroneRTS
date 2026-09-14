import type { RadioMessage } from './types';
import { dronePresentation } from './drone-presentation';

const operator = (id: string) => id === 'operator' || id === 'operator-blue' || id === 'player';
const address = (id: string) => operator(id) ? 'PLAYER' : id === 'all' ? 'TEAM' : dronePresentation(id).label.toUpperCase();

/** Receipt stages are distinct; a storage or bundle receipt never asserts comprehension. */
export function radioDeliveryPresentation(message: RadioMessage): string {
  const delivery = message.delivery;
  if (!delivery) return 'Delivery status unavailable';
  const list = (ids?: string[]) => ids?.map(address).join(', ');
  return [
    delivery.queuedAt ? 'Queued' : '',
    delivery.storedBy?.length ? `Stored: ${list(delivery.storedBy)}` : '',
    delivery.bundledBy?.length ? `In input: ${list(delivery.bundledBy)}` : '',
    delivery.answeredBy?.length ? `Actual reply: ${list(delivery.answeredBy)}` : '',
    delivery.completedBy?.length ? `Reported complete: ${list(delivery.completedBy)}` : '',
    delivery.error ? `Delivery: ${delivery.error}` : '',
  ].filter(Boolean).join(' · ') || 'Delivery pending';
}

export function visibleRadioMessages(radio: RadioMessage[], droneId: string, scope: 'drone' | 'team') {
  if (scope === 'drone') return radio.filter(message => message.from === droneId);
  return radio.filter(message => (operator(message.from) && (message.to === 'all' || dronePresentation(message.to).team === 'blue'))
    || (dronePresentation(message.from).team === 'blue' && (operator(message.to) || message.to === 'all')));
}

/** Actual sent messages and receipt snapshots, never a synthesized team plan. */
export class DroneRadio {
  private log: HTMLElement;
  private count: HTMLElement;
  private latest: HTMLButtonElement;
  private signature = '';
  private following = true;

  constructor(root: HTMLElement, private droneId: string, private scope: 'drone' | 'team' = 'drone') {
    root.innerHTML = '<div class="drone-radio-heading"><span>RADIO <b>0</b></span><button type="button" hidden>Latest ↓</button></div><div class="drone-radio-log" role="log" tabindex="0" aria-live="polite" aria-relevant="additions"></div>';
    this.log = root.querySelector('.drone-radio-log')!;
    this.count = root.querySelector('b')!;
    this.latest = root.querySelector('button')!;
    const label = dronePresentation(droneId).label;
    this.log.setAttribute('aria-label', scope === 'team' ? 'Player and blue team messages' : `${label} sent radio messages`);
    this.latest.setAttribute('aria-label', `Follow latest ${label} radio messages`);
    this.log.addEventListener('scroll', () => {
      this.following = this.log.scrollHeight - this.log.clientHeight - this.log.scrollTop < 12;
      this.latest.hidden = this.following;
    });
    this.latest.addEventListener('click', () => {
      this.following = true;
      this.latest.hidden = true;
      this.log.scrollTop = this.log.scrollHeight;
    });
  }

  update(radio: RadioMessage[]) {
    const messages = visibleRadioMessages(radio, this.droneId, this.scope);
    const signature = JSON.stringify(messages);
    if (signature === this.signature) return;
    this.signature = signature;
    this.count.textContent = String(messages.length);
    if (!messages.length) {
      this.log.innerHTML = '<p class="drone-radio-empty">No transmissions yet.</p>';
      this.following = true;
      this.latest.hidden = true;
      return;
    }
    // Keep the same message in view when the server trims the oldest history.
    const top = this.log.getBoundingClientRect().top;
    const anchor = Array.from(this.log.children).find(row => row.getBoundingClientRect().bottom > top) as HTMLElement | undefined;
    const anchorId = anchor?.dataset.messageId;
    const anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    const oldScroll = this.log.scrollTop;
    const rows = messages.map(message => {
      const row = document.createElement('article'); row.className = 'drone-radio-message'; row.dataset.messageId = message.id;
      const meta = document.createElement('div'); meta.className = 'drone-radio-meta';
      const to = document.createElement('strong'); to.textContent = `${this.scope === 'team' ? `${address(message.from)} ` : ''}→ ${address(message.to)}`;
      const kind = document.createElement('span'); kind.textContent = message.kind;
      const time = document.createElement('time'); time.textContent = `${Math.floor(message.simTime / 60).toString().padStart(2, '0')}:${Math.floor(message.simTime % 60).toString().padStart(2, '0')}`;
      const body = document.createElement('p'); body.textContent = message.text;
      const stages = document.createElement('small'); stages.className = 'radio-delivery'; stages.textContent = radioDeliveryPresentation(message);
      meta.append(to, kind, time); row.append(meta, body, stages); return row;
    });
    this.log.replaceChildren(...rows);
    if (this.following) this.log.scrollTop = this.log.scrollHeight;
    else {
      this.log.scrollTop = oldScroll;
      const retained = rows.find(row => row.dataset.messageId === anchorId);
      if (retained) this.log.scrollTop += retained.getBoundingClientRect().top - top - anchorOffset;
    }
    this.latest.hidden = this.following;
  }
}
