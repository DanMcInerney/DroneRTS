import * as THREE from 'three';
import { CITY } from '../shared/city';

/** An invisible player camera. It never changes drones, sensors, or the simulator. */
export class Explorer {
  readonly camera = new THREE.PerspectiveCamera(76, 1, 0.08, 12000);
  readonly overlay: HTMLDivElement;
  readonly view: HTMLDivElement;
  active = false;
  private keys = new Set<string>();
  private dragging = false;
  private previousFocus?: HTMLElement;
  private priorOverflow = '';
  private abort = new AbortController();
  private status: HTMLElement;
  private controls: HTMLElement;

  constructor(private onChange: (active: boolean) => void) {
    this.camera.rotation.order = 'YXZ';
    this.overlay = document.createElement('div');
    this.overlay.className = 'explorer'; this.overlay.hidden = true;
    this.overlay.setAttribute('role', 'dialog'); this.overlay.setAttribute('aria-modal', 'true');
    this.overlay.setAttribute('aria-label', 'God view map explorer');
    this.overlay.innerHTML = `<div class="explorer-view" tabindex="0" aria-label="Explore with WASD, mouse or arrow keys. Q and E change altitude. Escape exits."></div>
      <header class="explorer-header"><div><span class="eyebrow">FREE EXPLORATION</span><h2>God view <span>INVISIBLE OBSERVER</span></h2></div><button class="button button-stop" id="exit-explorer">Exit <kbd>Esc</kbd></button></header>
      <div class="explorer-crosshair" aria-hidden="true">+</div><footer class="explorer-controls"><div><kbd>W A S D</kbd> Move <kbd>Q / E</kbd> Down / up <kbd>Shift</kbd> Faster <kbd>↑ ↓ ← →</kbd> Look</div><p class="explorer-look">Click to capture mouse · or drag to look around</p><output class="explorer-position"></output></footer>`;
    document.body.append(this.overlay);
    this.view = this.overlay.querySelector('.explorer-view')!;
    this.status = this.overlay.querySelector('.explorer-position')!;
    this.controls = this.overlay.querySelector('.explorer-look')!;
    const options = { signal: this.abort.signal };
    this.overlay.querySelector('button')!.addEventListener('click', () => this.exit(), options);
    this.view.addEventListener('click', () => {
      if (!this.active || document.pointerLockElement === this.view) return;
      try { const result = this.view.requestPointerLock?.(); result?.catch(() => this.showDragHelp()); }
      catch { this.showDragHelp(); }
    }, options);
    this.view.addEventListener('pointerdown', event => { if (event.button === 0) this.dragging = true; }, options);
    window.addEventListener('pointerup', () => { this.dragging = false; }, options);
    document.addEventListener('pointerlockerror', () => this.showDragHelp(), options);
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === this.view) this.controls.textContent = 'Mouse captured · move mouse to look · Esc exits';
      else if (this.active) this.exit();
    }, options);
    document.addEventListener('mousemove', event => {
      if (!this.active || (document.pointerLockElement !== this.view && !this.dragging)) return;
      this.camera.rotation.y -= event.movementX * 0.0022;
      this.camera.rotation.x = THREE.MathUtils.clamp(this.camera.rotation.x - event.movementY * 0.0022, -1.5, 1.5);
    }, options);
    window.addEventListener('keydown', event => {
      if (!this.active) return;
      if (event.code === 'Escape') { event.preventDefault(); this.exit(); return; }
      if (event.code === 'Tab') {
        event.preventDefault();
        const exit = this.overlay.querySelector<HTMLButtonElement>('button')!;
        (document.activeElement === exit ? this.view : exit).focus();
        return;
      }
      if (/^(Key[WASDQE]|Arrow(Up|Down|Left|Right)|Shift(Left|Right)|Space)$/.test(event.code)) {
        event.preventDefault(); this.keys.add(event.code);
      }
    }, options);
    window.addEventListener('keyup', event => { this.keys.delete(event.code); }, options);
    window.addEventListener('blur', () => { this.keys.clear(); this.dragging = false; }, options);
    document.addEventListener('visibilitychange', () => { this.keys.clear(); this.dragging = false; }, options);
  }

  private showDragHelp() { this.controls.textContent = 'Drag mouse to look around · arrow keys also work · Esc exits'; }

  enter(x: number, z: number, altitude: number) {
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.priorOverflow = document.body.style.overflow;
    this.camera.position.set(x, altitude, z);
    this.camera.rotation.set(-0.3, 0, 0);
    this.active = true; this.overlay.hidden = false; this.keys.clear();
    document.body.style.overflow = 'hidden';
    this.onChange(true); this.view.focus();
  }

  exit() {
    if (!this.active) return;
    this.active = false; this.keys.clear(); this.dragging = false;
    if (document.pointerLockElement === this.view) document.exitPointerLock();
    this.overlay.hidden = true; document.body.style.overflow = this.priorOverflow;
    this.onChange(false); this.previousFocus?.focus({ preventScroll: true });
  }

  tick(dt: number) {
    if (!this.active) return;
    const down = (...keys: string[]) => Number(keys.some(key => this.keys.has(key)));
    this.camera.rotation.y += (down('ArrowLeft') - down('ArrowRight')) * dt * 1.6;
    this.camera.rotation.x = THREE.MathUtils.clamp(this.camera.rotation.x + (down('ArrowUp') - down('ArrowDown')) * dt * 1.3, -1.5, 1.5);
    const movement = new THREE.Vector3(down('KeyD') - down('KeyA'), down('KeyE', 'Space') - down('KeyQ'), down('KeyS') - down('KeyW'));
    if (movement.lengthSq()) {
      movement.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.camera.rotation.y);
      // Fine control at street height, faster traversal at city-view altitude.
      const travelSpeed = Math.max(12, Math.min(160, this.camera.position.y * 0.8));
      this.camera.position.addScaledVector(movement, dt * travelSpeed * (down('ShiftLeft', 'ShiftRight') ? 4 : 1));
      this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, CITY.bounds.x[0], CITY.bounds.x[1]);
      this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, CITY.bounds.z[0], CITY.bounds.z[1]);
      this.camera.position.y = THREE.MathUtils.clamp(this.camera.position.y, 0.7, 2200);
    }
    const { x, y, z } = this.camera.position;
    const heading = ((-THREE.MathUtils.radToDeg(this.camera.rotation.y) % 360) + 360) % 360;
    this.status.textContent = `X ${x.toFixed(3)}   Y ${y.toFixed(3)}   Z ${z.toFixed(3)} · HDG ${heading.toFixed(0)}° · ${down('ShiftLeft', 'ShiftRight') ? 'FAST' : 'CRUISE'}`;
  }

  dispose() { this.exit(); this.abort.abort(); this.overlay.remove(); }
}
