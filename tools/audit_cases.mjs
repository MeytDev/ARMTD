// Deterministic regression scenarios for the September 2026 audit.
// The assertions below fail the process when a fixed behavior regresses.
import { Game, escapeHtmlText, normalizeMapDef, normalizeSpecialUpgrades } from '../game/game.js';
import { GameMap, MAP_POOL } from '../game/map.js';
import { CONTENT_REGISTRY } from '../game/content_registry.js';
import { Enemy, ENEMY_TYPES, computePrevWaveTotals } from '../game/enemies.js';
import {
  Tower,
  TOWER_DEFS,
  getSpecialRarityTableAtLevel,
  blizzardPulseMagicDamage,
  prestigeDurationFor,
  magePrestigeAuraProfile,
  sniperCarepackageGoldForWave
} from '../game/towers.js';
import { WaveState, waveModifiers } from '../game/waves.js';
import { applyMagicDamage } from '../game/damage.js';
import { createEventBus } from '../game/events.js';
import { SFX } from '../game/audio.js';
import { FreeProjectile } from '../game/projectiles.js';
import { TUTORIAL_STEP_ORDER, isTutorialMapEligible, tutorialTowerPosition } from '../game/tutorial.js';
import { isDevToolsEnabled } from '../game/devtools.js';
import { normalizeSettings } from '../game/preferences.js';
import { random, setRandomSeed } from '../game/utils.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
SFX.setMuted(true);
const noop = () => {};
function headless(){
  const g = Object.create(Game.prototype);
  Object.assign(g, {
    map: new GameMap(MAP_POOL[0]), mapIndex: 0, gold: 150, coreHP: 25, totalKills: 0,
    towers: [], enemies: [], projectiles: [], effects: [], rings: [], attackFlashes: [], _attackFlashCursor: 0, floaters: [], centerQueue: [], deferredActions: [],
    wavesActive: [], currentWave: 0, nextWaveNum: 1, started: false, gameSpeed: 1, gameOver: false,
    endlessMode: false, autoQueueDelay: 0.35, autoQueueTimer: 0, campaignWinShown: false,
    nextWaveNowGoldBuff: {mult:1,timeLeft:0,maxTime:0}, peelUplinkCastsByWave: {}, lastUplinkRewardWave: 0,
    _statsFlushTimer:0, _statsFlushInterval:1, _statsDirty:false, _enemyRangeScratch:[], _towerRangeScratch:[], simTime:0,
    events:createEventBus(), tutorialHooks:{}, uiHover:{}, seenModifierIds:new Set(),
    refreshUI:noop, syncSpeedUI:noop, logEvent:noop, persistLifetimeStats:noop,
    refreshMapBackground:noop, hideWinModal:noop, hideGameOverModal:noop, closeModifierIntro:noop,
    rebuildTowerSpatialIndex:noop, rebuildEnemySpatialIndex:noop, maybeShowModifierIntro:noop
  });
  g.resetRunStats(); g.lifetimeStats=structuredClone(g.runStats); g.resetRunQuestState();
  return g;
}
const out = {};
out.tutorialFlow = {
  steps: TUTORIAL_STEP_ORDER,
  firstMap: isTutorialMapEligible({ mapIndex: 0 }),
  secondMap: isTutorialMapEligible({ mapIndex: 1 }),
  customMap: isTutorialMapEligible({ mapIndex: 0, isCustomMapRun: true })
};
const prestigeText = (id, tower = {}) => {
  const desc = TOWER_DEFS.find(def => def.id === id)?.prestige?.desc;
  return typeof desc === 'function' ? desc(tower) : String(desc || '');
};
out.prestigeDescriptions = {
  durations: ['archer', 'mage', 'breaker', 'blizzard'].map(id => ({ id, seconds: prestigeDurationFor(id) })),
  mageAura: magePrestigeAuraProfile(),
  sniperWave10Gold: sniperCarepackageGoldForWave(10),
  archer: prestigeText('archer'),
  breaker: prestigeText('breaker'),
  peel: prestigeText('peel'),
  sniper: prestigeText('sniper', { game: { currentWave: 10 } })
};
out.maps = MAP_POOL.map((def, i) => {
  const m = new GameMap(def);
  return {index:i,name:m.name,pathCells:m.path.length,uniquePathCells:new Set(m.path.map(p=>`${p.x},${p.y}`)).size,archerTutorialBuildable:m.isBuildable(7,5),mageTutorialBuildable:m.isBuildable(8,5)};
});
out.mapBalanceBaseline = MAP_POOL.map((def, index) => {
  const map = new GameMap(def);
  const card = CONTENT_REGISTRY.maps.getCampaignCard(index);
  let buildableTiles = 0;
  let obstacleTiles = 0;
  const buildablePositions = [];
  for (let y = 0; y < map.h; y += 1) {
    for (let x = 0; x < map.w; x += 1) {
      if (map.isBuildable(x, y)) {
        buildableTiles += 1;
        buildablePositions.push({ x, y });
      }
      else if (map.isObstacle(x, y)) obstacleTiles += 1;
    }
  }
  const baseRangeCoverage = Object.fromEntries(TOWER_DEFS.map((towerDef) => {
    const range = Math.max(0, Number(towerDef?.base?.Range) || 0);
    const maxCoveredRouteTiles = buildablePositions.reduce((best, position) => {
      const covered = map.path.reduce((count, pathCell) => {
        const dx = (pathCell.x + 0.5) - (position.x + 0.5);
        const dy = (pathCell.y + 0.5) - (position.y + 0.5);
        return count + ((dx * dx + dy * dy) <= range * range ? 1 : 0);
      }, 0);
      return Math.max(best, covered);
    }, 0);
    return [towerDef.id, maxCoveredRouteTiles];
  }));
  const targetWave = Math.max(1, Number(card?.targetWave) || 1);
  const targetPlan = new WaveState(targetWave).plan;
  const targetMods = { ...waveModifiers(targetWave), noAffix: true };
  let baseTargetWaveHP = 0;
  let baseTargetWaveGold = 0;
  for (const part of targetPlan) {
    if (part.type === "boss") {
      const previousWave = computePrevWaveTotals(Math.max(1, targetWave - 1));
      const bossGoldMultiplier = targetWave % 100 === 0 ? Math.max(1, Math.floor(targetWave / 10)) : 1;
      baseTargetWaveHP += previousWave.totalHP * part.count;
      baseTargetWaveGold += previousWave.totalWealth * bossGoldMultiplier * part.count;
      continue;
    }
    const sample = new Enemy(map, part.type, targetWave, headless(), null, targetMods);
    baseTargetWaveHP += sample.maxHP * part.count;
    baseTargetWaveGold += sample.wealth * part.count;
  }
  return {
    index,
    name: map.name,
    routeTiles: map.path.length,
    buildableTiles,
    obstacleTiles,
    targetWave,
    baseRangeCoverage,
    baseTargetWaveHP,
    baseTargetWaveGold
  };
});
out.tutorialPositions = MAP_POOL.map((def, i) => {
  const map = new GameMap(def);
  const fake = {
    map,
    towers: [],
    canPlaceTowerAt(x, y, towerDef){
      const size = towerDef?.size ?? 1;
      for (let dy = 0; dy < size; dy += 1) {
        for (let dx = 0; dx < size; dx += 1) {
          if (!map.inBounds(x + dx, y + dy) || !map.isBuildable(x + dx, y + dy)) return false;
          if (this.towers.some(t => x + dx >= t.gx && x + dx < t.gx + (t.size ?? 1) && y + dy >= t.gy && y + dy < t.gy + (t.size ?? 1))) return false;
        }
      }
      return true;
    }
  };
  const archer = tutorialTowerPosition(fake, "archer");
  fake.towers.push({ def: { id: "archer" }, gx: archer.x, gy: archer.y, size: 1 });
  const mage = tutorialTowerPosition(fake, "mage");
  return { index: i, archer, mage, archerBuildable: map.isBuildable(archer.x, archer.y), mageBuildable: map.isBuildable(mage.x, mage.y) };
});
const edge = new GameMap({gridW:4,gridH:4,grid:Array.from({length:4},()=>[1,1,1,1]),entrance:{x:3,y:3},exit:{x:0,y:0}});
out.zeroExit = {requested:{x:0,y:0},actual:edge.exit};
const boss = new Enemy(new GameMap(MAP_POOL[0]),'boss',80,headless(),{HP:1000,Speed:1,Armor:0,MR:0,Wealth:10},{noAffix:true});
boss.applyFrostbite(3,10,null); boss.castBossSkill('cleanse');
out.cleanse = {rootTime:boss.rootTime,frostbiteTime:boss.frostbiteTime,slow:boss.slowPct};
const gDead = headless();
const dead = new Enemy(gDead.map,'runner',1,gDead,null,{noAffix:true});
dead.pathIndex=gDead.map.path.length-2;
dead.x=gDead.map.exit.x+0.499;dead.y=gDead.map.exit.y+0.5;dead.hp=1;
dead.applyPoison(100,1,null);gDead.enemies.push(dead);gDead.update(0.05);
out.dotAtExit={dead:dead.dead,reachedExit:dead.reachedExit,coreHP:gDead.coreHP,gold:gDead.gold};
const gSave=headless();gSave.started=true;gSave.simTime = 12.5;gSave.queueWave(1);
gSave.enemies.push(new Enemy(gSave.map,'runner',1,gSave,null,{noAffix:true}));
gSave.queueWave(2);const save=gSave.createRunSaveData();const restored=headless();restored.loadRunSave(save);
out.overlappingSave={before:{activeWaves:gSave.wavesActive.map(w=>w.waveNum),enemies:gSave.enemies.length,simTime:gSave.simTime},save:{resumeWave:save.resumeWave,simTime:save.simTime,hasEnemies:'enemies' in save,hasWaves:'wavesActive' in save},after:{activeWaves:restored.wavesActive.map(w=>w.waveNum),enemies:restored.enemies.length,simTime:restored.simTime}};
const hostileTitle = '<img src=x onerror=alert(1)>';
const safeCustomMap = normalizeMapDef({
  name: `${hostileTitle}${"x".repeat(200)}`,
  gridW: 999,
  gridH: 999,
  entrance: { x: -99, y: 999 },
  exit: { x: 999, y: -99 },
  grid: []
});
const safeUpgrades = normalizeSpecialUpgrades(Array.from({ length: 20 }, () => ({
  tier: 999,
  title: hostileTitle.repeat(10),
  rarityId: '<script>'
})));
const corruptSaveGame = headless();
const corruptTowerPos = tutorialTowerPosition(corruptSaveGame, 'archer');
const corruptLoaded = corruptSaveGame.loadRunSave({
  schema: 2,
  mapIndex: 0,
  gold: Number.MAX_VALUE,
  coreHP: Number.MAX_VALUE,
  totalKills: Number.MAX_VALUE,
  resumeWave: Number.MAX_VALUE,
  started: true,
  endlessMode: false,
  isCustomMapRun: false,
  towers: [{
    id: 'archer',
    gx: corruptTowerPos.x,
    gy: corruptTowerPos.y,
    level: Number.MAX_VALUE,
    targetMode: '<script>',
    secondaryLevel: Number.MAX_VALUE,
    perks: { asMul: Number.MAX_VALUE, adMul: Number.MAX_VALUE, magMul: Number.MAX_VALUE, dmgMul: Number.MAX_VALUE },
    specialUpgrades: safeUpgrades,
    specialMagicActualMul: Number.MAX_VALUE,
    specialMagicExpectedMul: Number.MAX_VALUE
  }]
});
const corruptTower = corruptSaveGame.towers[0] || null;
out.saveBounds = {
  loaded: corruptLoaded,
  map: { nameLength: safeCustomMap.name.length, gridW: safeCustomMap.gridW, gridH: safeCustomMap.gridH },
  upgrades: { count: safeUpgrades.length, tierMax: Math.max(...safeUpgrades.map(x => x.tier)), titleLength: Math.max(...safeUpgrades.map(x => x.title.length)), rarityIds: [...new Set(safeUpgrades.map(x => x.rarityId))] },
  escapedTitle: escapeHtmlText(hostileTitle),
  save: corruptTower ? {
    wave: corruptSaveGame.nextWaveNum,
    level: corruptTower.level,
    targetMode: corruptTower.targetMode,
    secondaryLevel: corruptTower.secondaryLevel,
    dmgMul: corruptTower.perks.dmgMul,
    magicMul: corruptTower.specialMagicActualMul
  } : null
};
let towerIndexRebuilds = 0;
const towerIndexProbe = Object.create(Game.prototype);
towerIndexProbe.towers = [];
towerIndexProbe.towerSpatial = { rebuild: () => { towerIndexRebuilds += 1; } };
towerIndexProbe._towerSpatialDirty = true;
towerIndexProbe.rebuildTowerSpatialIndex();
towerIndexProbe.rebuildTowerSpatialIndex();
towerIndexProbe.towers.push({ id: 'new-tower' });
towerIndexProbe.markTowerSpatialIndexDirty();
towerIndexProbe.rebuildTowerSpatialIndex();
out.towerSpatialCache = { rebuilds: towerIndexRebuilds, dirtyAfterRebuild: towerIndexProbe._towerSpatialDirty };
const staticCtx = {
  clearRect(){}, fillRect(){}, beginPath(){}, moveTo(){}, lineTo(){}, stroke(){}, drawImage(){},
  save(){}, restore(){}, strokeRect(){}, closePath(){}
};
const staticCanvas = { width: 0, height: 0 };
const staticMapProbe = Object.create(Game.prototype);
staticMapProbe.cv = { width: 100, height: 100 };
staticMapProbe.tileSize = 5;
staticMapProbe.offsetX = 10;
staticMapProbe.offsetY = 10;
staticMapProbe.map = {
  w: 2,
  h: 2,
  entrance: { x: 0, y: 0 },
  exit: { x: 1, y: 1 },
  isPath: () => true,
  isObstacle: () => false
};
staticMapProbe.mapBgReady = false;
staticMapProbe.staticMapCanvas = staticCanvas;
staticMapProbe.staticMapCtx = staticCtx;
staticMapProbe._staticMapCacheKey = "";
staticMapProbe._staticMapRenderCount = 0;
const firstStaticLayer = staticMapProbe.ensureStaticMapCache();
const secondStaticLayer = staticMapProbe.ensureStaticMapCache();
staticMapProbe.invalidateStaticMapCache();
staticMapProbe.ensureStaticMapCache();
out.staticMapCache = {
  sameLayer: firstStaticLayer === secondStaticLayer,
  renderCount: staticMapProbe._staticMapRenderCount,
  canvasWidth: staticCanvas.width,
  canvasHeight: staticCanvas.height
};
const panelProbe = Object.create(Game.prototype);
Object.assign(panelProbe, {
  selectedEnemy: null,
  selectedTowerInstance: null,
  selectedTowerDef: null,
  towers: [],
  gold: 150,
  currentWave: 0,
  totalKills: 0,
  highKills: [],
  gameOver: false,
  winModalOpen: false,
  uiHover: { upgrade: false, fast: false },
  hoverSpecialChoice: null
});
const panelKeyA = panelProbe.getSelectedPanelSignature(false);
const panelKeyB = panelProbe.getSelectedPanelSignature(false);
panelProbe.gold = 151;
const panelKeyC = panelProbe.getSelectedPanelSignature(false);
out.selectedPanelCache = { stable: panelKeyA === panelKeyB, changesOnGold: panelKeyA !== panelKeyC };
const visualBudgetProbe = Object.create(Game.prototype);
visualBudgetProbe.effects = Array.from({ length: 325 }, () => ({ onHit: null }));
visualBudgetProbe.floaters = Array.from({ length: 425 }, () => ({ dead: false }));
visualBudgetProbe.centerQueue = Array.from({ length: 30 }, () => ({ life: 1 }));
visualBudgetProbe._visualBudgetDrops = { effects: 0, floaters: 0, centerQueue: 0 };
visualBudgetProbe.trimTransientVisuals();
out.visualBudget = {
  effects: visualBudgetProbe.effects.length,
  floaters: visualBudgetProbe.floaters.length,
  centerQueue: visualBudgetProbe.centerQueue.length,
  dropped: visualBudgetProbe._visualBudgetDrops
};
const normalizedVisualSettings = normalizeSettings({ graphics: { lowEffects: 1 } });
out.visualSettings = { lowEffects: normalizedVisualSettings.graphics.lowEffects };
const spatialAttackProbeGame = headless();
const breakerProbe = new Tower(TOWER_DEFS.find(d => d.id === 'breaker'), 0, 0, spatialAttackProbeGame);
breakerProbe.baseRange = 2;
breakerProbe.cleaveAll = true;
let cleaveShots = 0;
breakerProbe.shoot = () => { cleaveShots += 1; };
const nearEnemy = { x: 1, y: 0, dead: false, reachedExit: false };
const farEnemy = { x: 8, y: 0, dead: false, reachedExit: false };
spatialAttackProbeGame.enemies = [nearEnemy, farEnemy];
spatialAttackProbeGame.getEnemiesInRange = () => [nearEnemy];
breakerProbe.cleaveShootAll(spatialAttackProbeGame);
out.spatialAttack = { cleaveShots };
const peelProbeGame = headless();
const peelProbe = new Tower(TOWER_DEFS.find(d => d.id === 'peel'), 0, 0, peelProbeGame);
const peelTarget = new Tower(TOWER_DEFS.find(d => d.id === 'archer'), 1, 0, peelProbeGame);
peelProbeGame.towers = [peelProbe, peelTarget];
peelProbeGame.getTowersInRange = () => [];
out.spatialAttack.peelFirstHop = peelProbe.pickNearestPeelTarget(peelProbeGame, peelProbe, { firstHop: true }) === null;
const restart=headless();restart.nextWaveNowGoldBuff={mult:4,timeLeft:10,maxTime:10};restart.restart();
out.restartBuff=restart.nextWaveNowGoldBuff;
out.attackTiming=[];
for(const fps of [30,60,144]) for(const speed of [1,3]) {
  const g=headless(); const t=new Tower(TOWER_DEFS.find(d=>d.id==='archer'),0,0,g);
  t.baseAS=20;let shots=0;t.chooseTarget=()=>({});t.shoot=()=>shots++;
  for(let i=0;i<fps*10;i++) t.update(speed/fps,g);
  out.attackTiming.push({fps,speed,simulatedSeconds:speed*10,shots,idealShots:speed*200});
}
out.travelTiming=[];
for(const fps of [30,60,144]) for(const speed of [1,3]) {
  const g=headless();const e=new Enemy(g.map,'runner',1,g,null,{noAffix:true});e.baseSpeed=7;
  for(let i=0;i<fps*2;i++) e.update(speed/fps);
  out.travelTiming.push({fps,speed,pathIndex:e.pathIndex,x:+e.x.toFixed(3),y:+e.y.toFixed(3)});
}
out.spawnTiming=[];
for (const fps of [30,60,144]) {
  const g=headless();
  g.started=true;
  g.queueWave(1);
  for(let i=0;i<fps*5;i++) g.update(1/fps);
  out.spawnTiming.push({fps,spawned:g.enemies.length + g.wavesActive.reduce((n,w)=>n+w.spawnedCount,0)});
}
out.wavePressure=[99,100,101,105,106,109,110,111,145].map(w=>{
  const g=headless(); const plan=new WaveState(w);let hp=0;
  for(const p of plan.plan) if(p.type!=='boss') hp+=new Enemy(g.map,p.type,w,g,null,{...waveModifiers(w),noAffix:true}).maxHP*p.count;
  return {wave:w,count:plan.plan.reduce((n,p)=>n+p.count,0),nonBossHP:hp,overcap:waveModifiers(w).overcap.hp,interval:plan.spawnInterval};
});
out.earlyIntervals=[1,2,3,4,5,10].map(w=>({wave:w,seconds:new WaveState(w).spawnInterval}));
out.magicDamage=[0,100,1000,6000,6001].map(pen=>({raw:100,mr:0,pen,result:applyMagicDamage(100,0,pen)}));
const blizzardTest = new Tower(TOWER_DEFS.find(d => d.id === 'blizzard'), 0, 0, headless());
blizzardTest.perks.magMul = 2;
blizzardTest.peelBuffs.mag = { mul: 1.5, time: 10 };
blizzardTest.perks.dmgMul = 1.2;
out.blizzardPulse = { actual: blizzardPulseMagicDamage(blizzardTest), expected: (10 + (blizzardTest.magicBonusExact * 2 * 1.5) * 1.30) * 1.2 };
const gPeel=headless();const peel=new Tower(TOWER_DEFS.find(d=>d.id==='peel'),0,0,gPeel);peel.level=21;peel.prestigeMana=peel.prestigeMaxMana;gPeel.towers=[peel];
for(let i=0;i<60;i++) peel.update(1/60,gPeel);
out.peelNoEligibleTarget={seconds:1,noticeCount:gPeel.floaters.length,stillReady:peel.prestigeMana>=peel.prestigeMaxMana};
const mainSource=readFileSync(new URL('../game/main.js',import.meta.url),'utf8');
const gameSource=readFileSync(new URL('../game/game.js',import.meta.url),'utf8');
const costHead=mainSource.match(/const RARITY_UPGRADE_COST_HEAD = [^;]+;/)[0];
const costFunction=mainSource.slice(mainSource.indexOf('function getRarityUpgradeCostForLevel('),mainSource.indexOf('function getRarityUpgradeTotalSpent('));
const costs=runInNewContext(`${costHead}\n${costFunction}\nArray.from({length:8},(_,i)=>getRarityUpgradeCostForLevel(i));`);
out.rarity={costs,totalCost:costs.reduce((a,b)=>a+b,0),maxEarnableStars:MAP_POOL.length*5,level8:getSpecialRarityTableAtLevel(8)};
out.poisonRepeatClock=[];
for(const speed of [1,3]) {
    let hits=0;
    let simTime=0;
    const e={x:0,y:0,dead:false,reachedExit:false};
    const p=new FreeProjectile(0,0,10,0,1,{},null,{passRadiusTiles:2,onPass:()=>hits++,passRepeatSec:0.07});
    for(let i=0;i<180/speed;i++) {
      simTime+=speed/60;
      p.applyPassEffects({enemies:[e],simTime});
    }
    out.poisonRepeatClock.push({speed,simulatedSeconds:3,realSeconds:3/speed,hits});
}
out.devTools = {
  default: isDevToolsEnabled(),
  empty: isDevToolsEnabled(""),
  disabled: isDevToolsEnabled("?devtools=0"),
  enabled: isDevToolsEnabled("?devtools=1"),
  extraParams: isDevToolsEnabled("?map=1&devtools=1")
};
setRandomSeed(0x12345678);
const rngA = [random(), random(), random(), random()];
setRandomSeed(0x12345678);
const rngB = [random(), random(), random(), random()];
out.deterministicRng = { sameSequence: JSON.stringify(rngA) === JSON.stringify(rngB), seed: 0x12345678 };

