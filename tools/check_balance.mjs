import assert from "node:assert/strict";
import { Simulation, simulate, census } from "./balance.mjs";
import { exposure, mapGeometry } from "./balance_geometry.mjs";
import { CONTENT_REGISTRY as registry } from "../game/content_registry.js";
import { GAME_EVENTS } from "../game/events.js";
import { WaveState } from "../game/waves.js";
import { createAdaptiveMusicEngine } from "../game/adaptive_music.js";
import { buildChoicesForTower, getSpecialRarityTableAtLevel, setSpecialRarityUpgradeLevel } from "../game/towers.js";
import { setRandomSeed } from "../game/utils.js";

const game = new Simulation(0, 17);
const archer = registry.towers.get("archer");
const t = game.purchaseTower(archer, 7, 5);
assert.ok(t);
assert.equal(game.gold, 150 - archer.cost);
assert.equal(game.purchaseTower(archer, 7, 5), null);
assert.equal(game.purchaseTower(registry.towers.get("peel"), 0, 0), null);
const levelCost = t.upgradeCost();
assert.equal(game.purchaseTowerLevel(t, "test"), true);
assert.equal(game.gold, 150 - archer.cost - levelCost);
assert.equal(game.purchaseTowerLevel(t, "test"), false);
assert.equal(t.level, 2);
assert.deepEqual(new Set(registry.towers.orderedIds), new Set(registry.towers.ids));

const route = [{x:0,y:0}, {x:4,y:0}, {x:4,y:2}, {x:0,y:2}];
const crossing = exposure(route, 2.5, 1.5, Math.sqrt(2));
assert.equal(crossing.distance, 10);
assert.equal(crossing.intervals.length, 2);
assert.ok(Math.abs(crossing.covered - 4) < 1e-8);
assert.equal(exposure(route, 20, 20, 1).covered, 0);
const allMaps = registry.maps.list.map((_, i) => new Simulation(i, 23));
for (const g of allMaps) for (const p of [g.map.entrance, g.map.exit]) {
  assert.equal(g.canPlaceTowerAt(p.x, p.y, archer), false);
}
const xeno = allMaps[1];
const oldSite = xeno.map.entrance;
assert.equal(xeno.map.grid[oldSite.y][oldSite.x], 0);
assert.ok(xeno.restoreTowerState({ id: "archer", gx: oldSite.x, gy: oldSite.y, level: 5 }));
const geometries = allMaps.slice(0, 2).map(mapGeometry);
assert.ok(geometries[1].length > geometries[0].length);
assert.ok(geometries[1].towers.archer.medianTiles > geometries[0].towers.archer.medianTiles);
for (let n = 1; n <= registry.maps.getTargetWaveByMapIndex(allMaps.length - 1); n++) {
  const reference = new WaveState(n, allMaps[0].wavePlanOptions());
  for (const other of allMaps.slice(1)) assert.deepEqual(new WaveState(n, other.wavePlanOptions()), reference);
}

const rows = census(110, 17);
for (const r of rows) {
  assert.ok(r.hp > 0 && r.count > 0 && r.bounty > 0 && r.magicEHP >= r.hp && r.physicalEHP >= r.hp);
  assert.equal(r.bossHP > 0, r.wave % 10 === 0);
}
assert.deepEqual(rows.slice(0, 10), census(10, 17));

const leaking = new Simulation(1, 17);
leaking.currentWave = 106;
const hits = [];
leaking.events.on(GAME_EVENTS.CORE_DAMAGED, e => hits.push([e.waveNum, e.damage]));
for (const wave of [105, 106]) {
  const enemy = leaking.spawnWaveEnemy("runner", wave);
  enemy.pathIndex = leaking.map.path.length - 2;
  enemy.x = leaking.map.exit.x + 0.5;
  enemy.y = leaking.map.exit.y + 0.5;
}
leaking.coreHP = 6;
leaking.update(1 / 60);
assert.deepEqual(hits, [[105, 1], [106, 5]]);
assert.equal(leaking.gameOver, true);
assert.match(leaking.fatalLeak, /Wave 106.*Runner.*100%.*5 core damage/);

