import type { CockpitWorkspaceEntry } from '../shared/cockpit';

export type WorkspaceTreeNode =
  | { kind: 'directory'; path: string; name: string; children: WorkspaceTreeNode[] }
  | { kind: 'file'; path: string; name: string; entry: CockpitWorkspaceEntry };

/** Build only the folders implied by real virtual files; no host paths are read. */
export function workspaceTree(entries: readonly CockpitWorkspaceEntry[]): WorkspaceTreeNode[] {
  const root: WorkspaceTreeNode[] = [], folders = new Map<string, Extract<WorkspaceTreeNode, { kind: 'directory' }>>();
  const files = new Map<string, CockpitWorkspaceEntry>();
  for (const entry of entries) files.set(entry.path, entry);
  for (const entry of files.values()) {
    const parts = entry.path.split('/'); let children = root, path = '';
    for (const name of parts.slice(0, -1)) {
      path = path ? `${path}/${name}` : name;
      let folder = folders.get(path);
      if (!folder) { folder = { kind: 'directory', path, name, children: [] }; folders.set(path, folder); children.push(folder); }
      children = folder.children;
    }
    children.push({ kind: 'file', name: parts.at(-1)!, path: entry.path, entry });
  }
  const sort = (nodes: WorkspaceTreeNode[]) => {
    nodes.sort((a, b) => (a.kind === 'directory' ? 0 : 1) - (b.kind === 'directory' ? 0 : 1) || a.name.localeCompare(b.name));
    for (const node of nodes) if (node.kind === 'directory') sort(node.children);
  };
  sort(root); return root;
}

export function workspaceFileRequest(droneId: string, sessionId: string, entry: CockpitWorkspaceEntry) {
  return `/api/cockpit/${encodeURIComponent(droneId)}/workspace?${new URLSearchParams({ session: sessionId, path: entry.path, version: String(entry.version), sha256: entry.sha256 })}`;
}
