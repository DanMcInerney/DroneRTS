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
  assert.ok(result.shots['cargo-occluded'] === result.shots['cargo-occluded-absent'], 'cargo paint must remain occluded by the supporting roof');
  assert.notEqual(result.shots['cargo-before'], result.shots['cargo-after'], 'current cargo paint is visible in the production camera');
  assert.notEqual(result.shots['cargo-after'], result.shots['cargo-empty'], 'visible stock still follows authoritative depletion');
  assert.notEqual(result.shots['team-navigation-flash-a'], result.shots['team-navigation-flash-b'], 'phase-correct model views must show blinking');
  assert.notEqual(result.shots['drone-flash-acquired-on'], result.shots['drone-flash-acquired-off'], 'production 512x288 camera must see the flash change');
  assert.equal(result.shots['wreck-before-acquired'], result.shots['wreck-absent-acquired'], 'camera frames before a death cannot inherit a later wreck');
  assert.equal(result.shots['wreck-falling-acquired'], result.shots['wreck-snapshot-repeat-acquired'], 'past wreck cameras repeat exactly after rendering later acquisitions');
  assert.notEqual(result.shots['wreck-falling-acquired'], result.shots['wreck-trail-acquired'], 'the wreck and its trailing smoke must move in acquired pixels');
  assert.notEqual(result.shots['wreck-fading-acquired'], result.shots['wreck-cleared-acquired'], 'smoke dissipates while grounded debris remains');
  assert.equal(result.shots['wreck-occluded-acquired'], result.shots['wreck-occluded-absent'], 'wreck smoke must not reveal a death through opaque cover');
  assert.equal(result.shots['wreck-reset-acquired'], result.shots['wreck-absent-acquired'], 'reset clears all wrecks and smoke');
  assert.equal(result.wreckShots.cleared, 0);
  assert.notEqual(result.shots['projectile-active'], result.shots['projectile-absent'], 'the travelling bullet and white trail must be visible');
  assert.notEqual(result.shots['projectile-impact'], result.shots['projectile-absent'], 'smoke remains visible after the projectile is consumed');
  assert.notEqual(result.shots['projectile-impact'], result.shots['projectile-fading'], 'spent smoke must spread and fade in acquired pixels');
  assert.notEqual(result.shots['projectile-fading'], result.shots['projectile-gone'], 'the slowly fading smoke must remain visible before expiry');
  for (const name of ['before', 'gone', 'legacy', 'reset']) assert.equal(result.shots[`projectile-${name}`], result.shots['projectile-absent'], `${name} cannot inherit projectile smoke`);
  assert.equal(result.shots['projectile-past-repeat'], result.shots['projectile-active'], 'a repeated past acquisition must be pixel-identical after later smoke frames');
  assert.equal(result.shots['projectile-occluded'], result.shots['projectile-occluded-absent'], 'opaque cover must hide the entire white trail');
  assert.equal(result.shots['projectile-expired'], result.shots['projectile-impact'], 'expiry preserves the same travelled path as an equivalent contact');
  assert.equal(result.shots['projectile-victory-tail'], result.shots['projectile-fading'], 'victory presentation time preserves deterministic smoke evolution');
  assert.equal(result.shots['projectile-stopped'], result.shots['projectile-impact'], 'Stop freezes smoke while lights may continue');
  assert.ok(result.projectile.endpointError < 1e-8, 'white trail stops at its recorded contact point');
  assert.equal(result.projectile.segments.gone, 0); assert.equal(result.projectile.victoryTime, 13); assert.equal(result.projectile.frozenTime, 10.5);
  const times: number[] = result.captureMs;
  const summary = { inference:false, fixture:true, rendererId:rendererIdentity(process.cwd()), cityStats:result.cityStats,
    camera:{width:512,height:288,samples:times.length,p50Ms:times[Math.floor(times.length*.5)],p95Ms:times[Math.floor(times.length*.95)],maxMs:times.at(-1)},
    wrecks:{particles:result.wreckShots,sixWrecksCamera:{samples:result.wreckCaptureMs.length,p50Ms:result.wreckCaptureMs[Math.floor(result.wreckCaptureMs.length*.5)],maxMs:result.wreckCaptureMs.at(-1)}},
    projectile:{segments:result.projectile.segments,endpointError:result.projectile.endpointError,
      camera:{samples:result.projectile.captureMs.length,p50Ms:result.projectile.captureMs[Math.floor(result.projectile.captureMs.length*.5)],maxMs:result.projectile.captureMs.at(-1)}}, errors };
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
