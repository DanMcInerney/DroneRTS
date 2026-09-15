import type { CockpitSnapshot, CockpitWorkspaceEntry, CockpitWorkspaceFile } from '../shared/cockpit';
import { formatBytes } from './onboard-presentation';
import { json } from './cockpit-model';
import { workspaceFileRequest, workspaceTree, type WorkspaceTreeNode } from './cockpit-workspace-model';

/** Reads bounded virtual files through the player API; never invokes drone tools. */
export class CockpitWorkspaceView {
  private snapshot?: CockpitSnapshot;
  private selected?: CockpitWorkspaceEntry;
  private pending?: AbortController;
  private version = 0;
  private treeSignature = '';
  private collapsed = new Set<string>();
  private tree: HTMLElement;
  private usage: HTMLElement;
  private state: HTMLElement;
  private reason: HTMLElement;
  private limits: HTMLElement;
  private file: HTMLElement;

  constructor(private host: HTMLElement) {
    host.innerHTML = '<div class="cockpit-workspace-state"></div><p class="cockpit-note cockpit-workspace-reason"></p><div class="cockpit-workspace-usage"></div><div class="cockpit-tree cockpit-file-tree" aria-label="Onboard files"></div><div class="cockpit-file-preview" aria-live="polite"></div><p class="cockpit-note cockpit-workspace-limits"></p>';
    this.tree = host.querySelector('.cockpit-file-tree')!; this.usage = host.querySelector('.cockpit-workspace-usage')!;
    this.state = host.querySelector('.cockpit-workspace-state')!; this.reason = host.querySelector('.cockpit-workspace-reason')!;
    this.limits = host.querySelector('.cockpit-workspace-limits')!; this.file = host.querySelector('.cockpit-file-preview')!;
    this.fileMessage('Select a file to inspect its current contents.');
  }
  update(snapshot: CockpitSnapshot) {
    const old = this.snapshot, workspace = snapshot.workspace;
    const switched = old && (old.droneId !== snapshot.droneId || old.sessionId !== snapshot.sessionId);
    this.snapshot = snapshot;
    if (switched || !workspace.available) { this.cancel(); this.selected = undefined; this.collapsed.clear(); this.fileMessage(workspace.available ? 'Select a file to inspect its current contents.' : 'Files are unavailable for this drone.'); }
    this.state.textContent = workspace.available ? 'PRIVATE ONBOARD WORKSPACE' : 'WORKSPACE UNAVAILABLE';
    this.state.classList.toggle('available', workspace.available);
    this.reason.textContent = workspace.reason;
    this.renderUsage();
    const bounds = workspace.limits;
    this.limits.textContent = bounds ? `${formatBytes(bounds.fileBytes)} per file · ${bounds.files} files maximum · ${workspace.retainedVersions ?? 0} retained source versions` : '';
    const signature = json([snapshot.droneId, snapshot.sessionId, workspace.available, workspace.entries]);
    if (signature !== this.treeSignature) {
      this.treeSignature = signature; this.renderTree();
      if (this.selected) {
        const current = workspace.entries.find(entry => entry.path === this.selected!.path);
        if (!current) { this.cancel(); this.selected = undefined; this.fileMessage('The selected file is no longer present.'); }
        else if (current.version !== this.selected.version || current.sha256 !== this.selected.sha256) void this.read(current);
      }
    }
  }
  private renderUsage() {
    const partition = this.snapshot?.workspace.storage?.workspace;
    this.usage.replaceChildren();
    if (!partition) return;
    const text = document.createElement('span'); text.textContent = `${formatBytes(partition.usedBytes)} / ${formatBytes(partition.limitBytes)} used`;
    const free = document.createElement('span'); free.textContent = `${formatBytes(partition.freeBytes)} free`;
    const meter = document.createElement('progress'); meter.max = partition.limitBytes; meter.value = partition.usedBytes; meter.setAttribute('aria-label', 'Onboard workspace storage');
    this.usage.append(text, free, meter);
  }
  private renderTree() {
    const workspace = this.snapshot!.workspace;
    this.tree.replaceChildren();
    const root = document.createElement('div'); root.className = 'cockpit-tree-root'; root.textContent = `▱  Onboard files · ${workspace.entries.length}`; this.tree.append(root);
    if (!workspace.entries.length) {
      const empty = document.createElement('div'); empty.className = 'cockpit-tree-empty'; empty.textContent = workspace.available ? '└─ No files saved yet' : '└─ Workspace unavailable'; this.tree.append(empty); return;
    }
    const append = (nodes: WorkspaceTreeNode[], parent: HTMLElement) => {
      for (const node of nodes) {
        if (node.kind === 'directory') {
          const folder = document.createElement('details'); folder.className = 'cockpit-folder'; folder.open = !this.collapsed.has(node.path);
          const summary = document.createElement('summary'); summary.textContent = node.name;
          const children = document.createElement('div'); append(node.children, children); folder.append(summary, children);
          folder.addEventListener('toggle', () => { if (!folder.isConnected) return; if (folder.open) this.collapsed.delete(node.path); else this.collapsed.add(node.path); }); parent.append(folder);
        } else {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'cockpit-file-button'; button.dataset.path = node.path;
          button.setAttribute('aria-label', `Read onboard file ${node.path}`); button.title = `${node.path} · version ${node.entry.version} · ${node.entry.bytes} bytes`;
          button.classList.toggle('selected', node.path === this.selected?.path); button.setAttribute('aria-pressed', String(node.path === this.selected?.path));
          const name = document.createElement('span'); name.textContent = node.name;
          const bytes = document.createElement('small'); bytes.textContent = formatBytes(node.entry.bytes); button.append(name, bytes);
          button.addEventListener('click', () => void this.read(node.entry)); parent.append(button);
        }
      }
    };
    append(workspaceTree(workspace.entries), this.tree);
  }
  private fileMessage(text: string, isError = false) {
    const message = document.createElement('p'); message.className = `cockpit-note${isError ? ' cockpit-file-error' : ''}`; message.textContent = text; this.file.replaceChildren(message);
  }
  private async read(entry: CockpitWorkspaceEntry) {
    this.cancel(); const snapshot = this.snapshot;
    if (!snapshot?.sessionId || !snapshot.workspace.available) { this.fileMessage('No active onboard workspace is available.', true); return; }
    this.selected = entry;
    for (const button of Array.from(this.tree.querySelectorAll<HTMLButtonElement>('.cockpit-file-button'))) { const selected = button.dataset.path === entry.path; button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); }
    const controller = new AbortController(); this.pending = controller; const version = this.version;
    this.fileMessage(`Reading ${entry.path} · version ${entry.version}…`);
    try {
      const response = await fetch(workspaceFileRequest(snapshot.droneId, snapshot.sessionId, entry), { cache: 'no-store', signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(response.status === 409 ? 'This file changed before it could be read. Select it again to read the latest version.' : body.error ?? `File request failed (${response.status}).`);
      if (version !== this.version || controller.signal.aborted) return;
      const file = body as CockpitWorkspaceFile;
      if (file.droneId !== snapshot.droneId || file.sessionId !== snapshot.sessionId || file.path !== entry.path || file.version !== entry.version || file.sha256 !== entry.sha256) throw new Error('File identity changed. Select the file again to refresh.');
      this.renderFile(file);
    } catch (error) {
      if (controller.signal.aborted || version !== this.version) return;
      this.fileMessage(error instanceof Error ? error.message : 'Could not read this file.', true);
    }
  }
  private renderFile(file: CockpitWorkspaceFile) {
    const title = document.createElement('strong'); title.className = 'cockpit-file-title'; title.textContent = file.path;
    const meta = document.createElement('span'); meta.className = 'cockpit-file-meta'; meta.textContent = `v${file.version} · ${file.bytes} bytes · SHA256 ${file.sha256.slice(0, 12)}`; meta.title = `SHA256 ${file.sha256}`;
    const pre = document.createElement('pre'); pre.tabIndex = 0; pre.setAttribute('aria-label', `${file.path} file contents`); pre.textContent = file.content;
    this.file.replaceChildren(title, meta, pre);
    if (file.omissions.length) { const note = document.createElement('p'); note.className = 'cockpit-note'; note.textContent = file.omissions.join(' '); this.file.append(note); }
  }
  private cancel() { this.version++; this.pending?.abort(); this.pending = undefined; }
  dispose() { this.cancel(); this.snapshot = undefined; this.selected = undefined; this.host.replaceChildren(); }
}