const uplink = new Simulation(0, 27);
uplink.currentWave = 9;
uplink.recordPeelUplinkCast();
uplink.currentWave = 10;
uplink.recordPeelUplinkCast();
uplink.recordPeelUplinkCast();
uplink.resolvePeelUplinkWaveEnd();
assert.equal(uplink.coreHP, 28);
assert.equal(uplink.gold, 150 + 28 + 2 * 30);
uplink.resolvePeelUplinkWaveEnd();
assert.equal(uplink.gold, 238);
assert.deepEqual(uplink.peelUplinkCastsByWave, {});

const sample = { map: 0, seed: 41, policy: "coverage", until: 12 };
const run = simulate(sample);
assert.equal(run.cleared, 12);
assert.ok(run.towers.some(tower => tower.choices.length));
assert.deepEqual(run, simulate(sample));
function checkOffers(level) {
  setSpecialRarityUpgradeLevel(level);
  setRandomSeed(3571);
  const table = getSpecialRarityTableAtLevel(level);
  const counts = {};
  for (let i = 0; i < 10000; i++) for (const o of buildChoicesForTower(t, 1)) counts[o.rarityId] = (counts[o.rarityId] ?? 0) + 1;
  for (const {id, chance} of table) assert.ok(Math.abs((counts[id] ?? 0) / 30000 - chance) < 0.012, id);
  return counts.common ?? 0;
}
assert.ok(checkOffers(0) > checkOffers(8));
setSpecialRarityUpgradeLevel(0);
const tutorial = new Simulation(0, 17);
tutorial.setTutorialHooks({ shouldUseScriptedSpecialChoice: () => true });
const firstMilestone = { def: archer, level: 5 };
assert.ok(tutorial.rollMilestoneChoices(firstMilestone, 1).scriptedTutorialChoice);
for (const other of [{def: archer, level: 10}, {def: registry.towers.get("mage"), level: 5}]) {
  assert.equal(tutorial.rollMilestoneChoices(other, 1).scriptedTutorialChoice, false);
}
tutorial.mapIndex = 1;
assert.equal(tutorial.rollMilestoneChoices(firstMilestone, 1).scriptedTutorialChoice, false);
tutorial.mapIndex = 0;
tutorial.tutorialSpecialChoicePending = false;
assert.equal(tutorial.rollMilestoneChoices(firstMilestone, 1).scriptedTutorialChoice, false);

// Record notes scheduled by the real arranger, without an audio device.
const pitches = [];
const param = { setTargetAtTime(){}, setValueAtTime(){}, exponentialRampToValueAtTime(){}, linearRampToValueAtTime(){} };
const node = () => ({ connect(){}, disconnect(){}, frequency: param, gain: param, Q: {}, detune: param });
globalThis.window = { AudioContext: class {
  currentTime = 1;
  state = "running";
  createGain = node;
  createBiquadFilter = node;
  createOscillator() {
    return { ...node(), frequency: { ...param, setValueAtTime: hz => pitches.push(hz) }, start(){}, stop(){} };
  }
} };
const music = createAdaptiveMusicEngine();
try {
  music.setScene("menu");
  assert.equal(music.play(), true);
  assert.ok(pitches.length > 0);
  music.pause();
  pitches.length = 0;
  music.onRunStarted();
  music.onWaveStart({waveNum:10, isBossWave:true});
  assert.equal(pitches.length, 0, "a paused soundtrack must stay silent on boss spawn");
  music.play();
  assert.ok(pitches.length > 0);
  const bossLowNote = Math.min(...pitches);
  music.pause();
  music.onWaveEnd({isBossWave:true});
  music.onGameOver();
  music.onRunRestarted();
  pitches.length = 0;
  music.play();
  assert.ok(Math.min(...pitches) > bossLowNote, "the boss sub-bass should clear on restart");
  music.setMuted(true);
  pitches.length = 0;
  music.onWaveStart({waveNum:20, isBossWave:true});
  assert.equal(pitches.length, 0);
} finally {
  music.pause();
  delete globalThis.window;
}
console.log("Balance checks passed: purchases, geometry, all-map encounters, census, leaks, seeded replay, star rolls and music.");
