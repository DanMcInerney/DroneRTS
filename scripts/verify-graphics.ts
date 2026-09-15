import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createArtifactRun } from './test-artifacts.ts';
import { rendererIdentity } from '../server/renderer-identity.ts';

const port = Number(process.env.FLEET_QA_PORT ?? 4319);
assert.ok(port !== 4317 && Number.isInteger(port) && port > 1024 && port <= 65535);
const base = `http://127.0.0.1:${port}`;
const state = await (await fetch(`${base}/api/state`)).json();
assert.equal(state.running, false, 'preserve an active player match');
const run = createArtifactRun('graphics');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width:1440, height:900 } });
const errors: string[] = []; page.on('pageerror',error=>errors.push(error.message));
try {
  await page.route('**/graphics-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><title>Blender graphics fixture</title></head><body></body></html>'}));
  await page.goto(`${base}/graphics-fixture`);
  const result = await page.evaluate(async state => {
    const path = '/scripts/graphics-fixture.ts';
    return (await import(path)).graphicsFixture(state);
  },state);
  for (const [name,image] of Object.entries(result.shots) as [string,string][]) {
    await writeFile(resolve(run.directory, `${name}.${image.startsWith('data:image/png')?'png':'jpg'}`),Buffer.from(image.split(',')[1],'base64'));
  }
  assert.deepEqual(errors,[]);
  const times: number[] = result.captureMs;
  const summary = { inference:false, fixture:true, rendererId:rendererIdentity(process.cwd()), cityStats:result.cityStats,
    camera:{width:512,height:288,samples:times.length,p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)],maxMs:times.at(-1)}, errors };
  // A failed required asset must prevent camera ownership and match launch.
  const failed = await browser.newPage(); let cameraReady=false;
  await failed.route('**/api/state',route=>route.fulfill({json:state}));
  await failed.route('**/drone-kit.glb',route=>route.fulfill({status:503,body:'asset unavailable'}));
  await failed.routeWebSocket('**/ws',socket=>socket.onMessage(data=>{if(JSON.parse(String(data)).type==='camera-ready')cameraReady=true;}));
  await failed.goto(base);
  await failed.locator('#alert-text').getByText(/Asset download failed/).waitFor();
  assert.equal(await failed.locator('#start').isDisabled(),true); assert.equal(cameraReady,false);
  await failed.close();
  await writeFile(resolve(run.directory,'result.json'),JSON.stringify({...summary,assetFailureBlocked:true},null,2));
  console.log(JSON.stringify({directory:run.directory,...summary,assetFailureBlocked:true}));
} finally { await browser.close(); }