for (const sample of out.attackTiming) {
  assert.ok(Math.abs(sample.shots - sample.idealShots) <= 1, `attack cadence mismatch at ${sample.fps} FPS / ${sample.speed}x`);
}
assert.deepEqual(out.dotAtExit, {dead:true,reachedExit:false,coreHP:25,gold:168}, "DOT death must not damage the Core");
assert.equal(out.tutorialPositions.every(x => x.archerBuildable && x.mageBuildable), true, "tutorial positions must be buildable on every map");
assert.equal(out.zeroExit.actual.x, 0, "zero exit x coordinate must be preserved");
assert.equal(out.zeroExit.actual.y, 0, "zero exit y coordinate must be preserved");
assert.equal(out.cleanse.rootTime, 0, "Cleanse must remove root state");
assert.equal(out.restartBuff.timeLeft, 0, "Restart must clear temporary wave gold buff");
assert.equal(out.peelNoEligibleTarget.noticeCount, 0, "Peel must not notify when no prestige target exists");
assert.ok(out.magicDamage.every(x => x.result >= 0), "magic damage must never become negative");
assert.ok(Math.abs(out.blizzardPulse.actual - out.blizzardPulse.expected) < 1e-9, "Blizzard pulse must apply Magic multipliers once");
assert.ok(new Set(out.earlyIntervals.map(x => x.seconds.toFixed(6))).size >= 4, "early wave pacing must not be flattened by the clamp");
const wave105 = out.wavePressure.find(row => row.wave === 105);
const wave106 = out.wavePressure.find(row => row.wave === 106);
assert.ok(wave106.nonBossHP >= wave105.nonBossHP * 0.95, "wave 106 must not lose a large share of wave 105 non-boss HP when the endless cap grows");
assert.ok(wave106.nonBossHP <= wave105.nonBossHP * 1.30, "wave 106 must remain a controlled continuation of wave 105 pressure");
assert.equal(new Set(out.travelTiming.filter(x=>x.speed===1).map(x=>`${x.pathIndex}:${x.x}:${x.y}`)).size, 1, "movement must be FPS-independent at 1x");
assert.equal(new Set(out.travelTiming.filter(x=>x.speed===3).map(x=>`${x.pathIndex}:${x.x}:${x.y}`)).size, 1, "movement must be FPS-independent at 3x");
assert.equal(new Set(out.spawnTiming.map(x=>x.spawned)).size, 1, "spawn cadence must be FPS-independent");
assert.equal(out.overlappingSave.save.resumeWave, 1, "overlapping waves must save from the earliest safe checkpoint");
assert.deepEqual(out.overlappingSave.after.activeWaves, [1], "continue must not skip the earlier active wave");
assert.equal(out.overlappingSave.after.simTime, 12.5, "continue must preserve the simulation clock");
assert.equal(out.poisonRepeatClock[0].hits, out.poisonRepeatClock[1].hits, "pass effects must use simulation time");
assert.equal(out.devTools.default, false, "headless release context must not enable devtools");
assert.equal(out.devTools.empty, false, "missing devtools flag must stay disabled");
assert.equal(out.devTools.disabled, false, "devtools=0 must stay disabled");
assert.equal(out.devTools.enabled, true, "devtools=1 must explicitly enable devtools");
assert.equal(out.devTools.extraParams, true, "devtools flag must coexist with normal query parameters");
assert.equal(out.deterministicRng.sameSequence, true, "seeded gameplay RNG must reproduce the same sequence");
assert.equal(out.saveBounds.loaded, true, "corrupt save should be recoverable after normalization");
assert.equal(out.saveBounds.map.nameLength, 48, "custom map names must be bounded");
assert.equal(out.saveBounds.map.gridW, 40, "custom map width must be bounded");
assert.equal(out.saveBounds.map.gridH, 30, "custom map height must be bounded");
assert.equal(out.saveBounds.upgrades.count, 4, "saved special upgrades must be capped");
assert.equal(out.saveBounds.upgrades.tierMax, 4, "saved special upgrade tiers must be bounded");
assert.equal(out.saveBounds.upgrades.titleLength, 96, "saved special upgrade titles must be bounded");
assert.deepEqual(out.saveBounds.upgrades.rarityIds, ["common"], "unknown rarity ids must fall back safely");
assert.equal(out.saveBounds.escapedTitle, "&lt;img src=x onerror=alert(1)&gt;", "saved upgrade text must be HTML escaped");
assert.equal(out.saveBounds.save.level, 21, "saved tower level must be bounded to prestige level");
assert.equal(out.saveBounds.save.targetMode, "first", "unknown target modes must fall back safely");
assert.equal(out.saveBounds.save.secondaryLevel, 10000, "saved secondary level must be bounded");
assert.equal(out.saveBounds.save.dmgMul, 10, "saved perk multipliers must be bounded");
assert.equal(out.saveBounds.save.magicMul, 10, "saved magic multipliers must be bounded");
assert.equal(out.towerSpatialCache.rebuilds, 2, "tower spatial index must rebuild only when dirty");
assert.equal(out.towerSpatialCache.dirtyAfterRebuild, false, "tower spatial index must clear its dirty flag");
assert.equal(out.staticMapCache.sameLayer, true, "static map cache must reuse the same layer");
assert.equal(out.staticMapCache.renderCount, 2, "static map layer must redraw only after invalidation");
assert.equal(out.staticMapCache.canvasWidth, 10, "static map cache must match map pixel width");
assert.equal(out.staticMapCache.canvasHeight, 10, "static map cache must match map pixel height");
assert.equal(out.selectedPanelCache.stable, true, "selected HUD panel signature must stay stable when state is unchanged");
assert.equal(out.selectedPanelCache.changesOnGold, true, "selected HUD panel signature must change when button state can change");
assert.equal(out.visualBudget.effects, 320, "visual effect lines must obey their frame budget");
assert.equal(out.visualBudget.floaters, 420, "floating text must obey its frame budget");
assert.equal(out.visualBudget.centerQueue, 24, "center announcements must obey their frame budget");
assert.equal(out.visualSettings.lowEffects, true, "reduced-effects preference must normalize and persist as a boolean");
assert.equal(out.spatialAttack.cleaveShots, 1, "cleave target selection must use the spatial query result");
assert.equal(out.spatialAttack.peelFirstHop, true, "Peel first-hop target selection must use the tower spatial query");
assert.deepEqual(out.prestigeDescriptions.durations.map(row => Number(row.seconds.toFixed(1))), [16.2, 21.6, 17.4, 18.6], "prestige descriptions must use the active-duration source");
assert.deepEqual(out.prestigeDescriptions.mageAura, { manaMultiplier: 8.8, rangeBonus: 1.2 }, "Mage prestige description must use the aura profile");
assert.equal(out.prestigeDescriptions.sniperWave10Gold, 10880, "Carepackage description must use the live payout formula");
assert.match(out.prestigeDescriptions.archer, /16\.2s.*x5\.20/, "Archer Prestige description must match duration and attack-speed multiplier");
assert.match(out.prestigeDescriptions.breaker, /17\.4s.*x1\.45/, "Breaker Prestige description must match duration and damage multiplier");
assert.match(out.prestigeDescriptions.peel, /up to 2 other prestige towers/, "Peel Prestige description must match its two-target behavior");
assert.match(out.prestigeDescriptions.sniper, /10\.9K Gold at Wave 10/, "Sniper Prestige description must show the live wave payout");
assert.deepEqual(Array.from(out.rarity.costs), [1, 1, 2, 3, 5, 8, 13, 17], "rarity upgrade cost curve must keep its documented campaign-compatible values");
assert.equal(out.rarity.totalCost, out.rarity.maxEarnableStars, "every rarity upgrade level must be reachable from campaign stars");
assert.deepEqual(TUTORIAL_STEP_ORDER, ["archer_place_intro", "start_wave_intro", "archer_upgrade_intro"], "the first-map tutorial must keep its focused placement, start and upgrade flow");
assert.equal(out.tutorialFlow.firstMap, true, "tutorial must be eligible for the first campaign map");
assert.equal(out.tutorialFlow.secondMap, false, "tutorial must not run on later campaign maps");
assert.equal(out.tutorialFlow.customMap, false, "tutorial must not run on custom maps");
assert.equal(out.mapBalanceBaseline.length, CONTENT_REGISTRY.maps.count, "every campaign map must have a balance baseline row");
assert.ok(out.mapBalanceBaseline.every(row => row.routeTiles >= 2 && row.buildableTiles > 0 && Number.isFinite(row.targetWave)), "every campaign map must retain a route, build space and target-wave baseline");
assert.ok(out.mapBalanceBaseline.every(row => Object.values(row.baseRangeCoverage).every(coverage => coverage > 0)), "every tower must have at least one valid base-range firing position on every campaign map");
assert.ok(out.mapBalanceBaseline.every(row => row.baseTargetWaveHP > 0 && row.baseTargetWaveGold > 0), "every campaign target wave must have a positive deterministic HP and gold budget");
assert.match(gameSource, /Next upgrade — Mage Prestige/, "Mage level 20 must warn about its support-role Prestige conversion before purchase");
assert.match(gameSource, /permanently stops Mage auto-attacks/, "Mage Prestige warning must state the permanent auto-attack tradeoff");
console.log(JSON.stringify(out,null,2));
