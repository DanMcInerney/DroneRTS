import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceFileRequest, workspaceTree } from '../client/cockpit-workspace-model.ts';
import type { CockpitWorkspaceEntry } from '../shared/cockpit.ts';

const file = (path: string, version = 1): CockpitWorkspaceEntry => ({ path, bytes: 12, sha256: 'a'.repeat(64), version, metadataBytes: 80 });

test('workspace tree groups real nested files, sorts directories first and preserves metadata', () => {
  const source = [file('z.json'), file('scripts/nav/avoid.mjs', 4), file('scripts/main.js'), file('notes.md')];
  const tree = workspaceTree(source);
  assert.deepEqual(tree.map(node => [node.kind, node.name]), [['directory', 'scripts'], ['file', 'notes.md'], ['file', 'z.json']]);
  assert.equal(tree[0].kind, 'directory');
  if (tree[0].kind !== 'directory') assert.fail('Expected scripts directory');
  assert.deepEqual(tree[0].children.map(node => node.path), ['scripts/nav', 'scripts/main.js']);
  const nested = tree[0].children[0];
  if (nested.kind !== 'directory' || nested.children[0].kind !== 'file') assert.fail('Expected nested file');
  assert.equal(nested.children[0].entry.version, 4);
  assert.equal(nested.children[0].entry, source[1]);
  assert.equal(source[0].path, 'z.json');
});

test('virtual folders allow unusual names and retain a file that shares a folder name', () => {
  const tree = workspaceTree([file('__proto__/note.txt'), file('module.js'), file('module.js/child.js'), file('café/notes 1.md')]);
  assert.equal(tree.length, 4);
  assert.equal(tree.filter(node => node.name === 'module.js').length, 2);
  assert.ok(tree.some(node => node.kind === 'directory' && node.name === '__proto__'));
  assert.ok(tree.some(node => node.kind === 'directory' && node.name === 'café'));
});

test('workspace tree keeps one current entry per exact path and an empty board has no invented files', () => {
  const tree = workspaceTree([file('main.mjs', 1), file('main.mjs', 2)]);
  assert.equal(tree.length, 1);
  if (tree[0].kind !== 'file') assert.fail('Expected file');
  assert.equal(tree[0].entry.version, 2);
  assert.deepEqual(workspaceTree([]), []);
});

test('file reads carry independently encoded identity, session, exact path and version', () => {
  const request = workspaceFileRequest('drone-1', 'session&other=1', file('café/notes 1.md', 7));
  const url = new URL(request, 'http://127.0.0.1:4318');
  assert.equal(url.pathname, '/api/cockpit/drone-1/workspace');
  assert.equal(url.searchParams.get('path'), 'café/notes 1.md');
  assert.equal(url.searchParams.get('session'), 'session&other=1');
  assert.equal(url.searchParams.get('version'), '7');
  assert.equal(url.searchParams.get('sha256'), 'a'.repeat(64));
  assert.equal(url.searchParams.size, 4);
});
