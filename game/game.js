import { CFG } from "./config.js";
import { clamp, dist2, random, setRandomSeed, getRandomState, setRandomState, now, formatCompact, pickN } from "./utils.js";
import { SFX } from "./audio.js";
import { GameMap } from "./map.js";
import { Enemy, FIRST_BOSS_WAVE, FIRST_BOSS_BRIEFING, computePrevWaveTotals, listEnemyModifiers } from "./enemies.js";
import { applyMagicDamage } from "./damage.js";
import { scaleForWave, waveModifiers, wavePlan, WaveState, setEndlessScalingEnabled } from "./waves.js";
import {
  Tower,
  milestoneTier,
  buildChoicesForTower,
  scaledGain,
  upgradeCostCurve,
  peelBuffPower,
  peelBounceCountFromAD,
  magePrestigeAuraProfile
} from "./towers.js";
import { openModal, closeModal, isModalOpen } from "./ui.js";
import { createGameUiAdapter } from "./ui_adapter.js";
import { ARCHER_SPECIALIZATION_LEVEL, focusBonusPercent } from "./archer_specialization.js";
import { SpatialIndex } from "./spatial_index.js";
import { CONTENT_REGISTRY } from "./content_registry.js";
import { GAME_EVENTS, createEventBus } from "./events.js";
import {
  releaseAnyProjectile,
  releaseAnyEffect,
  releaseEffectRing,
  releaseFloatingText
} from "./projectiles.js";

// Render cadence must not change combat outcomes. The step budget deliberately
// limits catch-up after a suspended tab, while preserving all time inside an
// ordinary delayed frame.
const SIMULATION_STEP_SEC = 1 / 60;
const MAX_FRAME_DELTA_SEC = 0.25;
const MAX_SIMULATION_STEPS_PER_FRAME = 30;
const MAX_SPAWNS_PER_WAVE_STEP = 64;
const VISUAL_BUDGETS = Object.freeze({
  effects: 320,
  floaters: 420,
  centerQueue: 24,
  rings: 180,
  attackFlashes: 96
});

const BOSS_SKILL_INFO = {
  cleanse: { name: "Cleanse", color: "rgba(59,130,246,0.85)" },
  heal: { name: "Heal", color: "rgba(34,197,94,0.88)" },
  summon: { name: "Summon", color: "rgba(168,85,247,0.85)" }
};

const MAP_BG_BY_MAP = {
  0: {
    src: "assets/ARMTD_NEO.png",
    crop: { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
    scale: 1.0
  },
  1: {
    src: "assets/ARTMTD_XENO.png",
    crop: { x: 0.008, y: 0.02, w: 0.993, h: 0.973 },
    scale: 1.05
  },
  2: {
    src: "assets/ARMTD_ELIXIR.png",
    crop: { x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
    scale: 1.0
  }
};

const ARCHER_SPRITE = {
  src: "assets/archer.png"
};

const MAGE_SPRITE = {
  src: "assets/mage.png"
};

const BREAKER_SPRITE = {
  src: "assets/breaker.png"
};

const BLIZZARD_SPRITE = {
  src: "assets/blizzard.png"
};

const POISON_SPRITE = {
  src: "assets/poison.png"
};

const SNIPER_SPRITE = {
  src: "assets/sniper.png"
};

const PEEL_SPRITE = {
  src: "assets/peel.png"
};

const PEEL_BUFF_INFO = {
  ad: { name: "AD", color: "rgba(239,68,68,0.95)" },
  as: { name: "AS", color: "rgba(34,197,94,0.95)" },
  rng: { name: "RANGE", color: "rgba(251,146,60,0.95)" },
  mag: { name: "MAGIC", color: "rgba(99,102,241,0.95)" },
  purge: { name: "PURGE", color: "rgba(14,165,233,0.95)" }
};

// Versioning: patch (right) for every update, minor (middle) for big updates.
// Major (left) is increased manually.
const GAME_VERSION = "0.6.33";
const START_GOLD_BASE = 150;
const START_GOLD_REWARD_KEY = "armtd_start_gold_reward_v1";
const START_CORE_HP = 25;
const RUN_SAVE_SCHEMA = 2;
const RUN_SAVE_MIN_SUPPORTED_SCHEMA = 1;
const MAX_SAVE_NUMBER = 1e12;
const MAX_SAVE_WAVE = 10000;
const MAX_SAVED_TOWERS = 256;
const MAX_SPECIAL_UPGRADES = 4;
const MAX_SAVE_TEXT = 96;
const PERSISTENT_STATS_KEY = "armtd_stats_lifetime_v1";
const TOWER_DEF_BY_ID = CONTENT_REGISTRY.towers.byId;
const VALID_TARGET_MODES = new Set(["first", "last", "strongest", "pure", "random"]);
const VALID_RARITY_IDS = new Set(["common", "uncommon", "rare", "epic", "legendary", "mythical"]);

function getStartingGold(){
  try {
    return localStorage.getItem(START_GOLD_REWARD_KEY) === "1" ? 180 : START_GOLD_BASE;
  } catch (_) {
    return START_GOLD_BASE;
  }
}

function buildTowerCounter(seed = 0){
  const out = {};
  for (const def of CONTENT_REGISTRY.towers.list) out[def.id] = seed;
  return out;
}

function clampNumber(v, min=0, fallback=0){
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, n);
}

function boundedNumber(v, min, max, fallback=min){
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function boundedText(v, fallback="", maxLength=MAX_SAVE_TEXT){
  const text = String(v ?? fallback)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim();
  return (text || fallback).slice(0, maxLength);
}

function escapeHtmlText(value){
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeTargetMode(raw){
  const mode = String(raw || "first");
  return VALID_TARGET_MODES.has(mode) ? mode : "first";
}

function normalizeSpecialUpgrades(raw){
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_SPECIAL_UPGRADES).map(upg => ({
    tier: Math.floor(boundedNumber(upg?.tier, 1, 4, 1)),
    title: boundedText(upg?.title, "", MAX_SAVE_TEXT),
    rarityId: VALID_RARITY_IDS.has(String(upg?.rarityId || ""))
      ? String(upg.rarityId)
      : "common"
  }));
}

function normalizeGridCell(v){
  const n = Math.floor(Number(v) || 0);
  if (n === 1 || n === 2) return n;
  return 0;
}

function compactInPlace(arr, keep, onDrop){
  let w = 0;
  for (let r = 0; r < arr.length; r += 1) {
    const item = arr[r];
    if (!keep(item, r)) {
      if (onDrop) onDrop(item, r);
      continue;
    }
    if (w !== r) arr[w] = item;
    w += 1;
  }
  arr.length = w;
  return arr;
}

function addRoundRectPath(ctx, x, y, w, h, r){
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.rect(x, y, w, h);
}

function createEmptyRunStats(){
  return {
    totalKills: 0,
    totalDamage: 0,
    totalOverkill: 0,
    maxSingleHit: 0,
    maxWaveSeen: 0,
    towerBuildCounts: buildTowerCounter(0),
    towerKillCounts: buildTowerCounter(0),
    towerDamage: buildTowerCounter(0),
    towerOverkill: buildTowerCounter(0),
    supportBuffEvents: 0,
    supportBuffSeconds: 0,
    supportGold: 0
  };
}

function readPersistentStats(){
  try {
    const raw = localStorage.getItem(PERSISTENT_STATS_KEY);
    if (!raw) return createEmptyRunStats();
    return normalizeRunStats(JSON.parse(raw));
  } catch (_) {
    return createEmptyRunStats();
  }
}

function writePersistentStats(stats){
  try {
    localStorage.setItem(PERSISTENT_STATS_KEY, JSON.stringify(normalizeRunStats(stats)));
  } catch (_) {}
}

function createEmptyRunQuestState(){
  return {
    coreDamaged: false,
    sniperPurchased: false,
    uniqueTowerTypesOnly: true,
    noPrestigeUnlocked: true,
    campaignCleared: false,
    clearedAtWave: 0
  };
}

function normalizeTowerCounter(raw){
  const out = buildTowerCounter(0);
  if (!raw || typeof raw !== "object") return out;
  for (const def of CONTENT_REGISTRY.towers.list) {
    out[def.id] = Math.floor(boundedNumber(raw[def.id], 0, MAX_SAVE_NUMBER, 0));
  }
  return out;
}

function normalizeRunStats(raw){
  const base = createEmptyRunStats();
  if (!raw || typeof raw !== "object") return base;
  base.totalKills = Math.floor(boundedNumber(raw.totalKills, 0, MAX_SAVE_NUMBER, 0));
  base.totalDamage = boundedNumber(raw.totalDamage, 0, MAX_SAVE_NUMBER, 0);
  base.totalOverkill = boundedNumber(raw.totalOverkill, 0, MAX_SAVE_NUMBER, 0);
  base.maxSingleHit = boundedNumber(raw.maxSingleHit, 0, MAX_SAVE_NUMBER, 0);
  base.maxWaveSeen = Math.floor(boundedNumber(raw.maxWaveSeen, 0, MAX_SAVE_WAVE, 0));
  base.towerBuildCounts = normalizeTowerCounter(raw.towerBuildCounts);
  base.towerKillCounts = normalizeTowerCounter(raw.towerKillCounts);
  base.towerDamage = normalizeTowerCounter(raw.towerDamage);
  base.towerOverkill = normalizeTowerCounter(raw.towerOverkill);
  base.supportBuffEvents = Math.floor(boundedNumber(raw.supportBuffEvents, 0, MAX_SAVE_NUMBER, 0));
  base.supportBuffSeconds = boundedNumber(raw.supportBuffSeconds, 0, MAX_SAVE_NUMBER, 0);
  base.supportGold = boundedNumber(raw.supportGold, 0, MAX_SAVE_NUMBER, 0);
  return base;
}

function normalizeRunQuestState(raw){
  const base = createEmptyRunQuestState();
  if (!raw || typeof raw !== "object") return base;
  base.coreDamaged = !!raw.coreDamaged;
  base.sniperPurchased = !!raw.sniperPurchased;
  base.uniqueTowerTypesOnly = raw.uniqueTowerTypesOnly !== false;
  base.noPrestigeUnlocked = raw.noPrestigeUnlocked !== false;
  base.campaignCleared = !!raw.campaignCleared;
  base.clearedAtWave = Math.floor(boundedNumber(raw.clearedAtWave, 0, MAX_SAVE_WAVE, 0));
  return base;
}

function normalizeMapDef(raw){
  if (!raw || typeof raw !== "object") return null;
  const gridW = Math.max(4, Math.min(40, Math.floor(clampNumber(raw.gridW, 4, 20))));
  const gridH = Math.max(4, Math.min(30, Math.floor(clampNumber(raw.gridH, 4, 15))));
  const srcGrid = Array.isArray(raw.grid) ? raw.grid : [];
  const grid = Array.from({ length: gridH }, (_, y) => {
    const row = Array.isArray(srcGrid[y]) ? srcGrid[y] : [];
    return Array.from({ length: gridW }, (_, x) => normalizeGridCell(row[x]));
  });
  const entrance = {
    x: Math.max(0, Math.min(gridW - 1, Math.floor(clampNumber(raw.entrance?.x, 0, 0)))),
    y: Math.max(0, Math.min(gridH - 1, Math.floor(clampNumber(raw.entrance?.y, 0, 0))))
  };
  const exit = {
    x: Math.max(0, Math.min(gridW - 1, Math.floor(clampNumber(raw.exit?.x, 0, gridW - 1)))),
    y: Math.max(0, Math.min(gridH - 1, Math.floor(clampNumber(raw.exit?.y, 0, gridH - 1))))
  };
  grid[entrance.y][entrance.x] = 1;
  grid[exit.y][exit.x] = 1;
  return {
    name: boundedText(raw.name, "Custom Map", 48),
    gridW,
    gridH,
    entrance,
    exit,
    grid,
    hazards: []
  };
}

function getCampaignMapCount(){
  return Math.max(1, Math.floor(Number(CONTENT_REGISTRY.maps.count) || 0));
}

function clampCampaignMapIndex(raw){
  const max = Math.max(0, getCampaignMapCount() - 1);
  return Math.min(max, Math.max(0, Math.floor(clampNumber(raw, 0, 0))));
}

function getCampaignTargetWaveByMapIndex(mapIndex){
  const fromRegistry = (typeof CONTENT_REGISTRY?.maps?.getTargetWaveByMapIndex === "function")
    ? CONTENT_REGISTRY.maps.getTargetWaveByMapIndex(mapIndex)
    : null;
  if (Number.isFinite(fromRegistry)) return Math.max(1, Math.floor(fromRegistry));
  const idx = clampCampaignMapIndex(mapIndex);
  return Math.max(100, 100 + idx * 5);
}

function getCampaignMapDef(rawIndex){
  const safe = clampCampaignMapIndex(rawIndex);
  return CONTENT_REGISTRY.maps.get(safe) || CONTENT_REGISTRY.maps.get(0);
}

function createRunSaveMeta(raw){
  const src = raw && typeof raw === "object" ? raw : {};
  const migratedFromSchema = Number.isFinite(Number(src.migratedFromSchema))
    ? Math.floor(Number(src.migratedFromSchema))
    : null;
  const migratedAt = Number.isFinite(Number(src.migratedAt))
    ? Math.floor(Number(src.migratedAt))
    : null;
  return {
    source: boundedText(src.source, "runtime", 32),
    migratedFromSchema: Number.isFinite(migratedFromSchema)
      ? Math.max(0, Math.min(RUN_SAVE_SCHEMA, migratedFromSchema))
      : null,
    migratedAt: Number.isFinite(migratedAt)
      ? Math.max(0, Math.min(Date.now(), migratedAt))
      : null
  };
}

function migrateRunSaveV1ToV2(raw){
  if (!raw || typeof raw !== "object") return null;
  const base = { ...raw };
  base.schema = 2;
  base.gameVersion = String(base.gameVersion || "unknown");
  base.savedAt = Math.floor(clampNumber(base.savedAt, 0, Date.now()));
  base.meta = createRunSaveMeta({
    source: "runtime",
    migratedFromSchema: 1,
    migratedAt: Date.now()
  });
  return base;
}

function migrateRunSaveToCurrent(raw){
  if (!raw || typeof raw !== "object") return null;
  const schema = Math.floor(clampNumber(raw.schema, 0, 0));
  if (schema > RUN_SAVE_SCHEMA || schema < RUN_SAVE_MIN_SUPPORTED_SCHEMA) return null;
  if (schema === RUN_SAVE_SCHEMA) return raw;
  let out = raw;
  let cursor = schema;
  while (cursor < RUN_SAVE_SCHEMA) {
    if (cursor === 1) {
      out = migrateRunSaveV1ToV2(out);
      cursor = 2;
      continue;
    }
    return null;
  }
  return out;
}

function normalizeRunSaveData(raw){
  const migrated = migrateRunSaveToCurrent(raw);
  if (!migrated || typeof migrated !== "object") return null;
  const customMapDef = normalizeMapDef(migrated.customMapDef);
  const isCustomMapRun = !!migrated.isCustomMapRun && !!customMapDef;
  const stats = normalizeRunStats(migrated.stats);
  const totalKills = Math.floor(boundedNumber(migrated.totalKills, 0, MAX_SAVE_NUMBER, 0));
  stats.totalKills = Math.max(stats.totalKills, totalKills);
  return {
    schema: RUN_SAVE_SCHEMA,
    gameVersion: boundedText(migrated.gameVersion, "unknown", 32),
    savedAt: Math.floor(boundedNumber(migrated.savedAt, 0, Date.now(), 0)),
    mapIndex: clampCampaignMapIndex(migrated.mapIndex),
    gold: Math.floor(clampNumber(migrated.gold, 0, getStartingGold())),
    coreHP: clampNumber(migrated.coreHP, 0, START_CORE_HP),
    totalKills: Math.min(MAX_SAVE_NUMBER, totalKills),
    resumeWave: Math.floor(boundedNumber(migrated.resumeWave, 0, MAX_SAVE_WAVE, 0)),
    started: !!migrated.started,
    endlessMode: !!migrated.endlessMode,
    simTime: boundedNumber(migrated.simTime, 0, MAX_SAVE_NUMBER, 0),
    rngState: Number(migrated.rngState) >>> 0,
    isCustomMapRun,
    customMapDef: isCustomMapRun ? customMapDef : null,
    towers: Array.isArray(migrated.towers) ? migrated.towers.slice(0, MAX_SAVED_TOWERS) : [],
    stats,
    questState: normalizeRunQuestState(migrated.questState),
    meta: createRunSaveMeta(migrated.meta)
  };
}

class Game {
    constructor(canvas){
      this.rngSeed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
      setRandomSeed(this.rngSeed);
      this.cv=canvas;
      this.ctx=canvas.getContext("2d");

      this.mapIndex=0;
      this.map=new GameMap(getCampaignMapDef(this.mapIndex));
      this.isCustomMapRun = false;
      this.useMapBackground = true;

      this.gold=getStartingGold();
      this.coreHP=START_CORE_HP;
      this.totalKills=0;

      this.currentWave = 0;
      this.nextWaveNum = 1;
      this.wavesActive = [];

      this.started=false;
      this.autoQueueDelay=0.35;
      this.autoQueueTimer=0;

      this.towers=[];
      this.enemies=[];
      this.projectiles=[];
      this.effects=[];
      this.rings=[];
      this.attackFlashes=[];
      this._attackFlashCursor=0;
      this.enemySpatial = new SpatialIndex(1.5);
      this.towerSpatial = new SpatialIndex(1.5);
      this._towerSpatialDirty = true;
      this._enemyRangeScratch = [];
      this._towerRangeScratch = [];

      this.floaters=[];        // damage/gold text (enemy Ã¼zerinde)
      this.centerQueue=[];     // ekran ortasÄ± ardÄ±ÅŸÄ±k yazÄ±lar
      this.deferredActions=[]; // delayed gameplay steps (chain/bounce)

      this.selectedTowerDef=null;
      this.selectedTowerInstance=null;
      this.selectedEnemy=null;
      this.hoverGrid=null;

      this.gameSpeed=1.0;
      this.simTime = 0;
      this._simulationAccumulator = 0;
      this._resizeDirty = true;
      this._resizeMapKey = "";
      this.prevSpeedBeforeModal=1.0;
      this.screenShakeTime = 0;
      this.screenShakeMaxTime = 0;
      this.screenShakePower = 0;

      this.gameOver=false;
      this.gameOverInspectMode = false;
      this.highKills=[];

      this.anyBreakerPrestigeActive = false;
      this.anyBlizzardPrestigeActive = false;
      this.peelUplinkCastsByWave = {};
      this.lastUplinkRewardWave = 0;
      this.waveEndUplinkNotice = null;
      this.carepackageNotice = null;
      this.waveStartCheckpoint = null;
      this.nextWaveNowGoldBuff = { mult: 1, timeLeft: 0, maxTime: 0 };
      this._prevWaveActive = false;
      this.endlessMode = false;
      this.campaignWinShown = false;
      this.winModalOpen = false;
      this.runStartMs = performance.now();
      this.runClearSec = 0;
      this._lastLoadMigrationFromSchema = null;
      this.runStats = createEmptyRunStats();
      this.lifetimeStats = readPersistentStats();
      this.runQuestState = createEmptyRunQuestState();
      this._campaignClearNotified = false;
      this.onCampaignClear = null;
      this.events = createEventBus();
      this.tutorialHooks = { canAction: null, onAction: null, shouldUseScriptedSpecialChoice: null };
      this.tutorialSpecialChoicePending = true;
      setEndlessScalingEnabled(false);

      this.uiAdapter = createGameUiAdapter(document);
      const ui = this.uiAdapter.refs;
      this.logEl = ui.logLines;
      this.logMax = 80;
      this.logTitleEl = ui.hudLogTitle;
      this._startLogged = false;
      this.hoverSpecialChoice = null;
      this.uiHover = { upgrade:false, fast:false };
      // UI refresh throttling: avoid rebuilding large DOM panels every frame.
      this._uiDirty = true;
      this._uiRefreshTimer = 0;
      this._uiRefreshInterval = 1 / 12;
      this._selectedPanelSignature = null;
      this._selectedPanelObjectIds = new WeakMap();
      this._selectedPanelObjectNextId = 1;
      // Lifetime stats persistence throttling: avoid localStorage writes on every hit/kill.
      this._statsDirty = false;
      this._statsFlushTimer = 0;
      this._statsFlushInterval = 1.0;
      this._perfAcc = {
        sec: 0,
        frames: 0,
        framePacingMs: 0,
        framePacingSamples: [],
        jsFrameMs: 0,
        updateMs: 0,
        drawMs: 0,
        uiMs: 0
      };
      this._fpsAcc = { sec: 0, frames: 0, label: "--" };
      this.menuVisibility = null;
      this.seenModifierIds = new Set();
      this.modifierIntroOpen = false;
      this.modifierIntroPrevSpeed = 1.0;
      this.infoModalsEnabled = true;
      this.modifierIntroAutoCloseTimer = null;
      this.modifierIntroBack = ui.modifierIntroBack;
      this.modifierIntroTitle = ui.modifierIntroTitle;
      this.modifierIntroText = ui.modifierIntroText;
      this.modifierIntroIcon = ui.modifierIntroIcon;
      this.modifierIntroCloseBtn = ui.modifierIntroClose;
      if (this.modifierIntroCloseBtn) {
        this.modifierIntroCloseBtn.onclick = () => this.closeModifierIntro();
      }
      this.winBack = ui.winBack;
      this.winTime = ui.winTime;
      this.winEndBtn = ui.winEndBtn;
      this.winEndlessBtn = ui.winEndlessBtn;
      if (this.winEndBtn) this.winEndBtn.onclick = () => this.endRunAfterWin();
      if (this.winEndlessBtn) this.winEndlessBtn.onclick = () => this.enterEndlessMode();
      this.gameOverBack = ui.gameOverBack;
      this.gameOverRestartBtn = ui.gameOverRestartBtn;
      this.gameOverInspectBtn = ui.gameOverInspectBtn;
      this.gameOverMainMenuBtn = ui.gameOverMainMenuBtn;
      this.hudGoldEl = ui.hudGold;
      this.hudCoreHpEl = ui.hudCoreHp;
      this.hudKillsEl = ui.hudKills;
      this.hudWaveEl = ui.hudWave;
      this.hudMobsEl = ui.hudMobs;
      this.mapNameEl = ui.mapName;
      this.mapWipBannerEl = ui.mapWipBanner;
      this.startWaveBtnEl = ui.startWaveBtn;
      this.nextWaveNowBtnEl = ui.nextWaveNowBtn;
      this.selectedInfoHudEl = ui.selectedInfoHud;
      this.upgradeBtnHudEl = ui.upgradeBtnHud;
      this.fastUpgradeBtnHudEl = ui.fastUpgradeBtnHud;
      this.sellBtnHudEl = ui.sellBtnHud;
      this.onGameOverMainMenu = null;
      if (this.gameOverRestartBtn) this.gameOverRestartBtn.onclick = () => this.restart();
      if (this.gameOverInspectBtn) this.gameOverInspectBtn.onclick = () => this.enterGameOverInspectMode();
      if (this.gameOverMainMenuBtn) {
        this.gameOverMainMenuBtn.onclick = () => {
          this.hideGameOverModal();
          this.emitGameEvent(GAME_EVENTS.GAME_OVER_MAIN_MENU, {
            waveNum: Math.max(0, this.currentWave || 0),
            totalKills: Math.max(0, this.totalKills || 0)
          });
          if (typeof this.onGameOverMainMenu === "function") this.onGameOverMainMenu();
        };
      }

      this.mapBg = new Image();
      this.mapBgReady = false;
      this.mapBg.onload = () => {
        this.mapBgReady = true;
        this.invalidateStaticMapCache();
      };
      this.staticMapCanvas = (typeof document !== "undefined" && typeof document.createElement === "function")
        ? document.createElement("canvas")
        : null;
      this.staticMapCtx = this.staticMapCanvas?.getContext?.("2d") || null;
      this._staticMapCacheKey = "";
      this._staticMapRenderCount = 0;
      this.refreshMapBackground();

      this.archerSprite = new Image();
      this.archerSpriteReady = false;
      this.archerSprite.onload = () => { this.archerSpriteReady = true; };
      this.archerSprite.src = ARCHER_SPRITE.src;

      this.mageSprite = new Image();
      this.mageSpriteReady = false;
      this.mageSprite.onload = () => { this.mageSpriteReady = true; };
      this.mageSprite.src = MAGE_SPRITE.src;

      this.breakerSprite = new Image();
      this.breakerSpriteReady = false;
      this.breakerSprite.onload = () => { this.breakerSpriteReady = true; };
      this.breakerSprite.src = BREAKER_SPRITE.src;

      this.blizzardSprite = new Image();
      this.blizzardSpriteReady = false;
      this.blizzardSprite.onload = () => { this.blizzardSpriteReady = true; };
      this.blizzardSprite.src = BLIZZARD_SPRITE.src;

      this.poisonSprite = new Image();
      this.poisonSpriteReady = false;
      this.poisonSprite.onload = () => { this.poisonSpriteReady = true; };
      this.poisonSprite.src = POISON_SPRITE.src;

      this.sniperSprite = new Image();
      this.sniperSpriteReady = false;
      this.sniperSprite.onload = () => { this.sniperSpriteReady = true; };
      this.sniperSprite.src = SNIPER_SPRITE.src;

      this.peelSprite = new Image();
      this.peelSpriteReady = false;
      this.peelSprite.onload = () => { this.peelSpriteReady = true; };
      this.peelSprite.src = PEEL_SPRITE.src;

      this.resizeCanvasToDisplaySize(true);
      window.addEventListener("resize", ()=>{
        this._resizeDirty = true;
        this.resizeCanvasToDisplaySize(true);
      });
      window.addEventListener("beforeunload", () => this.persistLifetimeStats(true));

      this.lastT=now();
      SFX.bindAutoUnlock();
      this.bindInput();
      this.refreshUI(true);
      if (this.logTitleEl) this.logTitleEl.textContent = `Log ${GAME_VERSION}`;
      this.logEvent(`Build ${GAME_VERSION} loaded.`);
      this.logEvent("Shortcuts enabled. Ready.");
      this.loop();
    }

    getMapBackgroundDef(){
      return MAP_BG_BY_MAP[this.mapIndex] || null;
    }

    getCurrentCampaignCardMeta(){
      if (this.isCustomMapRun) return null;
      const catalog = (typeof CONTENT_REGISTRY?.maps?.getCampaignCatalog === "function")
        ? CONTENT_REGISTRY.maps.getCampaignCatalog()
        : [];
      if (!Array.isArray(catalog)) return null;
      return catalog.find((row) => Number(row?.mapIndex) === this.mapIndex) || null;
    }

    refreshMapWipBanner(){
      const bannerEl = this.mapWipBannerEl;
      if (!bannerEl) return;
      const mapMeta = this.getCurrentCampaignCardMeta();
      const visible = !!mapMeta?.wip;
      bannerEl.classList.toggle("hidden", !visible);
      if (!visible) return;
      const dpr = window.devicePixelRatio || 1;
      const tileCss = Math.max(28, Math.round((this.tileSize || 0) / dpr));
      bannerEl.style.height = `${tileCss}px`;
      bannerEl.style.lineHeight = `${tileCss}px`;
      bannerEl.style.fontSize = `${Math.max(12, Math.round(tileCss * 0.42))}px`;
    }

    refreshMapBackground(){
      const bgDef = this.getMapBackgroundDef();
      this.refreshMapWipBanner();
      this.invalidateStaticMapCache();
      this.mapBgReady = false;
      if (!bgDef?.src) {
        this.mapBg.removeAttribute("src");
        return;
      }
      this.mapBgReady = false;
      this.mapBg.src = bgDef.src;
    }

    invalidateStaticMapCache(){
      this._staticMapCacheKey = "";
    }

    canPrestigeUpgrade(tower){
      // New rule: no global condition. Only 1 prestige tower per type is allowed.
      if (!tower) return true;
      return !this.towers.some(t =>
        t !== tower &&
        t.def.id === tower.def.id &&
        t.level >= CFG.PRESTIGE_LEVEL
      );
    }

    clearSelection(){
      this.selectedTowerInstance = null;
      this.selectedEnemy = null;
      this.hoverGrid = null;
    }

    clearPlacement(){
      this.selectedTowerDef = null;
      this.hoverGrid = null;
    }

    deferAction(delaySec, fn){
      if (typeof fn !== "function") return;
      this.deferredActions.push({
        t: Math.max(0, Number(delaySec) || 0),
        fn
      });
    }

    syncSpeedUI(v){
      this.uiAdapter.syncSpeed(v);
    }

    setTutorialHooks(hooks = {}){
      this.tutorialHooks = {
        canAction: (typeof hooks?.canAction === "function") ? hooks.canAction : null,
        onAction: (typeof hooks?.onAction === "function") ? hooks.onAction : null,
        shouldUseScriptedSpecialChoice: (typeof hooks?.shouldUseScriptedSpecialChoice === "function")
          ? hooks.shouldUseScriptedSpecialChoice
          : null
      };
    }

    shouldUseTutorialScriptedSpecialChoice(){
      const fn = this.tutorialHooks?.shouldUseScriptedSpecialChoice;
      if (typeof fn !== "function") return false;
      try {
        return fn(this) === true;
      } catch (_) {
        return false;
      }
    }

    canRunTutorialAction(actionId, payload = {}){
      const fn = this.tutorialHooks?.canAction;
      if (typeof fn !== "function") return true;
      try {
        return fn(String(actionId || ""), payload || {}, this) !== false;
      } catch (_) {
        return true;
      }
    }

    notifyTutorialAction(actionId, payload = {}){
      const fn = this.tutorialHooks?.onAction;
      if (typeof fn !== "function") return;
      try {
        fn(String(actionId || ""), payload || {}, this);
      } catch (_) {}
    }

    addScreenShake(power=0.06, duration=0.20){
      const p = Math.max(0, Number(power) || 0);
      const d = Math.max(0, Number(duration) || 0);
      if (p <= 0 || d <= 0) return;
      this.screenShakePower = Math.max(this.screenShakePower, p);
      this.screenShakeTime = Math.max(this.screenShakeTime, d);
      this.screenShakeMaxTime = Math.max(this.screenShakeMaxTime, this.screenShakeTime);
    }

    // A short-lived, render-only record made when a tower fires. It is kept in
    // a fixed-size buffer so high attack speed cannot grow transient memory.
    spawnAttackFlash(tower, target, visual = {}, isCritical = false){
      if (!tower || !target) return;
      const limit = this.getVisualBudget("attackFlashes");
      if (limit <= 0) return;

      if (this.attackFlashes.length > limit) {
        this.attackFlashes.length = limit;
        this._attackFlashCursor %= Math.max(1, limit);
      }

      let flash = this.attackFlashes.find(item => !item || item.life <= 0);
      if (!flash && this.attackFlashes.length < limit) {
        flash = {};
        this.attackFlashes.push(flash);
      }
      if (!flash) {
        const index = this._attackFlashCursor % Math.max(1, this.attackFlashes.length);
        flash = this.attackFlashes[index];
        this._attackFlashCursor = (index + 1) % Math.max(1, this.attackFlashes.length);
      }

      const dx = (Number(target.x) || 0) - (Number(tower.x) || 0);
      const dy = (Number(target.y) || 0) - (Number(tower.y) || 0);
      const length = Math.hypot(dx, dy) || 1;
      const life = isCritical ? 0.14 : 0.105;
      flash.x = Number(tower.x) || 0;
      flash.y = Number(tower.y) || 0;
      flash.dx = dx / length;
      flash.dy = dy / length;
      flash.color = (typeof visual?.color === "string" && visual.color) || "rgba(255,255,255,0.92)";
      flash.kind = tower.def?.id || "generic";
      flash.isCritical = !!isCritical;
      flash.life = life;
      flash.maxLife = life;
    }

    updateAttackFlashes(dt){
      const safeDt = Math.max(0, Number(dt) || 0);
      const limit = this.getVisualBudget("attackFlashes");
      if (this.attackFlashes.length > limit) {
        this.attackFlashes.length = limit;
        this._attackFlashCursor %= Math.max(1, limit);
      }
      for (const flash of this.attackFlashes) {
        if (flash?.life > 0) flash.life = Math.max(0, flash.life - safeDt);
      }
    }

    getScreenShakeOffset(){
      if (this.screenShakeTime <= 0 || this.screenShakePower <= 0) return { x: 0, y: 0 };
      const fade = (this.screenShakeMaxTime > 0)
        ? clamp(this.screenShakeTime / this.screenShakeMaxTime, 0, 1)
        : 0;
      const amp = this.tileSize * this.screenShakePower * fade;
      // Screen shake is visual-only. It must not advance the seeded combat RNG,
      // otherwise the same run diverges with a different render cadence.
      const a = Math.random() * Math.PI * 2;
      return { x: Math.cos(a) * amp, y: Math.sin(a) * amp };
    }

    drawModifierIntroIcon(modifier){
      if (!this.modifierIntroIcon) return;
      const c = this.modifierIntroIcon;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, c.width, c.height);
      const cx = c.width * 0.5;
      const cy = c.height * 0.5;
      const size = Math.min(c.width, c.height) * 0.34;
      if (modifier?.iconKind === "affix") {
        this.drawAffixIcon(ctx, modifier.iconId, cx, cy, size);
      } else {
        this.drawStatusIcon(ctx, modifier?.iconId || "resist", cx, cy, size);
      }
    }

    showModifierIntro(modifier){
      if (!this.infoModalsEnabled) return;
      if (!modifier || !this.modifierIntroBack || this.modifierIntroOpen) return;
      this.modifierIntroOpen = true;
      this.modifierIntroPrevSpeed = this.gameSpeed;
      this.gameSpeed = 0;
      this.syncSpeedUI(0);
      if (this.modifierIntroTitle) this.modifierIntroTitle.textContent = `New Modifier: ${modifier.name}`;
      if (this.modifierIntroText) this.modifierIntroText.textContent = modifier.desc || "This modifier changes enemy behavior.";
      this.drawModifierIntroIcon(modifier);
      this.modifierIntroBack.style.display = "flex";
      if (this.modifierIntroAutoCloseTimer) clearTimeout(this.modifierIntroAutoCloseTimer);
      this.modifierIntroAutoCloseTimer = setTimeout(() => this.closeModifierIntro(), 5000);
    }

    closeModifierIntro(){
      if (!this.modifierIntroOpen) return;
      this.modifierIntroOpen = false;
      if (this.modifierIntroAutoCloseTimer) {
        clearTimeout(this.modifierIntroAutoCloseTimer);
        this.modifierIntroAutoCloseTimer = null;
      }
      if (this.modifierIntroBack) this.modifierIntroBack.style.display = "none";
      this.gameSpeed = this.modifierIntroPrevSpeed;
      this.syncSpeedUI(this.gameSpeed);
    }

    saveHighKills(){
      const key="td_highkills_v2";
      let arr=[];
      try{ arr=JSON.parse(localStorage.getItem(key)||"[]"); }catch{}
      arr.push(this.totalKills);
      arr = arr.filter(n=>Number.isFinite(n)).map(n=>Math.floor(n));
      arr.sort((a,b)=>b-a);
      arr = arr.slice(0,10);
      localStorage.setItem(key, JSON.stringify(arr));
      this.highKills = arr;
    }

    resetRunStats(){
      this.runStats = createEmptyRunStats();
    }

    persistLifetimeStats(force=false){
      if (!force) {
        this._statsDirty = true;
        return;
      }
      writePersistentStats(this.lifetimeStats);
      this._statsDirty = false;
      this._statsFlushTimer = 0;
    }

    resetRunQuestState(){
      this.runQuestState = createEmptyRunQuestState();
      this._campaignClearNotified = false;
    }

    getCampaignTargetWave(){
      if (this.isCustomMapRun) return 100;
      return getCampaignTargetWaveByMapIndex(this.mapIndex);
    }

    evaluateUniqueTowerTypeChallenge(){
      if (!this.runQuestState?.uniqueTowerTypesOnly) return;
      const counts = Object.create(null);
      for (const tower of this.towers) {
        const towerId = tower?.def?.id;
        if (!towerId) continue;
        counts[towerId] = (counts[towerId] || 0) + 1;
        if (counts[towerId] > 1) {
          this.runQuestState.uniqueTowerTypesOnly = false;
          this.logEvent("Challenge failed: duplicate tower type built.");
          return;
        }
      }
    }

    evaluateNoPrestigeChallenge(){
      if (!this.runQuestState?.noPrestigeUnlocked) return;
      for (const tower of this.towers) {
        if (!tower) continue;
        if (Math.max(0, Math.floor(Number(tower.level) || 0)) < CFG.PRESTIGE_LEVEL) continue;
        this.runQuestState.noPrestigeUnlocked = false;
        this.logEvent("Challenge failed: No Prestige (a tower reached Prestige level).");
        return;
      }
    }

    updateMaxWaveSeen(waveNum){
      const wave = Math.floor(clampNumber(waveNum, 0, 0));
      if (wave <= 0) return;
      this.runStats.maxWaveSeen = Math.max(this.runStats.maxWaveSeen, wave);
      this.lifetimeStats.maxWaveSeen = Math.max(this.lifetimeStats.maxWaveSeen, wave);
      this.persistLifetimeStats();
    }

    recordTowerBuilt(towerId, gx = null, gy = null){
      if (!towerId || !this.runStats?.towerBuildCounts) return;
      if (!(towerId in this.runStats.towerBuildCounts)) return;
      this.runStats.towerBuildCounts[towerId] += 1;
      if (towerId in this.lifetimeStats.towerBuildCounts) {
        this.lifetimeStats.towerBuildCounts[towerId] += 1;
        this.persistLifetimeStats();
      }
      this.emitGameEvent(GAME_EVENTS.TOWER_BUILT, {
        towerId: String(towerId),
        gx: Number.isFinite(gx) ? Math.floor(gx) : null,
        gy: Number.isFinite(gy) ? Math.floor(gy) : null,
        runCount: this.runStats.towerBuildCounts[towerId] || 0,
        lifetimeCount: this.lifetimeStats.towerBuildCounts[towerId] || 0
      });
    }

    recordDamage(amount, sourceTower=null, overkill=0){
      const dealt = clampNumber(amount, 0, 0);
      const excess = clampNumber(overkill, 0, 0);
      if (dealt <= 0 && excess <= 0) return;
      this.runStats.totalDamage += dealt;
      this.runStats.totalOverkill += excess;
      this.runStats.maxSingleHit = Math.max(this.runStats.maxSingleHit, dealt);
      this.lifetimeStats.totalDamage += dealt;
      this.lifetimeStats.totalOverkill += excess;
      this.lifetimeStats.maxSingleHit = Math.max(this.lifetimeStats.maxSingleHit, dealt);
      const towerId = sourceTower?.def?.id;
      if (towerId && towerId in this.runStats.towerDamage) {
        this.runStats.towerDamage[towerId] += dealt;
        this.runStats.towerOverkill[towerId] += excess;
      }
      if (towerId && towerId in this.lifetimeStats.towerDamage) {
        this.lifetimeStats.towerDamage[towerId] += dealt;
        this.lifetimeStats.towerOverkill[towerId] += excess;
      }
      this.persistLifetimeStats();
    }

    recordKill(sourceTower=null){
      this.runStats.totalKills = Math.max(this.runStats.totalKills + 1, this.totalKills);
      this.lifetimeStats.totalKills += 1;
      const towerId = sourceTower?.def?.id;
      if (towerId && towerId in this.runStats.towerKillCounts) {
        this.runStats.towerKillCounts[towerId] += 1;
      }
      if (towerId && towerId in this.lifetimeStats.towerKillCounts) {
        this.lifetimeStats.towerKillCounts[towerId] += 1;
      }
      this.persistLifetimeStats();
      this.emitGameEvent(GAME_EVENTS.ENEMY_KILLED, {
        sourceTowerId: towerId ? String(towerId) : null,
        runTotalKills: this.runStats.totalKills,
        lifetimeTotalKills: this.lifetimeStats.totalKills
      });
    }

    getStatsSnapshot(){
      return normalizeRunStats(this.runStats);
    }

    getLifetimeStatsSnapshot(){
      return normalizeRunStats(this.lifetimeStats);
    }

    hardResetPersistentStats(){
      this.lifetimeStats = createEmptyRunStats();
      this.highKills = [];
      this.persistLifetimeStats(true);
      try { localStorage.setItem("td_highkills_v2", "[]"); } catch (_) {}
    }

    getRunQuestSnapshot(){
      return normalizeRunQuestState(this.runQuestState);
    }

    onEvent(eventName, handler){
      return this.events.on(eventName, handler);
    }

    onceEvent(eventName, handler){
      return this.events.once(eventName, handler);
    }

    emitGameEvent(eventName, payload = {}){
      this.events.emit(eventName, {
        event: String(eventName || ""),
        time: performance.now(),
        ...payload
      });
    }

    notifyTowerLevelChanged(tower, fromLevel, reason = "upgrade"){
      if (!tower || !tower.def?.id) return;
      const prevLevel = Math.max(0, Math.floor(Number(fromLevel) || 0));
      const nextLevel = Math.max(0, Math.floor(Number(tower.level) || 0));
      if (nextLevel <= prevLevel) return;
      if (prevLevel < CFG.PRESTIGE_LEVEL && nextLevel >= CFG.PRESTIGE_LEVEL) {
        if (this.runQuestState?.noPrestigeUnlocked) {
          this.runQuestState.noPrestigeUnlocked = false;
          this.logEvent("Challenge failed: No Prestige (a tower reached Prestige level).");
        }
      }
      this.emitGameEvent(GAME_EVENTS.TOWER_LEVEL_UP, {
        towerId: tower.def.id,
        fromLevel: prevLevel,
        toLevel: nextLevel,
        reason
      });
      if (prevLevel < CFG.PRESTIGE_LEVEL && nextLevel >= CFG.PRESTIGE_LEVEL) {
        this.emitGameEvent(GAME_EVENTS.TOWER_PRESTIGE_UNLOCKED, {
          towerId: tower.def.id,
          fromLevel: prevLevel,
          toLevel: nextLevel,
          reason
        });
      }
    }

    getLastLoadMigrationSchema(){
      return this._lastLoadMigrationFromSchema;
    }

    evaluateCampaignStars(){
      const quest = this.getRunQuestSnapshot();
      const targetWave = this.getCampaignTargetWave();
      const cleared = quest.campaignCleared || this.currentWave >= targetWave;
      return {
        star1: !!cleared,
        star2: !!cleared && !quest.coreDamaged,
        star3: !!cleared && !quest.sniperPurchased,
        star4: !!cleared && !!quest.uniqueTowerTypesOnly,
        star5: !!cleared && !!quest.noPrestigeUnlocked
      };
    }

    notifyCampaignClearOnce(){
      if (this._campaignClearNotified) return;
      this._campaignClearNotified = true;
      const payload = {
        mapIndex: this.mapIndex,
        isCustomMapRun: !!this.isCustomMapRun,
        stars: this.evaluateCampaignStars(),
        targetWave: this.getCampaignTargetWave(),
        maxWave: Math.max(0, Math.floor(this.currentWave || 0)),
        questState: this.getRunQuestSnapshot()
      };
      this.emitGameEvent(GAME_EVENTS.CAMPAIGN_CLEARED, payload);
      if (typeof this.onCampaignClear !== "function") return;
      this.onCampaignClear(payload);
    }

    getCurrentMapDef(){
      return {
        name: String(this.map?.name || "Custom Map"),
        gridW: Math.max(1, Math.floor(this.map?.w || 20)),
        gridH: Math.max(1, Math.floor(this.map?.h || 15)),
        entrance: {
          x: Math.floor(clampNumber(this.map?.entrance?.x, 0, 0)),
          y: Math.floor(clampNumber(this.map?.entrance?.y, 0, 0))
        },
        exit: {
          x: Math.floor(clampNumber(this.map?.exit?.x, 0, 0)),
          y: Math.floor(clampNumber(this.map?.exit?.y, 0, 0))
        },
        grid: Array.isArray(this.map?.grid)
          ? this.map.grid.map(row => Array.isArray(row) ? row.map(v => normalizeGridCell(v)) : [])
          : [],
        hazards: []
      };
    }

    serializeTower(tower){
      if (!tower?.def?.id) return null;
      return {
        id: tower.def.id,
        gx: Math.floor(clampNumber(tower.gx, 0, 0)),
        gy: Math.floor(clampNumber(tower.gy, 0, 0)),
        level: Math.floor(boundedNumber(tower.level, 1, CFG.PRESTIGE_LEVEL, 1)),
        spentGold: Math.floor(boundedNumber(tower.spentGold, 0, MAX_SAVE_NUMBER, tower.def.cost || 0)),
        cooldown: boundedNumber(tower.cooldown, 0, 60, 0),
        damageDealt: boundedNumber(tower.damageDealt, 0, MAX_SAVE_NUMBER, 0),
        kills: Math.floor(boundedNumber(tower.kills, 0, MAX_SAVE_NUMBER, 0)),
        AD: [
          Math.floor(clampNumber(tower.AD?.[0], 1, tower.def.base?.AD?.[0] ?? 1)),
          Math.floor(clampNumber(tower.AD?.[1], 1, tower.def.base?.AD?.[1] ?? 1))
        ],
        baseAS: boundedNumber(tower.baseAS, 0.05, 1000, tower.def.base?.AS ?? 1),
        baseRange: boundedNumber(tower.baseRange, 1, 1000, tower.def.base?.Range ?? 1),
        critChance: clamp(boundedNumber(tower.critChance, 0, 1, tower.def.base?.CrC ?? 0), 0, 1),
        critDmg: boundedNumber(tower.critDmg, 1, 10, tower.def.base?.CrD ?? 1.5),
        magicBonus: clampNumber(tower.magicBonus, 0, tower.def.base?.MD ?? 0),
        magicBonusExact: clampNumber(tower.magicBonusExact, 0, tower.def.base?.MD ?? 0),
        manaRegen: boundedNumber(tower.manaRegen, 0, MAX_SAVE_NUMBER, tower.def.base?.MaR ?? 0),
        manaOnHit: boundedNumber(tower.manaOnHit, 0, MAX_SAVE_NUMBER, tower.def.base?.manaOnHit ?? 0),
        armorPenPct: clamp(clampNumber(tower.armorPenPct, 0, tower.def.base?.ArP ?? 0), 0, 2),
        magicPenFlat: clampNumber(tower.magicPenFlat, 0, tower.def.base?.MaP ?? 0),
        maxMana: boundedNumber(tower.maxMana, 0, MAX_SAVE_NUMBER, tower.def.skillManaCost ?? 0),
        mana: clampNumber(tower.mana, 0, 0),
        prestigeMaxMana: boundedNumber(tower.prestigeMaxMana, 0, MAX_SAVE_NUMBER, tower.def.prestige?.mana ?? 0),
        prestigeMana: clampNumber(tower.prestigeMana, 0, 0),
        prestigeActive: boundedNumber(tower.prestigeActive, 0, 60, 0),
        prestigeDamageMul: boundedNumber(tower.prestigeDamageMul, 1, 10, 1),
        prestigeGoldTotal: boundedNumber(tower.prestigeGoldTotal, 0, MAX_SAVE_NUMBER, 0),
        uplinkTotalCore: boundedNumber(tower.uplinkTotalCore, 0, MAX_SAVE_NUMBER, 0),
        uplinkTotalGold: boundedNumber(tower.uplinkTotalGold, 0, MAX_SAVE_NUMBER, 0),
        tempASMul: boundedNumber(tower.tempASMul, 0.05, 10, 1),
        forceChainAll: !!tower.forceChainAll,
        cleaveAll: !!tower.cleaveAll,
        targetMode: normalizeTargetMode(tower.targetMode),
        ...(tower.archerSpecialization ? { archerSpecialization: tower.archerSpecialization } : {}),
        secondaryLevel: Math.floor(boundedNumber(tower.secondaryLevel, 0, MAX_SAVE_WAVE, 0)),
        perks: {
          asMul: clampNumber(tower.perks?.asMul, 0.05, 1),
          adMul: clampNumber(tower.perks?.adMul, 0.05, 1),
          magMul: clampNumber(tower.perks?.magMul, 0.05, 1),
          dmgMul: clampNumber(tower.perks?.dmgMul, 0.05, 1)
        },
        facing: tower.facing === -1 ? -1 : 1,
        specialUpgrades: normalizeSpecialUpgrades(tower.specialUpgrades),
        specialMagicActualMul: boundedNumber(tower.specialMagicActualMul, 0.05, 10, 1),
        specialMagicExpectedMul: boundedNumber(tower.specialMagicExpectedMul, 0.05, 10, 1)
      };
    }

    restoreTowerState(raw){
      if (!raw || typeof raw !== "object") return null;
      const def = TOWER_DEF_BY_ID.get(String(raw.id || ""));
      if (!def) return null;
      const gx = Math.floor(clampNumber(raw.gx, 0, 0));
      const gy = Math.floor(clampNumber(raw.gy, 0, 0));
      if (!this.canPlaceTowerAt(gx, gy, def)) return null;

      const tower = new Tower(def, gx, gy, this);
      tower.level = Math.floor(boundedNumber(raw.level, 1, CFG.PRESTIGE_LEVEL, 1));
      tower.chooseArcherPath(raw.archerSpecialization);
      tower.spentGold = Math.floor(boundedNumber(raw.spentGold, 0, MAX_SAVE_NUMBER, def.cost || 0));
      tower.cooldown = boundedNumber(raw.cooldown, 0, 60, 0);
      tower.damageDealt = boundedNumber(raw.damageDealt, 0, MAX_SAVE_NUMBER, 0);
      tower.kills = Math.floor(boundedNumber(raw.kills, 0, MAX_SAVE_NUMBER, 0));
      const adLow = Math.floor(boundedNumber(raw.AD?.[0], 1, MAX_SAVE_NUMBER, def.base.AD[0]));
      const adHigh = Math.floor(boundedNumber(raw.AD?.[1], adLow, MAX_SAVE_NUMBER, def.base.AD[1]));
      tower.AD = [adLow, Math.max(adLow, adHigh)];
      tower.baseAS = boundedNumber(raw.baseAS, 0.05, 1000, def.base.AS);
      tower.baseRange = boundedNumber(raw.baseRange, 1, 1000, def.base.Range);
      tower.critChance = clamp(boundedNumber(raw.critChance, 0, 1, def.base.CrC), 0, 1);
      tower.critDmg = boundedNumber(raw.critDmg, 1, 10, def.base.CrD);
      tower.magicBonus = boundedNumber(raw.magicBonus, 0, MAX_SAVE_NUMBER, def.base.MD);
      tower.magicBonusExact = boundedNumber(raw.magicBonusExact, 0, tower.magicBonus, tower.magicBonus);
      if (tower.magicBonusExact <= 0) tower.magicBonusExact = tower.magicBonus;
      tower.manaRegen = boundedNumber(raw.manaRegen, 0, MAX_SAVE_NUMBER, def.base.MaR);
      tower.manaOnHit = boundedNumber(raw.manaOnHit, 0, MAX_SAVE_NUMBER, def.base.manaOnHit);
      tower.armorPenPct = clamp(clampNumber(raw.armorPenPct, 0, def.base.ArP), 0, 2);
      tower.magicPenFlat = boundedNumber(raw.magicPenFlat, 0, MAX_SAVE_NUMBER, def.base.MaP);
      tower.maxMana = boundedNumber(raw.maxMana, 0, MAX_SAVE_NUMBER, def.skillManaCost ?? 0);
      tower.mana = clamp(clampNumber(raw.mana, 0, 0), 0, tower.maxMana || 0);
      tower.prestigeMaxMana = boundedNumber(raw.prestigeMaxMana, 0, MAX_SAVE_NUMBER, def.prestige?.mana ?? 0);
      tower.prestigeMana = clamp(clampNumber(raw.prestigeMana, 0, 0), 0, tower.prestigeMaxMana || 0);
      tower.prestigeActive = boundedNumber(raw.prestigeActive, 0, 60, 0);
      tower.prestigeDamageMul = boundedNumber(raw.prestigeDamageMul, 1, 10, 1);
      tower.prestigeGoldTotal = boundedNumber(raw.prestigeGoldTotal, 0, MAX_SAVE_NUMBER, 0);
      tower.uplinkTotalCore = boundedNumber(raw.uplinkTotalCore, 0, MAX_SAVE_NUMBER, 0);
      tower.uplinkTotalGold = boundedNumber(raw.uplinkTotalGold, 0, MAX_SAVE_NUMBER, 0);
      tower.tempASMul = boundedNumber(raw.tempASMul, 0.05, 10, 1);
      tower.forceChainAll = !!raw.forceChainAll;
      tower.cleaveAll = !!raw.cleaveAll;
      tower.targetMode = normalizeTargetMode(raw.targetMode);
      tower.lockedTarget = null;
      tower.secondaryLevel = Math.floor(boundedNumber(raw.secondaryLevel, 0, MAX_SAVE_WAVE, 0));
      tower.perks = {
        asMul: boundedNumber(raw.perks?.asMul, 0.05, 10, 1),
        adMul: boundedNumber(raw.perks?.adMul, 0.05, 10, 1),
        magMul: boundedNumber(raw.perks?.magMul, 0.05, 10, 1),
        dmgMul: boundedNumber(raw.perks?.dmgMul, 0.05, 10, 1)
      };
      tower.peelBuffs = {};
      tower.facing = raw.facing === -1 ? -1 : 1;
      tower.specialUpgrades = normalizeSpecialUpgrades(raw.specialUpgrades);
      tower.specialMagicActualMul = boundedNumber(raw.specialMagicActualMul, 0.05, 10, 1);
      tower.specialMagicExpectedMul = boundedNumber(raw.specialMagicExpectedMul, 0.05, 10, 1);
      return tower;
    }

    createRunStateSnapshot(resumeWave){
      this.updateMaxWaveSeen(Math.max(this.currentWave, resumeWave));
      this.runStats.totalKills = Math.max(this.runStats.totalKills, this.totalKills);
      const safeResumeWave = Math.floor(boundedNumber(resumeWave, 0, MAX_SAVE_WAVE, 0));
      return {
        mapIndex: clampCampaignMapIndex(this.mapIndex),
        gold: Math.floor(clampNumber(this.gold, 0, getStartingGold())),
        coreHP: clampNumber(this.coreHP, 0, START_CORE_HP),
        totalKills: Math.floor(clampNumber(this.totalKills, 0, 0)),
        resumeWave: safeResumeWave,
        simTime: boundedNumber(this.simTime, 0, MAX_SAVE_NUMBER, 0),
        rngState: getRandomState(),
        started: !!this.started && resumeWave > 0,
        endlessMode: !!this.endlessMode,
        isCustomMapRun: !!this.isCustomMapRun,
        customMapDef: this.isCustomMapRun ? normalizeMapDef(this.getCurrentMapDef()) : null,
        towers: this.towers.map(t => this.serializeTower(t)).filter(Boolean),
        stats: this.getStatsSnapshot(),
        questState: this.getRunQuestSnapshot()
      };
    }

    createRunSaveData(){
      const activeWave = this.isWaveActive();
      const resumeWave = (!this.started)
        ? 0
        : (activeWave ? this.getActiveResumeWave() : Math.max(1, this.nextWaveNum));
      const useCheckpoint = activeWave
        && this.waveStartCheckpoint
        && this.waveStartCheckpoint.resumeWave === resumeWave;
      const state = useCheckpoint
        ? this.waveStartCheckpoint
        : this.createRunStateSnapshot(resumeWave);
      return {
        schema: RUN_SAVE_SCHEMA,
        gameVersion: GAME_VERSION,
        savedAt: Date.now(),
        meta: createRunSaveMeta({ source: "runtime" }),
        ...state
      };
    }

    loadRunSave(saveData){
      const normalizedSave = normalizeRunSaveData(saveData);
      if (!normalizedSave) return false;
      this._lastLoadMigrationFromSchema = normalizedSave.meta?.migratedFromSchema;

      this.restart();

      const safeMap = clampCampaignMapIndex(normalizedSave.mapIndex);
      const saveCustomMap = normalizeMapDef(normalizedSave.customMapDef);
      this.mapIndex = safeMap;
      if (saveCustomMap) {
        this.map = new GameMap(saveCustomMap);
        this.isCustomMapRun = true;
      } else {
        this.map = new GameMap(getCampaignMapDef(this.mapIndex));
        this.isCustomMapRun = false;
      }
      this.useMapBackground = !this.isCustomMapRun;
      this.refreshMapBackground();

      this.gold = Math.floor(clampNumber(normalizedSave.gold, 0, getStartingGold()));
      this.coreHP = clampNumber(normalizedSave.coreHP, 0, START_CORE_HP);
      this.totalKills = Math.floor(clampNumber(normalizedSave.totalKills, 0, 0));
      this.runStats = normalizeRunStats(normalizedSave.stats);
      this.runStats.totalKills = Math.max(this.runStats.totalKills, this.totalKills);
      this.runQuestState = normalizeRunQuestState(normalizedSave.questState);
      this._campaignClearNotified = false;

      const towersRaw = Array.isArray(normalizedSave.towers) ? normalizedSave.towers : [];
      this.towers = [];
      for (const tRaw of towersRaw) {
        const restored = this.restoreTowerState(tRaw);
        if (restored) this.towers.push(restored);
      }
      this.tutorialSpecialChoicePending = !this.towers.some(t => t?.def?.id === "archer" && Array.isArray(t.specialUpgrades) && t.specialUpgrades.length > 0);
      this.markTowerSpatialIndexDirty();
      this.evaluateUniqueTowerTypeChallenge();
      this.evaluateNoPrestigeChallenge();

      this.enemies = [];
      this.projectiles = [];
      this.effects = [];
      this.rings = [];
      this.attackFlashes = [];
      this._attackFlashCursor = 0;
      this.floaters = [];
      this.centerQueue = [];
      this.deferredActions = [];
      this.selectedTowerDef = null;
      this.clearSelection();
      this.selectedEnemy = null;
      this.hoverGrid = null;
      this.peelUplinkCastsByWave = {};
      this.lastUplinkRewardWave = 0;
      this.waveEndUplinkNotice = null;
      this.carepackageNotice = null;
      this.waveStartCheckpoint = null;
      this.nextWaveNowGoldBuff = { mult: 1, timeLeft: 0, maxTime: 0 };
      this._prevWaveActive = false;
      this.seenModifierIds = new Set();
      this.closeModifierIntro();
      this.hideWinModal();
      this.gameOver = false;
      this.started = false;
      this.autoQueueTimer = 0;
      this.currentWave = 0;
      this.nextWaveNum = 1;
      this.wavesActive = [];

      this.endlessMode = !!normalizedSave.endlessMode;
      setEndlessScalingEnabled(this.endlessMode);
      this.campaignWinShown = false;
      this.runStartMs = performance.now();
      this.simTime = boundedNumber(normalizedSave.simTime, 0, MAX_SAVE_NUMBER, 0);
      setRandomState(normalizedSave.rngState || this.rngSeed);
      this._simulationAccumulator = 0;

      const resumeWave = Math.floor(clampNumber(normalizedSave.resumeWave, 0, 0));
      if (resumeWave > 0) {
        this.jumpToWaveForTest(resumeWave);
        this.centerQueue.push({ text: `Continue: Wave ${resumeWave}`, life: 1.8 });
        this.logEvent(`Continue loaded from wave ${resumeWave}.`);
      } else {
        this.logEvent("Save loaded.");
        this.refreshUI(true);
      }
      if (Number.isFinite(this._lastLoadMigrationFromSchema) && this._lastLoadMigrationFromSchema > 0) {
        this.logEvent(`Save migrated: v${this._lastLoadMigrationFromSchema} -> v${RUN_SAVE_SCHEMA}.`);
      }
      this.updateMaxWaveSeen(Math.max(resumeWave, this.currentWave));
      return true;
    }

    startFreshRun(options = {}){
      this.rngSeed = (Number.isFinite(Number(options?.seed)) ? Number(options.seed) : (Date.now() ^ Math.floor(Math.random() * 0xffffffff))) >>> 0;
      setRandomSeed(this.rngSeed);
      const safeMap = clampCampaignMapIndex(options?.mapIndex);
      this.mapIndex = safeMap;
      const customMapDef = normalizeMapDef(options?.customMapDef);
      if (customMapDef) {
        this.map = new GameMap(customMapDef);
        this.isCustomMapRun = true;
      } else {
        this.map = new GameMap(getCampaignMapDef(this.mapIndex));
        this.isCustomMapRun = false;
      }
      this.useMapBackground = !this.isCustomMapRun;
      this.refreshMapBackground();
      this.restart();
      this.resetRunStats();
      this.resetRunQuestState();
      this.logEvent("New run started.");
      this.refreshUI(true);
    }

    showWinModal(){
      if (this.winModalOpen) return;
      this.winModalOpen = true;
      this.runClearSec = Math.max(0, Math.round(boundedNumber(this.simTime, 0, MAX_SAVE_NUMBER, 0)));
      const mm = Math.floor(this.runClearSec / 60);
      const ss = this.runClearSec % 60;
      if (this.winTime) this.winTime.textContent = `${mm}:${String(ss).padStart(2,"0")}`;
      if (this.winBack) this.winBack.style.display = "flex";
      this.prevSpeedBeforeModal = this.gameSpeed;
      this.gameSpeed = 0;
      this.syncSpeedUI(0);
    }

    hideWinModal(){
      if (!this.winModalOpen) return;
      this.winModalOpen = false;
      if (this.winBack) this.winBack.style.display = "none";
      const restore = Math.max(0.1, this.prevSpeedBeforeModal || 1.0);
      this.gameSpeed = restore;
      this.syncSpeedUI(this.gameSpeed);
    }

    endRunAfterWin(){
      this.hideWinModal();
      this.logEvent("Run ended after campaign clear.");
      this.setGameOver();
      this.refreshUI(true);
    }

    enterEndlessMode(){
      this.endlessMode = true;
      setEndlessScalingEnabled(true);
      this.hideWinModal();
      const msg = "You finished the main content. From this point, balance may be unfair. Good luck.";
      this.centerQueue.push({ text: "ENDLESS MODE", life: 2.2 });
      this.logEvent(msg);
      this.refreshUI(true);
    }

    maybeShowModifierIntro(enemy){
      if (!enemy || this.modifierIntroOpen || isModalOpen()) return;
      const modifier = listEnemyModifiers(enemy)[0] || null;
      if (!modifier) return;
      const key = String(modifier.id || modifier.name || "");
      if (!key || this.seenModifierIds.has(key)) return;
      this.seenModifierIds.add(key);
      this.showModifierIntro(modifier);
    }

    changeMap(){
      const mapCount = getCampaignMapCount();
      this.mapIndex = (this.mapIndex + 1) % mapCount;
      this.map = new GameMap(getCampaignMapDef(this.mapIndex));
      this.isCustomMapRun = false;
      this.useMapBackground = true;
      this.refreshMapBackground();

      this.enemies=[];
      this.projectiles=[];
      this.effects=[];
      this.rings=[];
      this.attackFlashes=[];
      this._attackFlashCursor=0;
      this.floaters=[];
      this.centerQueue=[];
      this.deferredActions=[];
      this.screenShakeTime = 0;
      this.screenShakeMaxTime = 0;
      this.screenShakePower = 0;
      this.wavesActive=[];
      this.currentWave=0;
      this.nextWaveNum=1;
      this.started=false;
      this._startLogged = false;
      this.autoQueueTimer=0;
      this.clearSelection();
      this.peelUplinkCastsByWave = {};
      this.lastUplinkRewardWave = 0;
      this.waveEndUplinkNotice = null;
      this.carepackageNotice = null;
      this.waveStartCheckpoint = null;
      this.nextWaveNowGoldBuff = { mult: 1, timeLeft: 0, maxTime: 0 };
      this.tutorialSpecialChoicePending = true;
      this._prevWaveActive = false;
      this.endlessMode = false;
      this.campaignWinShown = false;
      this.hideWinModal();
      this.runStartMs = performance.now();
      this.simTime = 0;
      this._simulationAccumulator = 0;
      this.gameSpeed = 1.0;
      this.syncSpeedUI(this.gameSpeed);
      setEndlessScalingEnabled(false);
      this.resetRunStats();
      this.resetRunQuestState();
      this.seenModifierIds = new Set();
      this.closeModifierIntro();
      this.refreshUI(true);
    }

    resizeCanvasToDisplaySize(force=false){
      const mapKey = `${this.map?.w || 0}x${this.map?.h || 0}`;
      if (!force && !this._resizeDirty && this._resizeMapKey === mapKey) return;
      const rect=this.cv.getBoundingClientRect();
      const dpr=window.devicePixelRatio || 1;
      const newW=Math.max(2, Math.floor(rect.width * dpr));
      const newH=Math.max(2, Math.floor(rect.height * dpr));
      if(this.cv.width !== newW || this.cv.height !== newH){
        this.cv.width=newW;
        this.cv.height=newH;
      }
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = "high";
      this.tileSize=Math.floor(Math.min(this.cv.width/this.map.w, this.cv.height/this.map.h));
      this.offsetX = Math.floor((this.cv.width - this.tileSize*this.map.w)/2);
      this.offsetY = Math.floor((this.cv.height - this.tileSize*this.map.h)/2);
      this._resizeMapKey = mapKey;
      this._resizeDirty = false;
      this.refreshMapWipBanner();

		// 300px saÄŸa kaydÄ±r (CSS px -> canvas px)

    }

    isWaveActive(){
      const anyWave = this.wavesActive.some(w => !w.finished);
      const anyEnemy = this.enemies.some(e => !e.dead && !e.reachedExit);
      return anyWave || anyEnemy;
    }

    getActiveResumeWave(){
      const waveNums = [
        ...this.wavesActive
          .filter(w => !w.finished)
          .map(w => Math.floor(Number(w.waveNum) || 0)),
        ...this.enemies
          .filter(e => !e.dead && !e.reachedExit)
          .map(e => Math.floor(Number(e.wave) || 0))
      ].filter(w => w > 0);
      return waveNums.length ? Math.min(...waveNums) : Math.max(1, this.nextWaveNum);
    }

    wavePlanOptions(){
      return {
        neoCityOpening: this.mapIndex === 0 && !this.isCustomMapRun && !this.endlessMode,
        endlessMode: this.endlessMode
      };
    }

    atCampaignFinalWave(){
      return !this.endlessMode && this.currentWave >= this.getCampaignTargetWave();
    }

    queueWave(waveNum){
      waveNum = Math.floor(boundedNumber(waveNum, 1, MAX_SAVE_WAVE, 1));
      const w = new WaveState(waveNum, this.wavePlanOptions());
      const hadActiveState = this.isWaveActive();
      this.wavesActive.push(w);
      this.currentWave = Math.max(this.currentWave, waveNum);
      this.nextWaveNum = Math.max(this.nextWaveNum, waveNum+1);
      this.updateMaxWaveSeen(this.currentWave);
      // Keep the earliest safe checkpoint while waves overlap. Saving from a
      // later queued wave must never discard the first wave's checkpoint.
      if (!hadActiveState || !this.waveStartCheckpoint) {
        this.waveStartCheckpoint = this.createRunStateSnapshot(this.getActiveResumeWave());
      }
      if (!this.peelUplinkCastsByWave[waveNum]) this.peelUplinkCastsByWave[waveNum] = 0;
      SFX.wave(waveNum);
      this.emitGameEvent(GAME_EVENTS.WAVE_STARTED, {
        waveNum,
        nextWaveNum: this.nextWaveNum,
        endlessMode: !!this.endlessMode,
        isBossWave: w.plan.some(part => String(part?.type || "") === "boss")
      });

      this.refreshUI(true);
    }

    start(){
      if(this.gameOver) return;
      if(this.started) return;
      if (!this.canRunTutorialAction("start_wave", { via: "game.start" })) return;
      this.started=true;
      this.runStartMs = performance.now();
      if (!this._startLogged) {
        this._startLogged = true;
        this.logEvent("Signal online: towers are operational.");
      }
      this.queueWave(this.nextWaveNum);
      this.emitGameEvent(GAME_EVENTS.RUN_STARTED, {
        mapIndex: this.mapIndex,
        isCustomMapRun: !!this.isCustomMapRun
      });
      this.notifyTutorialAction("start_wave", { via: "game.start" });
    }

    nextWaveNow(){
      if (!this.canRunTutorialAction("next_wave_now", { via: "game.nextWaveNow" })) return;
      if(this.gameOver){
        this.restart();
        return;
      }
      if(this.winModalOpen || this.atCampaignFinalWave()) return;
      if(!this.started){ this.start(); return; }
      const alive = this.enemies.filter(e => !e.dead && !e.reachedExit).length;
      const step = Math.max(1, Math.ceil(Math.max(1, alive) / 10));
      const buff = {
        mult: 1.1 + (step - 1) * 0.1,
        duration: (alive <= 10) ? 5.0 : 10.0
      };
      this.nextWaveNowGoldBuff.mult = Math.max(this.nextWaveNowGoldBuff.mult, buff.mult);
      this.nextWaveNowGoldBuff.timeLeft = Math.max(this.nextWaveNowGoldBuff.timeLeft, buff.duration);
      this.nextWaveNowGoldBuff.maxTime = Math.max(this.nextWaveNowGoldBuff.maxTime, this.nextWaveNowGoldBuff.timeLeft);
      this.logEvent(`Next Wave Now: ${buff.mult.toFixed(1)}x gold for ${buff.duration.toFixed(0)}s (alive mobs: ${alive})`);
      this.queueWave(this.nextWaveNum);
      this.notifyTutorialAction("next_wave_now", { via: "game.nextWaveNow", alive });
    }

    jumpToWaveForTest(waveNum){
      if (this.gameOver) return;
      const w = Math.floor(boundedNumber(waveNum, 1, MAX_SAVE_WAVE, 1));
      this.enemies = [];
      this.projectiles = [];
      this.effects = [];
      this.rings = [];
      this.attackFlashes = [];
      this._attackFlashCursor = 0;
      this.floaters = [];
      this.wavesActive = [];
      this.currentWave = Math.max(0, w - 1);
      this.nextWaveNum = w;
      this.started = true;
      this.autoQueueTimer = 0;
      this.queueWave(w);
    }

    autoQueueIfNeeded(dt){
      if(!this.started || this.gameOver) return;
      if(this.isWaveActive()){
        this.autoQueueTimer=0;
        return;
      }
      if (!this.campaignWinShown && this.atCampaignFinalWave()) {
        this.campaignWinShown = true;
        this.runQuestState.campaignCleared = true;
        this.runQuestState.clearedAtWave = Math.max(this.runQuestState.clearedAtWave, this.currentWave);
        this.notifyCampaignClearOnce();
        this.showWinModal();
        return;
      }
      this.autoQueueTimer += dt;
      if(this.autoQueueTimer >= this.autoQueueDelay){
        this.autoQueueTimer=0;
        this.queueWave(this.nextWaveNum);
      }
    }

    recordPeelUplinkCast(){
      const waveNum = Math.max(1, this.currentWave || 1);
      this.peelUplinkCastsByWave[waveNum] = (this.peelUplinkCastsByWave[waveNum] || 0) + 1;
    }

    getPeelUplinkCasts(waveNum){
      const n = waveNum ?? this.currentWave;
      return this.peelUplinkCastsByWave[n] || 0;
    }

    resolvePeelUplinkWaveEnd(){
      const waveNum = this.currentWave;
      if (!waveNum || waveNum <= this.lastUplinkRewardWave) return;
      const casts = this.getPeelUplinkCasts(waveNum);
      this.lastUplinkRewardWave = waveNum;
      delete this.peelUplinkCastsByWave[waveNum];
      if (casts <= 0) return;

      const peel = this.towers.find(t => t.def?.id === "peel");
      const peelMagic = peel
        ? Math.round((peel.magicBonus || 0) * (peel.perks?.magMul ?? 1) * (peel.peelMul?.("mag") ?? 1))
        : 0;
      const coreMul = 1 + Math.min(0.90, peelMagic / 1800); // up to +90%
      const goldMul = 1 + Math.min(1.20, peelMagic / 1200); // up to +120%

      const coreGain = Math.max(1, Math.round(casts * coreMul));
      const goldPerCast = Math.max(12, Math.round(8 + waveNum * 2.2));
      const goldGain = Math.max(1, Math.round(casts * goldPerCast * goldMul));
      this.coreHP += coreGain;
      this.gold += goldGain;
      if (peel) {
        peel.uplinkTotalCore = Math.max(0, (peel.uplinkTotalCore || 0) + coreGain);
        peel.uplinkTotalGold = Math.max(0, (peel.uplinkTotalGold || 0) + goldGain);
      }
      this.waveEndUplinkNotice = {
        life: 3.6,
        maxLife: 3.6,
        waveNum,
        casts,
        coreGain,
        goldGain
      };
      this.logEvent(`Core Uplink payout: Wave ${waveNum} | casts ${casts} | Magic ${peelMagic} | +${coreGain} Core | +${goldGain} Gold`);
    }

    showCarepackageNotice(tower, goldGain){
      if (!tower || !Number.isFinite(goldGain) || goldGain <= 0) return;
      this.carepackageNotice = {
        life: 3.2,
        maxLife: 3.2,
        tower,
        goldGain: Math.max(1, Math.round(goldGain))
      };
    }

    findNearestPathIndex(x,y){
      const path = this.map.path || [];
      let bestIdx = 0;
      let bestD2 = Infinity;
      for (let i=0; i<path.length; i++) {
        const p = path[i];
        const d2 = dist2(x, y, p.x+0.5, p.y+0.5);
        if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
      }
      return bestIdx;
    }

    spawnEnemy(typeId, waveNum, opts={}){
      const enemy = new Enemy(this.map, typeId, waveNum, this, opts.customBossStats ?? null, opts.waveMods ?? null);
      if (opts.pos) {
        enemy.x = opts.pos.x;
        enemy.y = opts.pos.y;
        enemy.pathIndex = this.findNearestPathIndex(enemy.x, enemy.y);
      }
      this.enemies.push(enemy);
      return enemy;
    }

    spawnBossAdds(boss, count){
      if (!boss || count <= 0) return;
      const tankRatio = clamp(0.25 + (boss.wave - 30) * 0.004, 0.25, 0.55);
      const tankCount = Math.round(count * tankRatio);
      const runnerCount = Math.max(0, count - tankCount);
      const basePos = { x: boss.x, y: boss.y };
      const mods = { ...waveModifiers(boss.wave), noAffix: true };

      const spawnAt = (typeId) => {
        const jx = (random()-0.5) * 0.45;
        const jy = (random()-0.5) * 0.45;
        this.spawnEnemy(typeId, boss.wave, { pos: { x: basePos.x + jx, y: basePos.y + jy }, waveMods: mods });
      };

      for (let i=0; i<runnerCount; i++) spawnAt("runner");
      for (let i=0; i<tankCount; i++) spawnAt("tank");
    }

    spawnVolatileMinions(enemy, count){
      if (!enemy || count <= 0) return;
      const mods = { ...waveModifiers(enemy.wave), noAffix: true };
      for (let i=0; i<count; i++) {
        const jx = (random()-0.5) * 0.35;
        const jy = (random()-0.5) * 0.35;
        this.spawnEnemy("runner", enemy.wave, { pos: { x: enemy.x + jx, y: enemy.y + jy }, waveMods: mods });
      }
    }

    rebuildTowerSpatialIndex(){
      if (!this.towerSpatial) return;
      if (!this._towerSpatialDirty && this.towerSpatial) return;
      this.towerSpatial.rebuild(this.towers, t => !!t);
      this._towerSpatialDirty = false;
    }

    markTowerSpatialIndexDirty(){
      this._towerSpatialDirty = true;
    }

    rebuildEnemySpatialIndex(){
      this.enemySpatial.rebuild(this.enemies, e => !!e && !e.dead && !e.reachedExit);
    }

    getEnemiesInRange(x, y, radius, out = null){
      const buf = out || this._enemyRangeScratch;
      if (!this.enemySpatial) {
        buf.length = 0;
        const r2 = radius * radius;
        for (const e of this.enemies) {
          if (!e || e.dead || e.reachedExit) continue;
          if (dist2(x, y, e.x, e.y) <= r2) buf.push(e);
        }
        return buf;
      }
      return this.enemySpatial.queryCircle(x, y, radius, buf);
    }

    getTowersInRange(x, y, radius, out = null){
      const buf = out || this._towerRangeScratch;
      if (this._towerSpatialDirty) this.rebuildTowerSpatialIndex();
      if (!this.towerSpatial) {
        buf.length = 0;
        const r2 = radius * radius;
        for (const t of this.towers) {
          if (!t) continue;
          if (dist2(x, y, t.x, t.y) <= r2) buf.push(t);
        }
        return buf;
      }
      return this.towerSpatial.queryCircle(x, y, radius, buf);
    }

    getBossNextSkill(enemy){
      if (!enemy?.bossSkills) return null;
      const debuffed = (enemy.poisonStacks > 0) || (enemy.slowPct > 0.2) || (enemy.frostbiteTime > 0) || (enemy.frostbiteDotTime > 0);
      const eligible = {
        cleanse: debuffed,
        heal: enemy.hp < enemy.maxHP,
        summon: true
      };
      const skills = Object.values(enemy.bossSkills).filter(s => s.active);
      if (!skills.length) return null;
      let best = null;
      for (const s of skills) {
        if (!eligible[s.id]) continue;
        if (!best || s.timer < best.timer) best = s;
      }
      if (best) return best;
      return skills.reduce((min, s) => (s.timer < min.timer ? s : min), skills[0]);
    }

    eventToCanvasXY(ev){
      const rect=this.cv.getBoundingClientRect();
      const sx=this.cv.width/rect.width;
      const sy=this.cv.height/rect.height;
      return { x:(ev.clientX-rect.left)*sx, y:(ev.clientY-rect.top)*sy };
    }
    screenToGrid(mx,my){
      const x=Math.floor((mx - this.offsetX)/this.tileSize);
      const y=Math.floor((my - this.offsetY)/this.tileSize);
      if(x<0||y<0||x>=this.map.w||y>=this.map.h) return null;
      return {x,y};
    }
    canPlaceTowerAt(gx, gy, def){
      if(!def) return false;
      if(def.id === "peel" && this.towers.some(t => t.def.id === "peel")) return false;
      const size = def.size ?? 1;
      for (let dy=0; dy<size; dy++) {
        for (let dx=0; dx<size; dx++) {
          const tx = gx + dx;
          const ty = gy + dy;
          if (!this.map.inBounds(tx, ty) || !this.map.isBuildable(tx, ty)) return false;
          if (this.towerAtGrid(tx, ty)) return false;
        }
      }
      return true;
    }
    towerOccupies(t, gx, gy){
      const size = t.size ?? 1;
      return gx >= t.gx && gx < t.gx + size && gy >= t.gy && gy < t.gy + size;
    }
    towerAtGrid(gx,gy){
      return this.towers.find(t => this.towerOccupies(t, gx, gy)) || null;
    }
    enemyAtCanvas(mx,my){
      const r=this.tileSize*0.30;
      const r2=r*r;
      for(let i=this.enemies.length-1;i>=0;i--){
        const e=this.enemies[i];
        if(e.dead || e.reachedExit) continue;
        const ex=this.offsetX + e.x*this.tileSize;
        const ey=this.offsetY + e.y*this.tileSize;
        const dx=mx-ex, dy=my-ey;
        if(dx*dx+dy*dy <= r2) return e;
      }
      return null;
    }
    getTowerTargetUiRects(t){
      if (!t || t !== this.selectedTowerInstance) return null;
      const sizeTiles = t.size ?? 1;
      const sizePx = this.tileSize * sizeTiles;
      const towerPx = this.offsetX + t.gx*this.tileSize;
      const towerPy = this.offsetY + t.gy*this.tileSize;
      const panelH = Math.max(24, Math.round(this.tileSize * 0.50));
      const btnW = Math.max(24, Math.round(this.tileSize * 0.50));
      const btnH = panelH;
      const centerW = Math.max(84, Math.round(sizePx * 1.6));
      const gap = 6;
      const totalW = btnW + gap + centerW + gap + btnW;
      const rawStartX = (towerPx + sizePx/2) - totalW/2;
      const startX = clamp(rawStartX, 4, Math.max(4, this.cv.width - totalW - 4));
      const baseY = clamp(towerPy + sizePx + 8, 4, Math.max(4, this.cv.height - panelH - 4));
      return {
        left: { x: startX, y: baseY, w: btnW, h: btnH },
        center: { x: startX + btnW + gap, y: baseY, w: centerW, h: btnH },
        right: { x: startX + btnW + gap + centerW + gap, y: baseY, w: btnW, h: btnH }
      };
    }
    pointInRect(mx, my, r){
      return !!r && mx >= r.x && mx <= (r.x + r.w) && my >= r.y && my <= (r.y + r.h);
    }
    drawSelectedTargetPanel(ctx){
      const t = this.selectedTowerInstance;
      if (!t) return;
      const rects = this.getTowerTargetUiRects(t);
      if (!rects) return;
      const drawBtn = (r, text, active=false) => {
        const grd = ctx.createLinearGradient(r.x, r.y, r.x, r.y + r.h);
        if (active) {
          grd.addColorStop(0, "rgba(30,58,138,0.90)");
          grd.addColorStop(1, "rgba(14,116,144,0.92)");
        } else {
          grd.addColorStop(0, "rgba(15,23,42,0.92)");
          grd.addColorStop(1, "rgba(30,41,59,0.94)");
        }
        ctx.fillStyle = grd;
        ctx.strokeStyle = active ? "rgba(125,211,252,0.95)" : "rgba(148,163,184,0.90)";
        ctx.lineWidth = 2;
        ctx.fillRect(r.x, r.y, r.w, r.h);
        ctx.strokeRect(r.x+1, r.y+1, r.w-2, r.h-2);
        ctx.fillStyle = "rgba(241,245,249,0.98)";
        ctx.font = active
          ? `700 ${Math.max(12, Math.floor(r.h*0.50))}px system-ui`
          : `700 ${Math.max(14, Math.floor(r.h*0.62))}px system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(text, r.x + r.w/2, r.y + r.h/2 + 0.5);
      };
      drawBtn(rects.left, "<");
      drawBtn(rects.center, t.getTargetModeLabel(), true);
      drawBtn(rects.right, ">");
    }

    bindInput(){
      this.cv.addEventListener("mousemove",(ev)=>{
        if(!this.selectedTowerDef){ this.hoverGrid=null; return; }
        const {x:mx,y:my}=this.eventToCanvasXY(ev);
        this.hoverGrid = this.screenToGrid(mx,my);
      });
      this.cv.addEventListener("mouseleave",()=>{
        this.hoverGrid = null;
      });
      this.cv.addEventListener("contextmenu",(ev)=>{
        ev.preventDefault();
        if (!this.canRunTutorialAction("canvas_context_clear", {})) return;
        this.clearPlacement();
        this.clearSelection();
        this.selectedEnemy = null;
        this.selectedTowerInstance = null;
        this.notifyTutorialAction("canvas_context_clear", {});
        this.refreshUI(true);
      });
      this.cv.addEventListener("click",(ev)=>{
        const inspectMode = this.gameOver && this.gameOverInspectMode;
        if(this.gameOver && !inspectMode) return;
        if (isModalOpen()) return;

        const {x:mx,y:my}=this.eventToCanvasXY(ev);
        const targetUi = this.getTowerTargetUiRects(this.selectedTowerInstance);
        if (targetUi && !inspectMode) {
          if (this.pointInRect(mx, my, targetUi.left)) {
            if (!this.canRunTutorialAction("tower_target_cycle_prev", { towerId: this.selectedTowerInstance?.def?.id || null })) return;
            this.selectedTowerInstance.cycleTargetMode(-1);
            this.notifyTutorialAction("tower_target_cycle_prev", { towerId: this.selectedTowerInstance?.def?.id || null });
            this.refreshUI(true);
            return;
          }
          if (this.pointInRect(mx, my, targetUi.right)) {
            if (!this.canRunTutorialAction("tower_target_cycle_next", { towerId: this.selectedTowerInstance?.def?.id || null })) return;
            this.selectedTowerInstance.cycleTargetMode(1);
            this.notifyTutorialAction("tower_target_cycle_next", { towerId: this.selectedTowerInstance?.def?.id || null });
            this.refreshUI(true);
            return;
          }
        }

        const g=this.screenToGrid(mx,my);
        if(!g) return;

        const clickedEnemy=this.enemyAtCanvas(mx,my);
        if(clickedEnemy){
          if (!this.canRunTutorialAction("canvas_select_enemy", {
            enemyType: clickedEnemy.typeId || null,
            waveNum: this.currentWave
          })) return;
          this.selectedEnemy=clickedEnemy;
          this.selectedTowerInstance=null;
          this.clearPlacement();
          this.notifyTutorialAction("canvas_select_enemy", {
            enemyType: clickedEnemy.typeId || null,
            waveNum: this.currentWave
          });
          this.refreshUI(true);
          return;
        }

        const clickedTower=this.towerAtGrid(g.x,g.y);
        if(clickedTower){
          if (!this.canRunTutorialAction("canvas_select_tower", {
            towerId: clickedTower.def?.id || null,
            gx: clickedTower.gx,
            gy: clickedTower.gy,
            level: clickedTower.level
          })) return;
          this.selectedTowerInstance=clickedTower;
          this.selectedEnemy=null;
          this.clearPlacement();
          this.notifyTutorialAction("canvas_select_tower", {
            towerId: clickedTower.def?.id || null,
            gx: clickedTower.gx,
            gy: clickedTower.gy,
            level: clickedTower.level
          });
          this.refreshUI(true);
          return;
        }

        this.clearSelection();
        if (inspectMode) {
          this.notifyTutorialAction("canvas_click_empty", { gx: g.x, gy: g.y, inspectMode: true });
          this.refreshUI(true);
          return;
        }

        if(!this.selectedTowerDef){
          this.notifyTutorialAction("canvas_click_empty", { gx: g.x, gy: g.y, inspectMode: false });
          this.refreshUI(true);
          return;
        }
        if (!this.canRunTutorialAction("canvas_place_tower", {
          towerId: this.selectedTowerDef.id,
          gx: g.x,
          gy: g.y
        })) return;
        if (!this.canPlaceTowerAt(g.x, g.y, this.selectedTowerDef)) {
          if (this.selectedTowerDef.id === "peel" && this.towers.some(t => t.def.id === "peel")) {
          this.logEvent("Peel Tower limit: 1");
          }
          this.refreshUI(true);
          return;
        }

        const cost=this.selectedTowerDef.cost;
        if(this.gold < cost){ this.refreshUI(true); return; }

        this.gold -= cost;
        const placedTower = new Tower(this.selectedTowerDef, g.x, g.y, this);
        this.towers.push(placedTower);
        this.markTowerSpatialIndexDirty();
        this.recordTowerBuilt(this.selectedTowerDef.id, g.x, g.y);
        this.evaluateUniqueTowerTypeChallenge();
        if (this.selectedTowerDef.id === "sniper") this.runQuestState.sniperPurchased = true;
        this.notifyTutorialAction("canvas_place_tower", {
          towerId: this.selectedTowerDef.id,
          gx: g.x,
          gy: g.y,
          level: placedTower.level
        });
        SFX.place();
        this.refreshUI(true);
      });
    }

    sellSelectedTower(){
      const t=this.selectedTowerInstance;
      if(!t) return;
      if (!this.canRunTutorialAction("sell_selected_tower", {
        towerId: t.def?.id || null,
        gx: t.gx,
        gy: t.gy,
        level: t.level
      })) return;
      const refund=Math.round(t.spentGold*0.50);
      this.gold += refund;
      this.towers = this.towers.filter(x=>x!==t);
      this.markTowerSpatialIndexDirty();
      this.selectedTowerInstance=null;
      this.notifyTutorialAction("sell_selected_tower", {
        towerId: t.def?.id || null,
        gx: t.gx,
        gy: t.gy,
        level: t.level
      });
      SFX.sell();
      this.refreshUI(true);
    }

    openMilestoneModal(tower){
      const tier = milestoneTier(tower.level);
      if (!tier) return;
      this.emitGameEvent(GAME_EVENTS.TOWER_SPECIAL_UPGRADE_OPENED, {
        towerId: tower?.def?.id || null,
        towerLevel: tower?.level || 0,
        tier
      });
      this.uiHover.upgrade = false;
      this.uiHover.fast = false;

      const scriptedTutorialChoice = this.shouldUseTutorialScriptedSpecialChoice()
        && !this.isCustomMapRun
        && this.mapIndex === 0
        && this.tutorialSpecialChoicePending
        && tower?.def?.id === "archer"
        && Number(tower?.level) === 5;
      const choices = buildChoicesForTower(tower, tier, {
        forceFixedByCode: scriptedTutorialChoice
      });

      openModal(
        `${tower.def.name} - Lv ${tower.level} Special Upgrade <span class="tierBadge">Tier ${tier}</span>`,
        tower.canChooseArcherPath() && tower.level === ARCHER_SPECIALIZATION_LEVEL
          ? "Choose one Special Upgrade. Afterwards, pick a free specialization in the tower panel whenever you’re ready."
          : "Choose 1 option.",
        choices,
        (choice) => {
          this.hoverSpecialChoice = null;
          choice.apply(tower);
          if (scriptedTutorialChoice) this.tutorialSpecialChoicePending = false;
          closeModal();
          this.gameSpeed = this.prevSpeedBeforeModal;
          this.syncSpeedUI(this.gameSpeed);
          this.refreshUI(true);
          this.emitGameEvent(GAME_EVENTS.TOWER_SPECIAL_UPGRADE_CHOSEN, {
            towerId: tower.def?.id || null,
            towerLevel: tower.level,
            tier,
            rarityId: String(choice?.rarityId || "common"),
            title: String(choice?.title || "")
          });
        },
        (choice) => {
          this.hoverSpecialChoice = choice || null;
          this.refreshUI(true);
        }
      );

      this.prevSpeedBeforeModal = this.gameSpeed;
      this.gameSpeed = 0;
      this.syncSpeedUI(0);
    }

    setGameOver(){
      if(this.gameOver) return;
      this.hideWinModal();
      this.gameOver=true;
      this.gameOverInspectMode = false;
      this.clearPlacement();
      this.clearSelection();
      this.selectedEnemy = null;
      this.hoverGrid = null;
      this.showGameOverModal();
      SFX.gameOver();
      this.logEvent("GAME OVER. Core has fallen.");
      this.emitGameEvent(GAME_EVENTS.GAME_OVER, {
        waveNum: Math.max(0, this.currentWave || 0),
        totalKills: Math.max(0, this.totalKills || 0)
      });
      this.saveHighKills();
    }

    showGameOverModal(){
      if (this.gameOverBack) this.gameOverBack.style.display = "flex";
    }

    hideGameOverModal(){
      if (this.gameOverBack) this.gameOverBack.style.display = "none";
    }

    enterGameOverInspectMode(){
      if (!this.gameOver) return;
      this.gameOverInspectMode = true;
      this.hideGameOverModal();
      this.clearPlacement();
      this.logEvent("Inspect mode: battlefield frozen, restart to play again.");
      this.refreshUI(true);
    }

    restart(){
      this.gold=getStartingGold();
      this.coreHP=START_CORE_HP;
      this.totalKills=0;

      this.currentWave=0;
      this.nextWaveNum=1;
      this.wavesActive=[];

      this.started=false;
      this._startLogged = false;
      this.autoQueueTimer=0;

      this.towers=[];
      this.markTowerSpatialIndexDirty();
      this.enemies=[];
      this.projectiles=[];
      this.effects=[];
      this.rings=[];
      this.floaters=[];
      this.centerQueue=[];
      this.deferredActions=[];
      this.screenShakeTime = 0;
      this.screenShakeMaxTime = 0;
      this.screenShakePower = 0;

      this.selectedTowerDef=null;
      this.clearSelection();
      this.peelUplinkCastsByWave = {};
      this.lastUplinkRewardWave = 0;
      this.waveEndUplinkNotice = null;
      this.carepackageNotice = null;
      this.waveStartCheckpoint = null;
      this._prevWaveActive = false;
      this.endlessMode = false;
      this.campaignWinShown = false;
      this.hideWinModal();
      this.hideGameOverModal();
      this.runStartMs = performance.now();
      this.simTime = 0;
      this._simulationAccumulator = 0;
      this.nextWaveNowGoldBuff = { mult: 1, timeLeft: 0, maxTime: 0 };
      this.gameSpeed = 1.0;
      this.syncSpeedUI(this.gameSpeed);
      setEndlessScalingEnabled(false);
      this.resetRunStats();
      this.resetRunQuestState();
      this.seenModifierIds = new Set();
      this.closeModifierIntro();

      this.gameOver=false;
      this.gameOverInspectMode = false;
      this.emitGameEvent(GAME_EVENTS.RUN_RESTARTED, {
        mapIndex: this.mapIndex,
        isCustomMapRun: !!this.isCustomMapRun
      });
      this.refreshUI(true);
    }

    isLowEffectsEnabled(){
      if (typeof window === "undefined") return false;
      if (window.__armtdLowEffects === true) return true;
      try {
        return !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      } catch (_) {
        return false;
      }
    }

    getVisualBudget(kind){
      const base = VISUAL_BUDGETS[kind] || 0;
      return this.isLowEffectsEnabled() ? Math.max(1, Math.ceil(base * 0.5)) : base;
    }

    trimTransientVisuals(){
      const dropped = this._visualBudgetDrops || { effects: 0, floaters: 0, centerQueue: 0, rings: 0 };
      const trimPooled = (items, limit, release, kind, canDrop = () => true) => {
        if (!Array.isArray(items) || items.length <= limit) return;
        let overflow = items.length - limit;
        for (let i = 0; i < items.length && overflow > 0;) {
          const item = items[i];
          if (!canDrop(item)) {
            i += 1;
            continue;
          }
          items.splice(i, 1);
          if (typeof release === "function") release(item);
          dropped[kind] = (dropped[kind] || 0) + 1;
          overflow -= 1;
        }
      };
      trimPooled(
        this.effects,
        this.getVisualBudget("effects"),
        releaseAnyEffect,
        "effects",
        (item) => typeof item?.onHit !== "function"
      );
      // Rings with onHit carry combat logic and must finish their simulation.
      // Visual-only rings can be budgeted safely without changing combat values.
      trimPooled(
        this.rings,
        this.getVisualBudget("rings"),
        releaseEffectRing,
        "rings",
        (item) => typeof item?.onHit !== "function"
      );
      trimPooled(this.floaters, this.getVisualBudget("floaters"), releaseFloatingText, "floaters");
      if (Array.isArray(this.centerQueue)) {
        const limit = this.getVisualBudget("centerQueue");
        if (this.centerQueue.length > limit) {
          const removeCount = this.centerQueue.length - limit;
          this.centerQueue.splice(0, removeCount);
          dropped.centerQueue = (dropped.centerQueue || 0) + removeCount;
        }
      }
      this._visualBudgetDrops = dropped;
    }

    update(dt){
      this.updateAttackFlashes(dt);
      this._statsFlushTimer += Math.max(0, Number(dt) || 0);
      if (this._statsDirty && this._statsFlushTimer >= this._statsFlushInterval) {
        this.persistLifetimeStats(true);
      }

      if(this.gameOver) return;

      if (this.screenShakeTime > 0) {
        this.screenShakeTime = Math.max(0, this.screenShakeTime - dt);
        if (this.screenShakeTime <= 0) {
          this.screenShakePower = 0;
          this.screenShakeMaxTime = 0;
        }
      }

      const sdt = dt * this.gameSpeed;
      if(sdt <= 0) return;
      this.simTime = Math.max(0, Number(this.simTime) || 0) + sdt;

      this.autoQueueIfNeeded(sdt);

      // Waves spawn
      for(const w of this.wavesActive){
        if(w.finished) continue;

        w.spawnTimer -= sdt;
        let spawnedThisStep = 0;
        while(w.spawnTimer <= 0 && !w.finished && spawnedThisStep < MAX_SPAWNS_PER_WAVE_STEP){
          while(!w.finished && w.remainingInPart <= 0){
            w.nextPart();
          }
          if(w.finished) continue;

          const part = w.plan[w.cursor];
          const typeId = part.type;

          const mods = waveModifiers(w.waveNum);
          let enemy = null;

          if(typeId === "boss"){
            const isBigBoss = (w.waveNum % 100 === 0);
            const bossGroupCount = Math.max(1, Math.floor(w.waveNum/10));
            const wealthMult = isBigBoss ? bossGroupCount : 1.0;

            const prev = Math.max(1, w.waveNum-1);
            const hpByPrevWave = Math.max(1, Math.round(computePrevWaveTotals(prev).totalHP));
            let hp = hpByPrevWave;
            const totals = computePrevWaveTotals(prev);
            const wealth = Math.max(50, Math.round(totals.totalWealth * wealthMult));

            const scaledBoss = scaleForWave({Armor:40,MR:18,HP:1,Speed:0.62,Wealth:1}, w.waveNum);
            const armor = Math.round(scaledBoss.Armor);
            const mr = Math.round(scaledBoss.MR);
            const speed = isBigBoss ? 0.48 : 0.62;

            const custom = { HP: hp, Speed: speed, Armor: armor, MR: mr, Wealth: wealth };
            enemy = this.spawnEnemy("boss", w.waveNum, { customBossStats: custom, waveMods: mods });
          } else {
            enemy = this.spawnEnemy(typeId, w.waveNum, { waveMods: mods });
          }
          if (enemy) this.maybeShowModifierIntro(enemy);

          w.remainingInPart -= 1;
          w.spawnedCount += 1;
          spawnedThisStep += 1;
          const burst = (w.burstEvery > 0) && (w.spawnedCount % w.burstEvery === 0);
          w.spawnTimer += w.spawnInterval * (burst ? CFG.SPAWN_BURST_INTERVAL_MUL : 1);
        }
      }

      this.rebuildTowerSpatialIndex();

      // Enemies move
      for(const e of this.enemies){
        const wasExit=e.reachedExit;
        e.update(sdt);
        if(!wasExit && e.reachedExit){
          const hitWave = Math.max(this.currentWave, Math.floor(Number(e.wave) || this.currentWave));
          const coreHitMul = hitWave > 105 ? 5 : 1;
          const dmg = (e.isBoss ? 5 : 1) * coreHitMul;
          this.coreHP -= dmg;
          if(this.coreHP<0) this.coreHP=0;
          this.runQuestState.coreDamaged = true;
          this.logEvent(`Core hit: -${dmg} HP (HP: ${this.coreHP})`);
          this.emitGameEvent(GAME_EVENTS.CORE_DAMAGED, {
            waveNum: hitWave,
            damage: dmg,
            coreHP: this.coreHP,
            isBossSource: !!e.isBoss
          });
        }
      }

      this.rebuildEnemySpatialIndex();

      // Prestige flags
      this.anyBreakerPrestigeActive = this.towers.some(t => t.def.id==="breaker" && t.prestigeActive > 0);
      this.anyBlizzardPrestigeActive = this.towers.some(t => t.def.id==="blizzard" && t.prestigeActive > 0);

      // Archer prestige aura: mapteki tÃ¼m archerlara AS x4
      const anyArcherPrestigeActive = this.towers.some(t => t.def.id==="archer" && t.prestigeActive > 0);
      for (const t of this.towers) {
        if (t.def.id === "archer") t.tempASMul = anyArcherPrestigeActive ? 5.2 : 1.0;
      }

      // Mage prestige aura: towers in range gain fixed high mana generation.
      let hasMageAura = false;
      for (const t of this.towers) {
        t._manaGainTempMul = 1;
        if (t.def.id === "mage" && t.prestigeActive > 0) hasMageAura = true;
      }
      if (hasMageAura) {
        for (const m of this.towers) {
          if (m.def.id !== "mage" || m.prestigeActive <= 0) continue;
          const aura = magePrestigeAuraProfile();
          const auraMul = aura.manaMultiplier;
          const auraRange = m.range + aura.rangeBonus;
          const inRange = this.getTowersInRange(m.x, m.y, auraRange, this._towerRangeScratch);
          for (const t of inRange) {
            if (t === m) continue;
            t._manaGainTempMul = Math.max(t._manaGainTempMul, auraMul);
          }
        }
      }

      // Blizzard prestige aura removed (Frostbite replaces it)

      // Towers update
      for(const t of this.towers){
        t.update(sdt, this);
      }

      // Projectiles + effects
      for(const p of this.projectiles) p.update(sdt, this);
      compactInPlace(this.projectiles, p => !p.dead, releaseAnyProjectile);

      if (this.deferredActions.length) {
        const pending = this.deferredActions;
        this.deferredActions = [];
        for (const act of pending) {
          act.t -= sdt;
          if (act.t <= 0) {
            try { act.fn(); } catch (_) {}
          } else {
            this.deferredActions.push(act);
          }
        }
      }

      for(const fx of this.effects) fx.update(sdt);
      compactInPlace(this.effects, fx => !fx.dead, releaseAnyEffect);

      for(const r of this.rings) r.update(sdt, this);
      compactInPlace(this.rings, r => !r.dead, releaseEffectRing);

      // Floaters
      for (const f of this.floaters) f.update(sdt);
      compactInPlace(this.floaters, f => !f.dead, releaseFloatingText);

      // Center queue (delay destekli)
      for (const c of this.centerQueue) {
        // Keep announcement visibility independent from game speed.
        if (!c._normalized) {
          c.life = Math.max(2.0, c.life ?? 0);
          c.delay = c.delay ?? 0;
          c.maxLife = Math.max(c.maxLife ?? 0, c.life);
          c._normalized = true;
        }
        c.delay = (c.delay ?? 0) - dt;
        if ((c.delay ?? 0) < 0) c.life -= dt;
      }
      compactInPlace(this.centerQueue, c => (c.life ?? 0) > 0);
      this.trimTransientVisuals();

      if (this.nextWaveNowGoldBuff.timeLeft > 0) {
        this.nextWaveNowGoldBuff.timeLeft = Math.max(0, this.nextWaveNowGoldBuff.timeLeft - sdt);
        if (this.nextWaveNowGoldBuff.timeLeft <= 0) {
          this.nextWaveNowGoldBuff.mult = 1;
          this.nextWaveNowGoldBuff.maxTime = 0;
        }
      }

      // Reward dead enemies
      let goldGained = 0;
      const goldMul = (this.nextWaveNowGoldBuff.timeLeft > 0) ? Math.max(1, this.nextWaveNowGoldBuff.mult || 1) : 1;
      for(const e of this.enemies){
        if(e.dead && !e._rewarded){
          e._rewarded=true;
          const gain = Math.max(0, Math.round(e.wealth * goldMul));
          this.gold += gain;
          goldGained += gain;
          if (typeof SFX.enemyDie === "function") SFX.enemyDie();
        }
      }
      if (goldGained > 0) SFX.gold(goldGained);

      compactInPlace(this.enemies, e => !(e.dead || e.reachedExit));
      compactInPlace(this.wavesActive, w => !w.finished);

      if (this.waveEndUplinkNotice) {
        this.waveEndUplinkNotice.life -= dt;
        if (this.waveEndUplinkNotice.life <= 0) this.waveEndUplinkNotice = null;
      }
      if (this.carepackageNotice) {
        this.carepackageNotice.life -= dt;
        const towerAlive = this.towers.includes(this.carepackageNotice.tower);
        if (this.carepackageNotice.life <= 0 || !towerAlive) this.carepackageNotice = null;
      }

      const waveActiveNow = this.isWaveActive();
      if (this._prevWaveActive && !waveActiveNow) {
        this.resolvePeelUplinkWaveEnd();
        this.emitGameEvent(GAME_EVENTS.WAVE_ENDED, {
          waveNum: Math.max(0, this.currentWave || 0),
          nextWaveNum: Math.max(1, this.nextWaveNum || 1),
          endlessMode: !!this.endlessMode
        });
      }
      this._prevWaveActive = waveActiveNow;

      if(this.selectedEnemy && (this.selectedEnemy.dead || this.selectedEnemy.reachedExit)){
        this.selectedEnemy=null;
      }

      this._uiDirty = true;

      if(this.coreHP<=0){
        this.coreHP=0;
        this.setGameOver();
      }

    }

    logEvent(text){
      if (!this.logEl) return;
      const atBottom = (this.logEl.scrollTop + this.logEl.clientHeight) >= (this.logEl.scrollHeight - 8);
      const line = document.createElement("div");
      line.className = "logLine";
      line.textContent = text;
      this.logEl.appendChild(line);

      while (this.logEl.children.length > this.logMax) {
        this.logEl.removeChild(this.logEl.firstChild);
      }

      if (atBottom) {
        this.logEl.scrollTop = this.logEl.scrollHeight;
      }
    }

    // =========================================================
    // DRAW
    // =========================================================
    drawTowerIcon(ctx, t, cx, cy, sizePx){
      ctx.save();
      ctx.translate(cx, cy);

      const tNow = performance.now() / 1000;
      const isGold = (t.level >= CFG.TOWER_MAX_LEVEL);
      const isPrestige = (t.level >= CFG.PRESTIGE_LEVEL);

      if (isPrestige) {
        const pulse = 0.55 + 0.45 * Math.sin(tNow * 5.0);
        ctx.shadowBlur = 26 + 30 * pulse;
        ctx.shadowColor = `rgba(56,189,248,${0.55 + 0.35 * pulse})`;
      } else if (isGold) {
        const pulse = 0.55 + 0.45 * Math.sin(tNow * 5.0);
        ctx.shadowBlur = 18 + 22 * pulse;
        ctx.shadowColor = `rgba(250,204,21,${0.45 + 0.35 * pulse})`;
      }

      const stroke = "rgba(15,23,42,0.90)";

      let archerCol = "rgba(251,146,60,0.95)";
      let mageCol   = "rgba(99,102,241,0.98)";
      let breakerCol= "rgba(239,68,68,0.95)";
      let blizCol   = "rgba(56,189,248,0.95)";
      let poisonCol = "rgba(34,197,94,0.96)";
      let sniperCol = "rgba(248,250,252,0.95)";

      if (t.level >= CFG.PRESTIGE_LEVEL){
        // prestige: mavi tonu
        archerCol = mageCol = breakerCol = blizCol = poisonCol = sniperCol = "rgba(140,210,255,0.98)";
      } else if(t.level >= CFG.TOWER_MAX_LEVEL){
        archerCol = mageCol = breakerCol = blizCol = poisonCol = sniperCol = "rgba(250,204,21,0.98)";
      }

      ctx.lineWidth = Math.max(2, Math.floor(sizePx*0.10));
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const s = sizePx;

        const scaleMap = {
          archer: 0.85,
          mage: 0.75,
          breaker: 0.80,
          poison: 0.85,
          blizzard: 1.25,
          sniper: 1.10,
          peel: 0.65
        };
        const towerScale = scaleMap[t.def.id] ?? 1.0;
        const baseScale = 1.90 * towerScale;
        const maxW = sizePx * baseScale;
        const maxH = sizePx * baseScale;
        const baseY = (sizePx * 0.5) - 2;
        const drawSprite = (img, facing=1) => {
          const scale = Math.min(maxW / img.width, maxH / img.height);
          const drawW = img.width * scale;
          const drawH = img.height * scale;
          const drawX = -drawW / 2;
          const drawY = baseY - drawH;
          ctx.save();
          ctx.scale(facing, 1);
          const fx = (facing === -1) ? (-drawX - drawW) : drawX;
          ctx.drawImage(img, fx, drawY, drawW, drawH);
          ctx.restore();
        };

        if (t.def.id === "archer" && this.archerSpriteReady && this.archerSprite) {
          drawSprite(this.archerSprite, t.facing || 1);
          ctx.restore();
          return;
        }
        if (t.def.id === "mage" && this.mageSpriteReady && this.mageSprite) {
          drawSprite(this.mageSprite, 1);
          ctx.restore();
          return;
        }
        if (t.def.id === "breaker" && this.breakerSpriteReady && this.breakerSprite) {
          drawSprite(this.breakerSprite, t.facing || 1);
          ctx.restore();
          return;
        }
        if (t.def.id === "blizzard" && this.blizzardSpriteReady && this.blizzardSprite) {
          drawSprite(this.blizzardSprite, 1);
          ctx.restore();
          return;
        }
        if (t.def.id === "poison" && this.poisonSpriteReady && this.poisonSprite) {
          drawSprite(this.poisonSprite, 1);
          ctx.restore();
          return;
        }
        if (t.def.id === "sniper" && this.sniperSpriteReady && this.sniperSprite) {
          drawSprite(this.sniperSprite, t.facing || 1);
          ctx.restore();
          return;
        }
        if (t.def.id === "peel" && this.peelSpriteReady && this.peelSprite) {
          drawSprite(this.peelSprite, 1);
          ctx.restore();
          return;
        }

        if (t.def.id === "archer") {
          ctx.strokeStyle = archerCol;
          ctx.beginPath();
          ctx.arc(0, 0, s*0.35, -Math.PI/2, Math.PI/2);
          ctx.stroke();

        ctx.strokeStyle = "rgba(255,255,255,0.85)";
        ctx.lineWidth = Math.max(1.5, Math.floor(sizePx*0.06));
        ctx.beginPath();
        ctx.moveTo(0, -s*0.35);
        ctx.lineTo(s*0.22, 0);
        ctx.lineTo(0, s*0.35);
        ctx.stroke();

        ctx.strokeStyle = archerCol;
        ctx.lineWidth = Math.max(2, Math.floor(sizePx*0.08));
        ctx.beginPath();
        ctx.moveTo(-s*0.15, 0);
        ctx.lineTo(s*0.35, 0);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s*0.35, 0);
        ctx.lineTo(s*0.25, -s*0.08);
        ctx.lineTo(s*0.25,  s*0.08);
        ctx.closePath();
        ctx.fillStyle = archerCol;
        ctx.fill();
        } else if (t.def.id === "mage") {
          ctx.strokeStyle = mageCol;
          ctx.lineWidth = Math.max(2, Math.floor(sizePx*0.08));
          ctx.beginPath();
          ctx.moveTo(-s*0.25, s*0.25);
          ctx.lineTo(s*0.15, -s*0.25);
          ctx.stroke();

          ctx.fillStyle = "rgba(56,189,248,0.95)";
          ctx.strokeStyle = stroke;
          ctx.lineWidth = Math.max(1.5, Math.floor(sizePx*0.05));
          ctx.beginPath();
          ctx.arc(s*0.20, -s*0.30, s*0.10, 0, Math.PI*2);
          ctx.fill();
          ctx.stroke();
        } else if (t.def.id === "breaker") {
        ctx.fillStyle = breakerCol;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = Math.max(1.5, Math.floor(sizePx*0.05));

        ctx.beginPath();
        addRoundRectPath(ctx, -s*0.20, -s*0.10, s*0.40, s*0.28, s*0.08);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.beginPath();
        addRoundRectPath(ctx, s*0.05, -s*0.20, s*0.28, s*0.16, s*0.06);
        ctx.fill();
        ctx.stroke();
        } else if (t.def.id === "blizzard") {
          ctx.strokeStyle = blizCol;
          ctx.lineWidth = Math.max(2, Math.floor(sizePx*0.08));
          const len = s*0.33;
          const drawArm = (ang) => {
            ctx.save();
            ctx.rotate(ang);
            ctx.beginPath();
            ctx.moveTo(-len, 0);
            ctx.lineTo(len, 0);
            ctx.stroke();
            ctx.restore();
          };
          drawArm(0);
          drawArm(Math.PI/3);
          drawArm(-Math.PI/3);
        } else if (t.def.id === "poison") {
          ctx.fillStyle = poisonCol;
          ctx.strokeStyle = stroke;
          ctx.lineWidth = Math.max(1.5, Math.floor(sizePx*0.05));
          ctx.beginPath();
          ctx.moveTo(0, -s*0.35);
          ctx.quadraticCurveTo(s*0.28, -s*0.05, 0, s*0.35);
          ctx.quadraticCurveTo(-s*0.28, -s*0.05, 0, -s*0.35);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else if (t.def.id === "sniper") {
          ctx.strokeStyle = sniperCol;
          ctx.lineWidth = Math.max(2, Math.floor(sizePx*0.07));
          ctx.beginPath();
          ctx.arc(0, 0, s*0.22, 0, Math.PI*2);
          ctx.stroke();

          ctx.lineWidth = Math.max(1.5, Math.floor(sizePx*0.05));
          ctx.beginPath();
          ctx.moveTo(-s*0.30, 0); ctx.lineTo(s*0.30, 0);
          ctx.moveTo(0, -s*0.30); ctx.lineTo(0, s*0.30);
          ctx.stroke();
        }

      ctx.restore();
    }

    drawLevelBadge(ctx, level, px, py, size, color="rgba(250,204,21,0.95)", primaryPct=0, prestigePct=0){
      const r = size*0.16;
      const cx = px + size*0.18;
      const cy = py + size*0.18;
      const fillPct = clamp(primaryPct, 0, 1);
      const isPrestige = level >= CFG.PRESTIGE_LEVEL;

      ctx.save();
      ctx.shadowBlur = isPrestige ? 12 : 6;
      ctx.shadowColor = isPrestige ? "rgba(96,165,250,0.72)" : "rgba(250,204,21,0.28)";
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(15,23,42,0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI*2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // Primary skill fill (bottom -> top)
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, r-1.2, 0, Math.PI*2);
      ctx.clip();
      ctx.fillStyle = "rgba(56,189,248,0.88)";
      const h = (r*2) * fillPct;
      ctx.fillRect(cx-r, cy+r-h, r*2, h);
      ctx.restore();

      ctx.fillStyle = "rgba(15,23,42,0.98)";
      ctx.font = `bold ${Math.max(12, Math.floor(size*0.20))}px system-ui`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(level), cx, cy+0.5);

      if (isPrestige) {
        const pr = r * 0.72;
        const pcx = cx - r * 1.25;
        const pcy = cy + r * 1.00;
        const pFill = clamp(prestigePct, 0, 1);
        const pulse = 0.62 + 0.38 * Math.sin((performance.now() / 1000) * 5.0);

        ctx.fillStyle = "rgba(250,204,21,0.35)";
        ctx.strokeStyle = "rgba(147,197,253,0.95)";
        ctx.lineWidth = 1.9;
        ctx.beginPath();
        ctx.arc(pcx, pcy, pr, 0, Math.PI*2);
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = `rgba(125,211,252,${0.45 + 0.45 * pulse})`;
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.arc(pcx, pcy, pr + 1.2 + pulse * 0.6, 0, Math.PI*2);
        ctx.stroke();

        ctx.save();
        ctx.beginPath();
        ctx.arc(pcx, pcy, pr-1, 0, Math.PI*2);
        ctx.clip();
        ctx.fillStyle = "rgba(250,204,21,0.95)";
        const ph = (pr*2) * pFill;
        ctx.fillRect(pcx-pr, pcy+pr-ph, pr*2, ph);
        ctx.restore();
      }
    }

    drawAffixIcon(ctx, affixId, cx, cy, size){
      ctx.save();
      ctx.translate(cx, cy);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.fillStyle = "rgba(15,23,42,0.60)";

      if (affixId === "armored") {
        ctx.beginPath();
        ctx.moveTo(0, -size*0.9);
        ctx.lineTo(size*0.7, -size*0.2);
        ctx.lineTo(size*0.45, size*0.9);
        ctx.lineTo(-size*0.45, size*0.9);
        ctx.lineTo(-size*0.7, -size*0.2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (affixId === "arcane") {
        ctx.beginPath();
        ctx.moveTo(0, -size);
        ctx.lineTo(size, 0);
        ctx.lineTo(0, size);
        ctx.lineTo(-size, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (affixId === "swift") {
        ctx.beginPath();
        ctx.moveTo(-size*0.9, -size*0.5);
        ctx.lineTo(0, 0);
        ctx.lineTo(-size*0.9, size*0.5);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, -size*0.5);
        ctx.lineTo(size*0.9, 0);
        ctx.lineTo(0, size*0.5);
        ctx.stroke();
      } else if (affixId === "regen") {
        ctx.beginPath();
        ctx.moveTo(-size*0.2, -size);
        ctx.lineTo(size*0.2, -size);
        ctx.lineTo(size*0.2, -size*0.2);
        ctx.lineTo(size, -size*0.2);
        ctx.lineTo(size, size*0.2);
        ctx.lineTo(size*0.2, size*0.2);
        ctx.lineTo(size*0.2, size);
        ctx.lineTo(-size*0.2, size);
        ctx.lineTo(-size*0.2, size*0.2);
        ctx.lineTo(-size, size*0.2);
        ctx.lineTo(-size, -size*0.2);
        ctx.lineTo(-size*0.2, -size*0.2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else if (affixId === "volatile") {
        ctx.beginPath();
        for (let i=0; i<6; i++){
          const a = (Math.PI * 2 * i) / 6;
          const r = (i % 2 === 0) ? size : size * 0.45;
          ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      ctx.restore();
    }

    drawStatusIcon(ctx, kind, cx, cy, size){
      ctx.save();
      ctx.translate(cx, cy);
      ctx.lineWidth = 2;
      const colors = {
        resist: "rgba(59,130,246,0.85)",
        plate: "rgba(251,146,60,0.85)",
        shield: "rgba(56,189,248,0.85)",
        decay: "rgba(34,197,94,0.85)"
      };
      ctx.strokeStyle = colors[kind] || "rgba(255,255,255,0.8)";
      ctx.fillStyle = "rgba(15,23,42,0.55)";

      if (kind === "resist") {
        ctx.beginPath();
        ctx.arc(0, 0, size*0.9, 0, Math.PI*2);
        ctx.stroke();
      } else if (kind === "plate") {
        ctx.beginPath();
        ctx.rect(-size, -size*0.6, size*2, size*1.2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-size*0.6, -size*0.2);
        ctx.lineTo(size*0.6, -size*0.2);
        ctx.moveTo(-size*0.6, size*0.2);
        ctx.lineTo(size*0.6, size*0.2);
        ctx.stroke();
      } else if (kind === "shield") {
        ctx.beginPath();
        ctx.moveTo(0, -size);
        ctx.lineTo(size*0.8, -size*0.2);
        ctx.lineTo(size*0.5, size);
        ctx.lineTo(-size*0.5, size);
        ctx.lineTo(-size*0.8, -size*0.2);
        ctx.closePath();
        ctx.stroke();
      } else if (kind === "decay") {
        ctx.beginPath();
        ctx.moveTo(0, -size);
        ctx.quadraticCurveTo(size*0.8, -size*0.2, 0, size);
        ctx.quadraticCurveTo(-size*0.8, -size*0.2, 0, -size);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-size*0.4, size*0.9);
        ctx.lineTo(size*0.4, size*0.9);
        ctx.stroke();
      }

      ctx.restore();
    }

    getStaticMapCacheKey(){
      const bgSrc = this.mapBg?.currentSrc || this.mapBg?.src || "";
      return [
        this.map?.w || 0,
        this.map?.h || 0,
        this.tileSize || 0,
        this.useMapBackground ? 1 : 0,
        this.mapBgReady ? 1 : 0,
        this.mapBg?.width || 0,
        this.mapBg?.height || 0,
        bgSrc
      ].join("|");
    }

    renderStaticMapLayer(ctx, ox, oy){
      if (!ctx || !this.map || !(this.tileSize > 0)) return;
      this._staticMapRenderCount = (this._staticMapRenderCount || 0) + 1;

      if (this.useMapBackground && this.mapBgReady && this.mapBg && this.tileSize > 0) {
        const w = this.map.w * this.tileSize;
        const h = this.map.h * this.tileSize;
        const bgDef = this.getMapBackgroundDef();
        const crop = bgDef.crop || { x: 0, y: 0, w: 1, h: 1 };
        const sx = Math.round(this.mapBg.width * crop.x);
        const sy = Math.round(this.mapBg.height * crop.y);
        const sw = Math.round(this.mapBg.width * crop.w);
        const sh = Math.round(this.mapBg.height * crop.h);
        const scale = bgDef.scale ?? 1;
        const dw = w * scale;
        const dh = h * scale;
        const dx = ox + (w - dw) / 2;
        const dy = oy + (h - dh) / 2;
        ctx.drawImage(this.mapBg, sx, sy, sw, sh, dx, dy, dw, dh);
      }

      for(let y=0;y<this.map.h;y++){
        for(let x=0;x<this.map.w;x++){
          const px=ox + x*this.tileSize;
          const py=oy + y*this.tileSize;
          const isPath=this.map.isPath(x,y);
          const isObstacle = this.map.isObstacle ? this.map.isObstacle(x, y) : (this.map.grid?.[y]?.[x] === 2);
          ctx.fillStyle = isPath
            ? "rgba(255,255,255,0.10)"
            : (isObstacle ? "rgba(249,115,22,0.20)" : "rgba(255,255,255,0.03)");
          ctx.fillRect(px,py,this.tileSize,this.tileSize);
          if (isObstacle) {
            const pad = Math.max(4, this.tileSize * 0.24);
            ctx.strokeStyle = "rgba(255,237,213,0.95)";
            ctx.lineWidth = Math.max(2, this.tileSize * 0.08);
            ctx.beginPath();
            ctx.moveTo(px + pad, py + pad);
            ctx.lineTo(px + this.tileSize - pad, py + this.tileSize - pad);
            ctx.moveTo(px + this.tileSize - pad, py + pad);
            ctx.lineTo(px + pad, py + this.tileSize - pad);
            ctx.stroke();
          }
        }
      }

      ctx.strokeStyle="rgba(255,255,255,0.06)";
      ctx.lineWidth=1;
      const lineOx=ox + 0.5;
      const lineOy=oy + 0.5;
      for(let x=0;x<=this.map.w;x++){
        const px=lineOx + x*this.tileSize;
        ctx.beginPath();
        ctx.moveTo(px, lineOy);
        ctx.lineTo(px, lineOy + this.map.h*this.tileSize);
        ctx.stroke();
      }
      for(let y=0;y<=this.map.h;y++){
        const py=lineOy + y*this.tileSize;
        ctx.beginPath();
        ctx.moveTo(lineOx, py);
        ctx.lineTo(lineOx + this.map.w*this.tileSize, py);
        ctx.stroke();
      }

      const drawEndpoint = (gx, gy, kind) => {
        const px=ox + gx*this.tileSize;
        const py=oy + gy*this.tileSize;
        const isEntrance = kind === "entrance";
        const fill = isEntrance ? "rgba(34,197,94,0.32)" : "rgba(239,68,68,0.38)";
        const rim = isEntrance ? "rgba(134,239,172,0.92)" : "rgba(254,202,202,0.95)";
        const glow = isEntrance ? "rgba(34,197,94,0.34)" : "rgba(239,68,68,0.38)";
        const inset = Math.max(3, this.tileSize * 0.14);
        const cx = px + this.tileSize * 0.5;
        const cy = py + this.tileSize * 0.5;
        const radius = Math.max(4, this.tileSize * 0.28);

        ctx.save();
        ctx.fillStyle = fill;
        ctx.strokeStyle = rim;
        ctx.lineWidth = Math.max(1.5, this.tileSize * 0.055);
        ctx.shadowBlur = Math.max(6, this.tileSize * 0.32);
        ctx.shadowColor = glow;
        ctx.fillRect(px + inset, py + inset, this.tileSize - inset * 2, this.tileSize - inset * 2);
        ctx.strokeRect(px + inset, py + inset, this.tileSize - inset * 2, this.tileSize - inset * 2);
        ctx.shadowBlur = 0;
        ctx.beginPath();
        if (isEntrance) {
          ctx.moveTo(cx - radius * 0.55, cy - radius * 0.72);
          ctx.lineTo(cx + radius * 0.72, cy);
          ctx.lineTo(cx - radius * 0.55, cy + radius * 0.72);
        } else {
          ctx.moveTo(cx, cy - radius);
          ctx.lineTo(cx + radius, cy);
          ctx.lineTo(cx, cy + radius);
          ctx.lineTo(cx - radius, cy);
          ctx.closePath();
        }
        ctx.stroke();
        ctx.restore();
      };
      drawEndpoint(this.map.entrance.x, this.map.entrance.y, "entrance");
      drawEndpoint(this.map.exit.x, this.map.exit.y, "exit");
    }

    ensureStaticMapCache(){
      if (!this.staticMapCanvas || !this.cv || !this.staticMapCtx) return null;
      const width = Math.max(2, Math.ceil((this.map?.w || 0) * (this.tileSize || 0)));
      const height = Math.max(2, Math.ceil((this.map?.h || 0) * (this.tileSize || 0)));
      const key = this.getStaticMapCacheKey();
      if (this._staticMapCacheKey === key
        && this.staticMapCanvas.width === width
        && this.staticMapCanvas.height === height) {
        return this.staticMapCanvas;
      }
      this.staticMapCanvas.width = width;
      this.staticMapCanvas.height = height;
      this.staticMapCtx.clearRect(0, 0, width, height);
      this.renderStaticMapLayer(this.staticMapCtx, 0, 0);
      this._staticMapCacheKey = key;
      return this.staticMapCanvas;
    }

    drawCoreThreatIndicator(ctx, tNow){
      const pathLength = Math.max(1, (this.map?.path?.length || 1) - 1);
      let frontEnemy = null;
      let frontProgress = 0;
      for (const enemy of this.enemies) {
        if (!enemy || enemy.dead || enemy.reachedExit) continue;
        const progress = clamp((Number(enemy.pathIndex) || 0) / pathLength, 0, 1);
        if (progress > frontProgress) {
          frontProgress = progress;
          frontEnemy = enemy;
        }
      }
      if (!frontEnemy || frontProgress < 0.68) return;

      const intensity = clamp((frontProgress - 0.68) / 0.32, 0, 1);
      const lowEffects = this.isLowEffectsEnabled();
      const pulse = lowEffects ? 0.72 : (0.52 + 0.48 * Math.sin(tNow * (5.5 + intensity * 4.0)));
      const coreX = this.offsetX + (this.map.exit.x + 0.5) * this.tileSize;
      const coreY = this.offsetY + (this.map.exit.y + 0.5) * this.tileSize;
      const baseRadius = this.tileSize * (0.46 + intensity * 0.22);

      ctx.save();
      ctx.strokeStyle = `rgba(248,113,113,${0.26 + intensity * 0.34})`;
      ctx.lineWidth = Math.max(2, this.tileSize * 0.065);
      ctx.shadowBlur = lowEffects ? 0 : Math.max(8, this.tileSize * (0.36 + intensity * 0.34));
      ctx.shadowColor = `rgba(239,68,68,${0.42 + intensity * 0.35})`;
      ctx.beginPath();
      ctx.arc(coreX, coreY, baseRadius * (1.08 + 0.16 * pulse), 0, Math.PI * 2);
      ctx.stroke();

      if (!lowEffects && intensity >= 0.35) {
        const enemyX = this.offsetX + frontEnemy.x * this.tileSize;
        const enemyY = this.offsetY + frontEnemy.y * this.tileSize;
        ctx.setLineDash([Math.max(3, this.tileSize * 0.12), Math.max(4, this.tileSize * 0.16)]);
        ctx.lineDashOffset = -tNow * this.tileSize * 0.9;
        ctx.strokeStyle = `rgba(251,113,133,${0.12 + intensity * 0.22})`;
        ctx.lineWidth = Math.max(1.3, this.tileSize * 0.035);
        ctx.beginPath();
        ctx.moveTo(enemyX, enemyY);
        ctx.lineTo(coreX, coreY);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawSelectedTowerTargetAssist(ctx, tower, tNow){
      const target = tower?.lockedTarget;
      if (!target || target.dead || target.reachedExit) return;
      const ax = this.offsetX + tower.x * this.tileSize;
      const ay = this.offsetY + tower.y * this.tileSize;
      const bx = this.offsetX + target.x * this.tileSize;
      const by = this.offsetY + target.y * this.tileSize;
      const lowEffects = this.isLowEffectsEnabled();
      const pulse = lowEffects ? 0.72 : (0.55 + 0.45 * Math.sin(tNow * 7.0));

      ctx.save();
      ctx.setLineDash([Math.max(4, this.tileSize * 0.15), Math.max(5, this.tileSize * 0.20)]);
      ctx.lineDashOffset = -tNow * this.tileSize * 1.15;
      ctx.strokeStyle = `rgba(125,211,252,${0.42 + 0.30 * pulse})`;
      ctx.lineWidth = Math.max(1.3, this.tileSize * 0.045);
      ctx.shadowBlur = lowEffects ? 0 : Math.max(5, this.tileSize * 0.22);
      ctx.shadowColor = "rgba(56,189,248,0.64)";
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = `rgba(186,230,253,${0.55 + 0.35 * pulse})`;
      ctx.beginPath();
      ctx.arc(bx, by, Math.max(2.5, this.tileSize * 0.09), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    drawAttackFlashes(ctx, lowEffects = this.isLowEffectsEnabled()){
      for (const flash of this.attackFlashes) {
        if (!flash || flash.life <= 0 || flash.maxLife <= 0) continue;
        const a = clamp(flash.life / flash.maxLife, 0, 1);
        const progress = 1 - a;
        const px = this.offsetX + flash.x * this.tileSize;
        const py = this.offsetY + flash.y * this.tileSize;
        const angle = Math.atan2(flash.dy || 0, flash.dx || 1);
        const baseColor = flash.color || "rgba(255,255,255,0.92)";
        const glowColor = baseColor.replace(/[\d.]+\)$/, `${(0.22 + a * 0.42).toFixed(3)})`);
        const brightColor = baseColor.replace(/[\d.]+\)$/, `${(0.62 + a * 0.36).toFixed(3)})`);
        const length = this.tileSize * (flash.isCritical ? 0.48 : 0.36) * (0.75 + progress * 0.58);
        const halfWidth = this.tileSize * (flash.isCritical ? 0.19 : 0.13) * (0.82 + progress * 0.20);

        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(angle);
        ctx.globalAlpha = a;
        ctx.lineCap = "round";
        if (!lowEffects) {
          ctx.shadowBlur = Math.max(5, halfWidth * 3.4);
          ctx.shadowColor = baseColor;
        }

        ctx.fillStyle = glowColor;
        ctx.beginPath();
        ctx.moveTo(-this.tileSize * 0.08, -halfWidth);
        ctx.lineTo(length, 0);
        ctx.lineTo(-this.tileSize * 0.08, halfWidth);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = brightColor;
        ctx.lineWidth = Math.max(1.4, halfWidth * 0.38);
        ctx.beginPath();
        ctx.moveTo(-this.tileSize * 0.10, 0);
        ctx.lineTo(length * 0.90, 0);
        ctx.stroke();

        if (flash.kind === "mage") {
          ctx.lineWidth = Math.max(1.1, halfWidth * 0.22);
          ctx.beginPath();
          ctx.arc(0, 0, Math.max(2, halfWidth * 1.1), -Math.PI * 0.70, Math.PI * 0.70);
          ctx.stroke();
        } else if (flash.kind === "poison") {
          ctx.fillStyle = brightColor;
          ctx.beginPath();
          ctx.arc(length * 0.35, -halfWidth * 0.62, Math.max(1.2, halfWidth * 0.20), 0, Math.PI * 2);
          ctx.arc(length * 0.58, halfWidth * 0.45, Math.max(1.0, halfWidth * 0.16), 0, Math.PI * 2);
          ctx.fill();
        } else if (flash.kind === "breaker") {
          ctx.lineWidth = Math.max(1.2, halfWidth * 0.24);
          ctx.beginPath();
          ctx.moveTo(length * 0.42, -halfWidth * 1.2);
          ctx.lineTo(length * 0.62, halfWidth * 1.2);
          ctx.moveTo(length * 0.42, halfWidth * 1.2);
          ctx.lineTo(length * 0.62, -halfWidth * 1.2);
          ctx.stroke();
        } else if (flash.kind === "sniper") {
          ctx.lineWidth = Math.max(1.2, halfWidth * 0.22);
          ctx.beginPath();
          ctx.moveTo(-length * 0.32, 0);
          ctx.lineTo(length * 1.22, 0);
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    draw(){
      const ctx=this.ctx;
      ctx.clearRect(0,0,this.cv.width,this.cv.height);
      const tNow = now();
      const reducedEffects = this.isLowEffectsEnabled();
      const staticMapLayer = this.ensureStaticMapCache();
      const baseOffsetX = this.offsetX;
      const baseOffsetY = this.offsetY;
      const shake = this.getScreenShakeOffset();
      if (shake.x !== 0 || shake.y !== 0) {
        this.offsetX = baseOffsetX + shake.x;
        this.offsetY = baseOffsetY + shake.y;
      }

      if (staticMapLayer) {
        ctx.drawImage(staticMapLayer, baseOffsetX + shake.x, baseOffsetY + shake.y);
      } else {
        this.renderStaticMapLayer(ctx, this.offsetX, this.offsetY);
      }
      this.drawCoreThreatIndicator(ctx, tNow);

      // selected tower range
      if(this.selectedTowerInstance){
        const t=this.selectedTowerInstance;
        const cx=this.offsetX + t.x*this.tileSize;
        const cy=this.offsetY + t.y*this.tileSize;
        const lowEffects = reducedEffects;
        const pulse = lowEffects ? 0.72 : (0.58 + 0.42 * Math.sin(tNow * 3.8));
        ctx.fillStyle = "rgba(56,189,248,0.035)";
        ctx.beginPath();
        ctx.arc(cx,cy,t.range*this.tileSize,0,Math.PI*2);
        ctx.fill();
        ctx.strokeStyle=`rgba(125,211,252,${0.25 + 0.22 * pulse})`;
        ctx.lineWidth=Math.max(1.5, this.tileSize * 0.045);
        ctx.setLineDash([Math.max(4, this.tileSize * 0.15), Math.max(4, this.tileSize * 0.18)]);
        ctx.lineDashOffset = -tNow * this.tileSize * 0.6;
        ctx.beginPath();
        ctx.arc(cx,cy,t.range*this.tileSize,0,Math.PI*2);
        ctx.stroke();
        ctx.setLineDash([]);
        this.drawSelectedTowerTargetAssist(ctx, t, tNow);
      }

      if(this.selectedTowerDef && this.hoverGrid){
        const d = this.selectedTowerDef;
        const g = this.hoverGrid;
        const canPlace = this.canPlaceTowerAt(g.x, g.y, d);
        const sizeTiles = d.size ?? 1;
        const px = this.offsetX + g.x*this.tileSize;
        const py = this.offsetY + g.y*this.tileSize;
        const w = this.tileSize * sizeTiles;
        const h = this.tileSize * sizeTiles;
        const cx = px + w/2;
        const cy = py + h/2;
        const range = Math.max(0, d.base?.Range ?? 0);

        ctx.fillStyle = canPlace ? "rgba(34,197,94,0.18)" : "rgba(239,68,68,0.20)";
        ctx.fillRect(px, py, w, h);
        ctx.strokeStyle = canPlace ? "rgba(34,197,94,0.60)" : "rgba(239,68,68,0.70)";
        ctx.lineWidth = 2;
        ctx.strokeRect(px+1, py+1, w-2, h-2);

        if (range > 0) {
          ctx.strokeStyle = canPlace ? "rgba(56,189,248,0.35)" : "rgba(239,68,68,0.30)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx, cy, range*this.tileSize, 0, Math.PI*2);
          ctx.stroke();
        }

        const ghostTower = { def: d, level: 1, x: g.x + sizeTiles/2, y: g.y + sizeTiles/2, size: sizeTiles };
        ctx.save();
        ctx.globalAlpha = 0.55;
        this.drawTowerIcon(ctx, ghostTower, cx, cy, this.tileSize*0.90*(sizeTiles ?? 1));
        ctx.restore();
      }

      // rings
      const ringDrawStart = Math.max(0, this.rings.length - this.getVisualBudget("rings"));
      for(let ringIndex = ringDrawStart; ringIndex < this.rings.length; ringIndex += 1){
        const r = this.rings[ringIndex];
        const cx=this.offsetX + r.x*this.tileSize;
        const cy=this.offsetY + r.y*this.tileSize;
        const a=r.alpha();
        ctx.strokeStyle = r.color.replace(/[\d.]+\)$/,""+(0.10+0.50*a)+")");
        ctx.lineWidth = r.width ?? 3;
        ctx.beginPath();
        ctx.arc(cx,cy,r.r*this.tileSize,0,Math.PI*2);
        ctx.stroke();
      }

      // peel buff links
      for (const t of this.towers) {
        const buffs = t.peelBuffs ? Object.entries(t.peelBuffs).filter(([, b]) => b.time > 0) : [];
        if (!buffs.length) continue;
        for (let i = 0; i < buffs.length; i++) {
          const [kind, buff] = buffs[i];
          const source = buff.source;
          if (!source || !this.towers.includes(source)) continue;
          const info = PEEL_BUFF_INFO[kind] || { color: "rgba(14,165,233,0.95)" };
          const total = buff.maxTime ?? CFG.PEEL_BUFF_DURATION;
          const a = clamp(buff.time / total, 0, 1);
          const pulse = 0.55 + 0.45 * Math.sin(tNow * 8.0 + i);
          const ax = this.offsetX + source.x * this.tileSize;
          const ay = this.offsetY + source.y * this.tileSize;
          const bx = this.offsetX + t.x * this.tileSize;
          const by = this.offsetY + t.y * this.tileSize;
          const mx = (ax + bx) * 0.5;
          const my = (ay + by) * 0.5;
          const dx = bx - ax;
          const dy = by - ay;
          const len = Math.max(0.0001, Math.hypot(dx, dy));
          const nx = -dy / len;
          const ny = dx / len;
          const arc = Math.min(this.tileSize * 2.60, len * 0.60);
          const cx = mx + nx * arc;
          const cy = my + ny * arc;

          ctx.strokeStyle = info.color.replace(/[\d.]+\)$/,""+(0.18 + 0.35 * a * pulse)+")");
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(cx, cy, bx, by);
          ctx.stroke();

          ctx.strokeStyle = info.color.replace(/[\d.]+\)$/,""+(0.55 + 0.35 * a)+")");
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(cx, cy, bx, by);
          ctx.stroke();
        }
      }

      // towers
      const drawTowers = [...this.towers].sort((a,b)=>{
        if (a.y !== b.y) return a.y - b.y;
        return a.x - b.x;
      });
      const towerOverlayQueue = [];
      for(const t of drawTowers){
        const px=this.offsetX + t.gx*this.tileSize;
        const py=this.offsetY + t.gy*this.tileSize;
        const sizeTiles = t.size ?? 1;
        const cx=px + (this.tileSize*sizeTiles)/2;
        const cy=py + (this.tileSize*sizeTiles)/2;

        const sizePx = this.tileSize * (t.size ?? 1);
        if(t===this.selectedTowerInstance){
          ctx.strokeStyle="rgba(56,189,248,0.55)";
          ctx.lineWidth=2;
          ctx.beginPath();
          ctx.rect(px+2,py+2,sizePx-4,sizePx-4);
          ctx.stroke();
        }

        // LV20+ aura
        if (t.level >= CFG.TOWER_MAX_LEVEL) {
          const isPrestige = t.level >= CFG.PRESTIGE_LEVEL;
          const pulse = 0.55 + 0.45 * Math.sin(tNow * (isPrestige ? 5.2 : 4.4));
          const alphaBase = isPrestige ? 0.14 : 0.10;
          const alphaPulse = isPrestige ? 0.16 : 0.12;
          const col = isPrestige
            ? `rgba(56,189,248,${alphaBase + alphaPulse * pulse})`
            : `rgba(250,204,21,${alphaBase + alphaPulse * pulse})`;
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.arc(cx, cy, this.tileSize * (0.42 + 0.08 * pulse) * (t.size ?? 1), 0, Math.PI * 2);
          ctx.fill();
        }

        const peelEntries = t.peelBuffs ? Object.entries(t.peelBuffs).filter(([, b]) => b.time > 0) : [];
        if (peelEntries.length) {
          peelEntries.sort((a,b)=>a[0].localeCompare(b[0]));
          let idx = 0;
          for (const [kind, buff] of peelEntries) {
            const info = PEEL_BUFF_INFO[kind] || { color: "rgba(14,165,233,0.95)" };
            const total = buff.maxTime ?? CFG.PEEL_BUFF_DURATION;
            const a = clamp(buff.time / total, 0, 1);
            const ringBase = this.tileSize * 0.40 * (t.size ?? 1);
            const ringGap = this.tileSize * 0.095;
            const r = ringBase + idx * ringGap;
            ctx.save();
            ctx.strokeStyle = info.color.replace(/[\d.]+\)$/,""+(0.64 + 0.28 * a)+")");
            ctx.lineWidth = 3.0;
            ctx.shadowBlur = 10;
            ctx.shadowColor = info.color.replace(/[\d.]+\)$/,"0.80)");
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI*2);
            ctx.stroke();
            ctx.restore();
            ctx.strokeStyle = info.color.replace(/[\d.]+\)$/,""+(0.80 + 0.16 * a)+")");
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.arc(cx, cy, Math.max(1, r - this.tileSize * 0.04), 0, Math.PI*2);
            ctx.stroke();
            idx += 1;
          }
        }

        this.drawTowerIcon(ctx,t,cx,cy,this.tileSize*0.90*(t.size ?? 1));

        towerOverlayQueue.push({ t, px, py, sizePx });

      }

      for (const item of towerOverlayQueue) {
        const t = item.t;
        const px = item.px;
        const py = item.py;
        const sizePx = item.sizePx;
        const primaryPct = (t.maxMana > 0) ? clamp(t.mana / t.maxMana, 0, 1) : 0;
        const prestigePct = (t.level >= CFG.PRESTIGE_LEVEL && t.prestigeMaxMana > 0)
          ? clamp(t.prestigeMana / t.prestigeMaxMana, 0, 1)
          : 0;
        const badgeCol = (t.level >= CFG.PRESTIGE_LEVEL) ? "rgba(165,210,255,0.95)" : "rgba(250,204,21,0.95)";
        this.drawLevelBadge(ctx, t.level, px, py, this.tileSize, badgeCol, primaryPct, prestigePct);

        if (t.def.id === "sniper" && (t.secondaryLevel ?? 0) > 0) {
          const rr = this.tileSize * 0.12;
          const rcx = px + sizePx - rr - 4;
          const rcy = py + rr + 4;
          const over100 = (t.secondaryLevel ?? 0) >= 100;
          ctx.fillStyle = over100 ? "rgba(34,197,94,0.55)" : "rgba(34,197,94,0.38)";
          ctx.strokeStyle = "rgba(34,197,94,0.95)";
          ctx.lineWidth = 1.8;
          if (over100) {
            ctx.save();
            ctx.shadowBlur = Math.max(8, rr * 2.4);
            ctx.shadowColor = "rgba(34,197,94,0.72)";
          }
          ctx.beginPath();
          ctx.arc(rcx, rcy, rr, 0, Math.PI*2);
          ctx.fill();
          ctx.stroke();
          if (over100) ctx.restore();
          ctx.fillStyle = "rgba(220,252,231,0.98)";
          ctx.font = `700 ${Math.max(10, Math.floor(this.tileSize*0.16))}px system-ui`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(t.secondaryLevel), rcx, rcy+0.5);
        }
      }

      // Render-only muzzle flashes: they deliberately sit behind enemies and
      // projectiles, so they communicate a shot without obscuring its target.
      this.drawAttackFlashes(ctx, reducedEffects);

      // enemies
      for(const e of this.enemies){
        const px=this.offsetX + e.x*this.tileSize;
        const py=this.offsetY + e.y*this.tileSize;

        const hpScale = clamp((0.85 + Math.log2(Math.max(16, e.maxHP))/12) * 1.12, 0.95, 1.7);
        const bossScale = e.isBoss ? 1.6 : 1.0;

        const walkFreq = 4.0 + e.baseSpeed*2.5;
        const walkAmp = 0.05 + e.baseSpeed*0.015;
        const pulse = 1 + Math.sin((tNow - e.birthT)*walkFreq) * walkAmp;

        const radius = this.tileSize * 0.23 * hpScale * bossScale * pulse;

        if (e.typeId === "siphon") {
          const auraR = CFG.MANA_BURN_AURA_RADIUS_TILES * this.tileSize;
          ctx.strokeStyle = "rgba(14,165,233,0.30)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(px, py, auraR, 0, Math.PI*2);
          ctx.stroke();
        }

        ctx.fillStyle="rgba(0,0,0,0.30)";
        ctx.beginPath();
        ctx.ellipse(px, py + radius*0.98, radius*0.92, radius*0.36, 0, 0, Math.PI*2);
        ctx.fill();

        const palette = e.isBoss
          ? { bright:"rgba(255,248,178,0.98)", mid:"rgba(250,204,21,0.92)", deep:"rgba(133,77,14,0.96)", rim:"rgba(254,240,138,0.95)" }
          : (e.typeId==="tank")
            ? { bright:"rgba(241,245,249,0.95)", mid:"rgba(148,163,184,0.90)", deep:"rgba(51,65,85,0.95)", rim:"rgba(226,232,240,0.90)" }
            : (e.typeId==="siphon")
              ? { bright:"rgba(186,230,253,0.97)", mid:"rgba(14,165,233,0.92)", deep:"rgba(12,74,110,0.96)", rim:"rgba(125,211,252,0.92)" }
              : { bright:"rgba(251,207,232,0.96)", mid:"rgba(236,72,153,0.90)", deep:"rgba(131,24,67,0.96)", rim:"rgba(251,113,133,0.90)" };

        const bodyGrad = ctx.createRadialGradient(
          px - radius*0.38, py - radius*0.40, radius*0.10,
          px, py, radius*1.08
        );
        bodyGrad.addColorStop(0.00, palette.bright);
        bodyGrad.addColorStop(0.22, palette.mid);
        bodyGrad.addColorStop(0.66, palette.mid.replace(/[\d.]+\)$/,"0.78)"));
        bodyGrad.addColorStop(1.00, palette.deep);

        ctx.save();
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI*2);
        ctx.clip();
        ctx.fillStyle = bodyGrad;
        ctx.fillRect(px - radius - 2, py - radius - 2, radius*2 + 4, radius*2 + 4);

        const bounceGrad = ctx.createLinearGradient(px - radius*0.6, py - radius*0.2, px + radius*0.9, py + radius*0.8);
        bounceGrad.addColorStop(0.00, "rgba(255,255,255,0.00)");
        bounceGrad.addColorStop(0.65, "rgba(255,255,255,0.05)");
        bounceGrad.addColorStop(1.00, "rgba(255,255,255,0.18)");
        ctx.fillStyle = bounceGrad;
        ctx.fillRect(px - radius - 2, py - radius - 2, radius*2 + 4, radius*2 + 4);

        ctx.globalAlpha = 0.90;
        ctx.fillStyle = "rgba(255,255,255,0.72)";
        ctx.beginPath();
        ctx.ellipse(px - radius*0.34, py - radius*0.36, radius*0.27, radius*0.18, -0.42, 0, Math.PI*2);
        ctx.fill();
        ctx.globalAlpha = 0.55;
        ctx.fillStyle = "rgba(255,255,255,0.35)";
        ctx.beginPath();
        ctx.ellipse(px - radius*0.14, py - radius*0.16, radius*0.13, radius*0.08, -0.36, 0, Math.PI*2);
        ctx.fill();

        ctx.globalAlpha = 0.38;
        ctx.fillStyle = "rgba(2,6,23,0.88)";
        ctx.beginPath();
        ctx.arc(px + radius*0.32, py + radius*0.28, radius*0.52, 0, Math.PI*2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.restore();

        // Each enemy type keeps the shared lighting treatment above, then gets
        // a small silhouette cue that remains legible even in a crowded wave.
        const lowEffects = reducedEffects;
        const detailPulse = lowEffects ? 0.70 : (0.56 + 0.44 * Math.sin((tNow - e.birthT) * 5.4));
        ctx.save();
        ctx.translate(px, py);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        if (e.isBoss) {
          const spin = lowEffects ? 0 : (tNow - e.birthT) * 0.65;
          ctx.rotate(spin);
          ctx.strokeStyle = `rgba(255,248,178,${0.72 + 0.22 * detailPulse})`;
          ctx.lineWidth = Math.max(1.5, radius * 0.10);
          for (let spike = 0; spike < 6; spike += 1) {
            const angle = -Math.PI / 2 + (Math.PI * 2 * spike) / 6;
            ctx.beginPath();
            ctx.moveTo(Math.cos(angle) * radius * 0.62, Math.sin(angle) * radius * 0.62);
            ctx.lineTo(Math.cos(angle) * radius * (0.92 + 0.10 * detailPulse), Math.sin(angle) * radius * (0.92 + 0.10 * detailPulse));
            ctx.stroke();
          }
          ctx.fillStyle = "rgba(15,23,42,0.76)";
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.26, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(255,248,178,0.95)";
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.10, 0, Math.PI * 2);
          ctx.fill();
        } else if (e.typeId === "tank") {
          ctx.fillStyle = "rgba(15,23,42,0.38)";
          ctx.strokeStyle = "rgba(226,232,240,0.78)";
          ctx.lineWidth = Math.max(1.4, radius * 0.09);
          ctx.beginPath();
          for (let side = 0; side < 6; side += 1) {
            const angle = -Math.PI / 2 + (Math.PI * 2 * side) / 6;
            const x = Math.cos(angle) * radius * 0.68;
            const y = Math.sin(angle) * radius * 0.68;
            if (side === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = "rgba(241,245,249,0.88)";
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.17, 0, Math.PI * 2);
          ctx.fill();
        } else if (e.typeId === "siphon") {
          const spin = lowEffects ? 0 : (tNow - e.birthT) * 2.4;
          ctx.rotate(spin);
          ctx.strokeStyle = `rgba(186,230,253,${0.62 + 0.24 * detailPulse})`;
          ctx.lineWidth = Math.max(1.25, radius * 0.075);
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.62, -0.30, Math.PI * 0.78);
          ctx.arc(0, 0, radius * 0.62, Math.PI - 0.30, Math.PI * 1.78);
          ctx.stroke();
          ctx.fillStyle = "rgba(224,242,254,0.90)";
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.16, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "rgba(2,132,199,0.94)";
          ctx.beginPath();
          ctx.arc(0, 0, radius * 0.07, 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Runners use a visor and speed chevrons instead of extra size, so
          // their quick movement is recognizable without hiding the path.
          ctx.strokeStyle = `rgba(253,242,248,${0.62 + 0.24 * detailPulse})`;
          ctx.lineWidth = Math.max(1.2, radius * 0.085);
          ctx.beginPath();
          ctx.moveTo(-radius * 1.10, -radius * 0.30);
          ctx.lineTo(-radius * 0.72, 0);
          ctx.lineTo(-radius * 1.10, radius * 0.30);
          ctx.moveTo(-radius * 0.78, -radius * 0.18);
          ctx.lineTo(-radius * 0.52, 0);
          ctx.lineTo(-radius * 0.78, radius * 0.18);
          ctx.stroke();
          ctx.fillStyle = "rgba(15,23,42,0.72)";
          ctx.fillRect(-radius * 0.48, -radius * 0.22, radius * 0.96, radius * 0.31);
          ctx.fillStyle = "rgba(251,207,232,0.94)";
          ctx.fillRect(-radius * 0.28, -radius * 0.13, radius * 0.56, radius * 0.09);
        }
        ctx.restore();

        ctx.lineWidth = Math.max(2, Math.floor(radius * 0.18));
        ctx.strokeStyle = "rgba(15,23,42,0.88)";
        ctx.beginPath();
        ctx.arc(px, py, radius, 0, Math.PI*2);
        ctx.stroke();
        ctx.lineWidth = Math.max(1, Math.floor(radius * 0.09));
        ctx.strokeStyle = palette.rim;
        ctx.beginPath();
        ctx.arc(px, py, radius*0.94, -0.20, Math.PI*1.54);
        ctx.stroke();

        if (e.isBoss && e.bossSkills) {
          const activeSkills = Object.values(e.bossSkills).filter(s => s.active);
          if (activeSkills.length) {
            let i = 0;
            for (const s of activeSkills) {
              const info = BOSS_SKILL_INFO[s.id] || { name: s.name, color: "rgba(168,85,247,0.70)" };
              const cd = s.cd || 1;
              const progress = clamp(1 - (s.timer || 0) / cd, 0, 1);
              const barH = 14;
              const barY = py + radius + 8 + i * (barH + 4);
              ctx.fillStyle=info.color;
              ctx.fillRect(px-radius, barY, (radius*2)*progress, barH);
              ctx.fillStyle="rgba(255,255,255,0.10)";
              ctx.fillRect(px-radius+(radius*2)*progress, barY, (radius*2)*(1-progress), barH);
              ctx.strokeStyle="rgba(15,23,42,0.85)";
              ctx.lineWidth=1;
              ctx.strokeRect(px-radius, barY, radius*2, barH);

              const label = `${info.name}`;
              let skillFont = Math.max(6, Math.floor(radius*0.30));
              const maxW = Math.max(14, radius * 2 - 6);
              do {
                ctx.font = `700 ${skillFont}px system-ui`;
                if (ctx.measureText(label).width <= maxW || skillFont <= 6) break;
                skillFont -= 1;
              } while (skillFont >= 6);
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillStyle = "rgba(15,23,42,0.85)";
              ctx.fillText(label, px + 1, barY + barH / 2 + 0.5);
              ctx.fillStyle = "rgba(255,255,255,0.95)";
              ctx.fillText(label, px, barY + barH / 2);
              i += 1;
            }
          }
        }

        const primaryModifier = listEnemyModifiers(e)[0] || null;
        if (primaryModifier) {
          const iconY = py;
          const iconSize = Math.max(8, Math.floor(radius*0.72));
          const badgeR = iconSize * 0.78;
          ctx.save();
          ctx.shadowBlur = Math.max(6, badgeR * 1.8);
          ctx.shadowColor = "rgba(255,255,255,0.45)";
          ctx.fillStyle = "rgba(15,23,42,0.60)";
          ctx.beginPath();
          ctx.arc(px, iconY, badgeR, 0, Math.PI*2);
          ctx.fill();
          ctx.restore();
          ctx.strokeStyle = "rgba(255,255,255,0.82)";
          ctx.lineWidth = Math.max(1.6, badgeR * 0.12);
          ctx.beginPath();
          ctx.arc(px, iconY, badgeR, 0, Math.PI*2);
          ctx.stroke();
          if (primaryModifier.iconKind === "affix") {
            this.drawAffixIcon(ctx, primaryModifier.iconId, px, iconY, iconSize);
          } else {
            this.drawStatusIcon(ctx, primaryModifier.iconId || "resist", px, iconY, iconSize * 0.95);
          }
        }

        const zeroArmor = e.armor <= 0.01;
        if (e.armorShredFlat > 0 || zeroArmor) {
          const pulse = 0.55 + 0.45 * Math.sin((tNow - e.birthT) * 8.2);
          const s = radius * (zeroArmor ? (0.70 + 0.08 * pulse) : 0.56);
          const darkW = Math.max(3, radius * 0.16);
          const brightW = Math.max(1.8, radius * 0.08);

          ctx.save();
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.shadowBlur = zeroArmor ? Math.max(12, radius * 0.9) : Math.max(6, radius * 0.45);
          ctx.shadowColor = zeroArmor
            ? `rgba(251,113,133,${0.30 + 0.35 * pulse})`
            : "rgba(239,68,68,0.30)";

          if (zeroArmor) {
            ctx.strokeStyle = `rgba(251,113,133,${0.22 + 0.22 * pulse})`;
            ctx.lineWidth = Math.max(2.4, radius * 0.11);
            ctx.beginPath();
            ctx.arc(px, py, radius * 1.02, 0, Math.PI * 2);
            ctx.stroke();
          }

          ctx.strokeStyle = "rgba(15,23,42,0.92)";
          ctx.lineWidth = darkW;
          ctx.beginPath();
          ctx.moveTo(px - s, py - s); ctx.lineTo(px + s, py + s);
          ctx.moveTo(px + s, py - s); ctx.lineTo(px - s, py + s);
          ctx.stroke();

          ctx.strokeStyle = zeroArmor
            ? `rgba(254,205,211,${0.90 + 0.08 * pulse})`
            : "rgba(248,113,113,0.98)";
          ctx.lineWidth = brightW;
          ctx.beginPath();
          ctx.moveTo(px - s, py - s); ctx.lineTo(px + s, py + s);
          ctx.moveTo(px + s, py - s); ctx.lineTo(px - s, py + s);
          ctx.stroke();

          ctx.restore();
        }

        if(e.slowTime>0){
          ctx.strokeStyle="rgba(255,255,255,0.85)";
          ctx.lineWidth=2;
          ctx.beginPath();
          ctx.arc(px,py,radius*1.25,0,Math.PI*2);
          ctx.stroke();
        }

        if(e.frostbiteTime>0 || e.frostbiteDotTime>0){
          const baseW = radius*1.05;
          const baseH = radius*0.50;
          const cx = px;
          const cy = py + radius*0.95;
          const skew = radius*0.22;
          const semiR = baseW*0.38;

          ctx.fillStyle="rgba(248,250,252,0.70)";
          ctx.strokeStyle="rgba(255,255,255,0.90)";
          ctx.lineWidth=2;

          ctx.beginPath();
          ctx.moveTo(cx - baseW + skew, cy - baseH);
          ctx.lineTo(cx + baseW + skew, cy - baseH);
          ctx.lineTo(cx + baseW - skew, cy + baseH);
          ctx.lineTo(cx - baseW - skew, cy + baseH);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle="rgba(15,23,42,0.20)";
          ctx.beginPath();
          ctx.arc(cx, cy - baseH, semiR, 0, Math.PI, true);
          ctx.fill();
        }

        if(e.poisonStacks > 0){
          const pp = 0.55 + 0.45*Math.sin((tNow - e.birthT)*9.0);
          ctx.fillStyle = `rgba(34,197,94,${0.06 + 0.10*pp})`;
          ctx.beginPath();
          ctx.arc(px, py, radius*1.35, 0, Math.PI*2);
          ctx.fill();

          const stacks = Math.max(0, Number(e.poisonStacks) || 0);
          const stackText = stacks >= 10
            ? String(Math.floor(stacks))
            : stacks.toFixed(1).replace(/\.0$/, "");
          const rawTick = stacks * e.poisonPerTick * (1 - (e.poisonResist || 0));
          const dps = Math.round(applyMagicDamage(rawTick, e.mr, e.poisonMagicPen) * e.damageTakenMultiplier / e.poisonTickCD);
          const poisonLabel = `☣ ${stackText} • ${formatCompact(dps)}/s`;
          const segmentCount = Math.min(6, Math.max(1, Math.ceil(stacks)));
          ctx.save();
          ctx.strokeStyle = `rgba(74,222,128,${0.48 + 0.34 * pp})`;
          ctx.lineWidth = Math.max(1.2, radius * 0.06);
          for (let segment = 0; segment < segmentCount; segment += 1) {
            const start = -Math.PI / 2 + (Math.PI * 2 * segment) / 6 + 0.07;
            const end = start + (Math.PI * 2) / 6 - 0.14;
            ctx.beginPath();
            ctx.arc(px, py, radius * 1.24, start, end);
            ctx.stroke();
          }

          const poisonFont = Math.max(9, Math.floor(radius * 0.42));
          ctx.font = `800 ${poisonFont}px system-ui`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          const badgeW = Math.max(radius * 1.65, ctx.measureText(poisonLabel).width + 12);
          const badgeH = Math.max(13, poisonFont + 7);
          const badgeX = px - badgeW / 2;
          const badgeY = py - radius - (e.isBoss
            ? Math.max(28, this.tileSize * 0.86)
            : Math.max(17, this.tileSize * 0.55));
          const badgeR = Math.min(badgeH / 2, 7);
          ctx.fillStyle = "rgba(6,78,59,0.78)";
          ctx.beginPath();
          ctx.moveTo(badgeX + badgeR, badgeY - badgeH / 2);
          ctx.lineTo(badgeX + badgeW - badgeR, badgeY - badgeH / 2);
          ctx.quadraticCurveTo(badgeX + badgeW, badgeY - badgeH / 2, badgeX + badgeW, badgeY);
          ctx.quadraticCurveTo(badgeX + badgeW, badgeY + badgeH / 2, badgeX + badgeW - badgeR, badgeY + badgeH / 2);
          ctx.lineTo(badgeX + badgeR, badgeY + badgeH / 2);
          ctx.quadraticCurveTo(badgeX, badgeY + badgeH / 2, badgeX, badgeY);
          ctx.quadraticCurveTo(badgeX, badgeY - badgeH / 2, badgeX + badgeR, badgeY - badgeH / 2);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = `rgba(74,222,128,${0.60 + 0.28 * pp})`;
          ctx.lineWidth = 1;
          ctx.stroke();
          if (!lowEffects) {
            ctx.shadowBlur = Math.max(4, poisonFont * 0.8);
            ctx.shadowColor = "rgba(34,197,94,0.55)";
          }
          ctx.fillStyle = "rgba(220,252,231,0.98)";
          ctx.fillText(poisonLabel, px, badgeY + 0.5);
          ctx.restore();
        }

        if(e===this.selectedEnemy){
          ctx.strokeStyle="rgba(250,204,21,0.85)";
          ctx.lineWidth=2;
          ctx.beginPath();
          ctx.arc(px,py,radius*1.35,0,Math.PI*2);
          ctx.stroke();
        }

      }

      // HP bars are always drawn last so debuff visuals and sprites cannot cover them.
      for (const e of this.enemies) {
        const px=this.offsetX + e.x*this.tileSize;
        const py=this.offsetY + e.y*this.tileSize;
        const hpScale = clamp((0.85 + Math.log2(Math.max(16, e.maxHP))/12) * 1.12, 0.95, 1.7);
        const bossScale = e.isBoss ? 1.6 : 1.0;
        const walkFreq = 4.0 + e.baseSpeed*2.5;
        const walkAmp = 0.05 + e.baseSpeed*0.015;
        const pulse = 1 + Math.sin((tNow - e.birthT)*walkFreq) * walkAmp;
        const radius = this.tileSize * 0.23 * hpScale * bossScale * pulse;
        const hpPct = clamp(e.hp / e.maxHP, 0, 1);
        const barH = e.isBoss ? Math.max(6, this.tileSize * 0.10) : Math.max(4, this.tileSize * 0.055);
        const barY = py - radius - Math.max(9, this.tileSize * 0.16);
        const hpColor = e.isBoss
          ? "rgba(250,204,21,0.96)"
          : (hpPct <= 0.25
            ? "rgba(248,113,113,0.94)"
            : (hpPct <= 0.55 ? "rgba(251,191,36,0.92)" : "rgba(74,222,128,0.90)"));
        ctx.save();
        if (e.isBoss || hpPct <= 0.25) {
          ctx.shadowBlur = Math.max(4, barH * 1.8);
          ctx.shadowColor = hpColor;
        }
        ctx.fillStyle = "rgba(2,6,23,0.76)";
        ctx.fillRect(px-radius, barY, radius*2, barH);
        ctx.fillStyle = hpColor;
        ctx.fillRect(px-radius, barY, (radius*2)*hpPct, barH);
        ctx.restore();
        ctx.strokeStyle = e.isBoss ? "rgba(254,240,138,0.92)" : "rgba(15,23,42,0.90)";
        ctx.lineWidth = e.isBoss ? 1.4 : 1;
        ctx.strokeRect(px-radius, barY, radius*2, barH);
        if (e.isBoss) {
          const label = `BOSS • ${Math.ceil(hpPct * 100)}%`;
          ctx.font = `800 ${Math.max(9, Math.floor(this.tileSize * 0.14))}px system-ui`;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillStyle = "rgba(255,248,178,0.98)";
          ctx.fillText(label, px, barY - 3);
          const phase = e.firstBossPhase;
          if (phase) {
            const phaseLabel = phase.bonusPct ? `EXPOSED +${phase.bonusPct}%` : phase.label;
            ctx.fillStyle = "rgba(2,6,23,0.92)";
            const width = ctx.measureText(phaseLabel).width + 10;
            ctx.fillRect(px - width / 2, py + radius + 3, width, 16);
            ctx.textBaseline = "middle";
            ctx.fillStyle = phase.bonusPct ? "#86efac" : "#fde68a";
            ctx.fillText(phaseLabel, px, py + radius + 11);
          }
        }
      }

      const brightenRgba = (rgba, mix=0.42, alpha=0.98) => {
        const m = rgba.match(/rgba?\(([^)]+)\)/i);
        if (!m) return `rgba(255,255,255,${alpha})`;
        const parts = m[1].split(",").map(s => s.trim());
        const r = clamp(parseFloat(parts[0]) || 255, 0, 255);
        const g = clamp(parseFloat(parts[1]) || 255, 0, 255);
        const b = clamp(parseFloat(parts[2]) || 255, 0, 255);
        const lr = Math.round(r + (255 - r) * mix);
        const lg = Math.round(g + (255 - g) * mix);
        const lb = Math.round(b + (255 - b) * mix);
        return `rgba(${lr},${lg},${lb},${alpha})`;
      };
      const traceProjectileShape = (shape, radius) => {
        if (shape === "diamond") {
          ctx.moveTo(0, -radius*1.10);
          ctx.lineTo(radius*0.90, 0);
          ctx.lineTo(0, radius*1.10);
          ctx.lineTo(-radius*0.90, 0);
          ctx.closePath();
          return;
        }
        if (shape === "star") {
          const outer = radius * 1.12;
          const inner = radius * 0.48;
          const spikes = 5;
          for (let i = 0; i < spikes * 2; i += 1) {
            const rr = (i % 2 === 0) ? outer : inner;
            const a = -Math.PI / 2 + (Math.PI * i) / spikes;
            const x = Math.cos(a) * rr;
            const y = Math.sin(a) * rr;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
          return;
        }
        if (shape === "dagger") {
          ctx.moveTo(0, -radius*1.28);
          ctx.lineTo(radius*0.58, radius*0.14);
          ctx.lineTo(radius*0.22, radius*0.14);
          ctx.lineTo(radius*0.22, radius*1.14);
          ctx.lineTo(-radius*0.22, radius*1.14);
          ctx.lineTo(-radius*0.22, radius*0.14);
          ctx.lineTo(-radius*0.58, radius*0.14);
          ctx.closePath();
          return;
        }
        if (shape === "rings") {
          ctx.arc(0, 0, radius, 0, Math.PI*2);
          return;
        }
        ctx.arc(0, 0, radius, 0, Math.PI*2);
      };

      // projectiles
      for(const p of this.projectiles){
        if (p.trailNodes?.length) {
          for (const n of p.trailNodes) {
            const tx = this.offsetX + n.x * this.tileSize;
            const ty = this.offsetY + n.y * this.tileSize;
            const ta = clamp((n.life > 0 ? (n.t / n.life) : 0), 0, 1);
            const tr = Math.max(1.2, n.size * this.tileSize * (0.80 + (1 - ta) * 0.40));
            const c = (n.color || "rgba(226,232,240,0.90)").replace(/[\d.]+\)$/, `${(ta * 0.60).toFixed(3)})`);
            ctx.save();
            ctx.shadowBlur = Math.max(4, tr * 1.8);
            ctx.shadowColor = c;
            ctx.fillStyle = c;
            ctx.beginPath();
            ctx.arc(tx, ty, tr, 0, Math.PI*2);
            ctx.fill();
            ctx.restore();
          }
        }

        const px=this.offsetX + p.x*this.tileSize;
        const py=this.offsetY + p.y*this.tileSize;
        const baseCol = p.visual?.color || "rgba(255,255,255,0.90)";
        const rimCol = brightenRgba(baseCol, 0.44, 0.98);
        const r=(p.visual?.radius ?? 0.11)*this.tileSize*1.18;
        const shape = p.visual?.shape || "circle";
        if (r <= 0.01 || p._spent) continue;
        let angle = 0;
        if (shape === "dagger") {
          let dx = p._dirX ?? 0;
          let dy = p._dirY ?? -1;
          if (p.t && !p.t.dead && !p.t.reachedExit) {
            dx = p.t.x - p.x;
            dy = p.t.y - p.y;
          }
          angle = Math.atan2(dy, dx) + Math.PI / 2;
        }

        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(angle);

        // Outer neon glow
        ctx.save();
        ctx.shadowBlur = Math.max(11, r * 3.1);
        ctx.shadowColor = baseCol;
        ctx.fillStyle = baseCol.replace(/[\d.]+\)$/,"0.22)");
        ctx.beginPath();
        traceProjectileShape(shape, r*1.52);
        ctx.fill();
        ctx.restore();

        // Bright rim
        ctx.lineWidth = Math.max(2.2, r * 0.34);
        ctx.strokeStyle = rimCol;
        ctx.beginPath();
        traceProjectileShape(shape, r);
        ctx.stroke();
        if (shape === "rings") {
          ctx.lineWidth = Math.max(1.6, r * 0.24);
          ctx.beginPath();
          ctx.arc(0, 0, r * 0.52, 0, Math.PI*2);
          ctx.stroke();
        }

        // Translucent core
        ctx.fillStyle = baseCol.replace(/[\d.]+\)$/,"0.33)");
        ctx.beginPath();
        traceProjectileShape(shape, r*0.92);
        ctx.fill();
        ctx.restore();
      }

      // lines
      for(const fx of this.effects){
        const ax=this.offsetX + fx.ax*this.tileSize;
        const ay=this.offsetY + fx.ay*this.tileSize;
        const bx=this.offsetX + fx.bx*this.tileSize;
        const by=this.offsetY + fx.by*this.tileSize;
        const a=fx.alpha();
        ctx.strokeStyle=fx.color.replace(/[\d.]+\)$/,""+a+")");
        ctx.lineWidth=fx.width;
        ctx.beginPath();
        ctx.moveTo(ax,ay); ctx.lineTo(bx,by);
        ctx.stroke();
      }

      // floating texts
      for (const f of this.floaters) {
        const a = f.alpha();
        const px=this.offsetX + f.x*this.tileSize;
        const py=this.offsetY + f.y*this.tileSize;
        const elapsed = 1 - a;
        const enter = 1 - Math.pow(1 - clamp(elapsed * 5.4, 0, 1), 3);
        const scale = (f.isCrit ? 0.78 : 0.88) + enter * (f.isCrit ? 0.46 : 0.20);

        ctx.save();
        ctx.globalAlpha = a;
        ctx.translate(px, py);
        ctx.scale(scale, scale);

        const drawSize = f.isCrit ? Math.round(f.size * 1.30) : f.size;
        ctx.font = `800 ${drawSize}px system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";

        const floaterColor = f.color || (f.isCrit ? "rgba(250,204,21,0.95)" : "rgba(232,238,252,0.92)");
        if (f.isCrit && !reducedEffects) {
          ctx.shadowBlur = Math.max(7, drawSize * 0.72);
          ctx.shadowColor = floaterColor;
        }
        ctx.lineWidth = f.isCrit ? 5.4 : 3.6;
        ctx.strokeStyle = f.isCrit ? "rgba(69,26,3,0.86)" : "rgba(2,6,23,0.72)";
        ctx.strokeText(f.text, 0, 0);
        if (f.isCrit) {
          ctx.lineWidth = 1.15;
          ctx.strokeStyle = "rgba(255,248,178,0.96)";
          ctx.strokeText(f.text, 0, 0);
        }
        ctx.fillStyle = floaterColor;
        ctx.fillText(f.text, 0, 0);
        ctx.restore();
      }

      const drawNeonBox = (x, y, w, h, title, value, sub, accent, alpha=1) => {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "rgba(10,20,35,0.48)";
        ctx.strokeStyle = accent;
        ctx.lineWidth = 3;
        ctx.shadowBlur = 18;
        ctx.shadowColor = accent;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);

        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(255,255,255,0.92)";
        ctx.textAlign = "center";
        const hasTitle = !!(title && String(title).trim().length > 0);
        if (hasTitle) {
          ctx.font = "bold 14px system-ui";
          ctx.fillText(title, x + w/2, y + 24);
        }
        ctx.font = "bold 24px system-ui";
        ctx.fillText(value, x + w/2, y + (hasTitle ? 58 : 50));
        if (sub) {
          ctx.font = "12px system-ui";
          ctx.fillStyle = "rgba(186,230,253,0.95)";
          ctx.fillText(sub, x + w/2, y + (hasTitle ? 84 : 78));
        }
        ctx.restore();
      };

      // center queue in neon box format
      const active = this.centerQueue.filter(c => (c.delay ?? 0) <= 0);
      if (active.length) {
        const top = active[0];
        const maxLife = Math.max(2.0, top.maxLife ?? top.life ?? 2.0);
        const a = clamp((top.life ?? 0) / maxLife, 0, 1);
        const w = 420;
        const h = 104;
        const x = this.cv.width/2 - w/2;
        const y = this.cv.height*0.10;
        drawNeonBox(x, y, w, h, "", `${top.text}`, "", "rgba(250,204,21,0.95)", a);
      }

      if (this.waveEndUplinkNotice) {
        const n = this.waveEndUplinkNotice;
        const a = clamp((n.life ?? 0) / (n.maxLife ?? 3.6), 0, 1);
        const size = 148;
        const peel = this.towers.find(t => t.def?.id === "peel");
        const peelCx = peel ? (this.offsetX + peel.x * this.tileSize) : (this.cv.width/2);
        const peelCy = peel ? (this.offsetY + peel.y * this.tileSize) : (this.cv.height*0.42);
        const peelHalfPx = peel ? ((peel.size ?? 1) * this.tileSize * 0.5) : (this.tileSize * 0.5);
        const gap = peelHalfPx + 26;
        const y = clamp(peelCy - size*0.5, 20, this.cv.height - size - 20);
        const leftX = clamp(peelCx - gap - size, 20, this.cv.width - size - 20);
        const rightX = clamp(peelCx + gap, 20, this.cv.width - size - 20);
        drawNeonBox(leftX, y, size, size, "CORE UPLINK", `+${formatCompact(n.coreGain)} HP`, `Wave ${n.waveNum} • ${n.casts} casts`, "rgba(56,189,248,0.95)", a);
        drawNeonBox(rightX, y, size, size, "GOLD PAYOUT", `+${formatCompact(n.goldGain)}g`, `Wave ${n.waveNum} • ${n.casts} casts`, "rgba(250,204,21,0.95)", a);
      }
      if (this.carepackageNotice) {
        const n = this.carepackageNotice;
        const a = clamp((n.life ?? 0) / (n.maxLife ?? 3.2), 0, 1);
        const size = 148;
        const sniper = this.towers.includes(n.tower) ? n.tower : null;
        const sniperCx = sniper ? (this.offsetX + sniper.x * this.tileSize) : (this.cv.width * 0.62);
        const sniperCy = sniper ? (this.offsetY + sniper.y * this.tileSize) : (this.cv.height * 0.46);
        const sniperHalfPx = sniper ? ((sniper.size ?? 1) * this.tileSize * 0.5) : (this.tileSize * 0.5);
        const gap = sniperHalfPx + 26;
        const x = clamp(sniperCx + gap, 20, this.cv.width - size - 20);
        const y = clamp(sniperCy - size * 0.5, 20, this.cv.height - size - 20);
        drawNeonBox(x, y, size, size, "CAREPACKAGE", `+${formatCompact(n.goldGain)}g`, "Sniper Prestige", "rgba(250,204,21,0.95)", a);
      }

      // Selected tower target panel is drawn last so it stays in front.
      this.drawSelectedTargetPanel(ctx);

      // Game over
      if(this.gameOver && !this.gameOverInspectMode){
        ctx.fillStyle="rgba(0,0,0,0.62)";
        ctx.fillRect(0,0,this.cv.width,this.cv.height);

        ctx.fillStyle="rgba(255,255,255,0.95)";
        ctx.font="bold 44px system-ui";
        ctx.textAlign="center";
        ctx.fillText("GAME OVER", this.cv.width/2, this.cv.height/2 - 120);

        ctx.font="16px system-ui";
        ctx.fillText("Highest Kills (Top 10)", this.cv.width/2, this.cv.height/2 - 86);

        const list=this.highKills || [];
        ctx.font="14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        let y=this.cv.height/2 - 60;
        for(let i=0;i<list.length;i++){
          ctx.fillText(`${i+1}. ${list[i]}`, this.cv.width/2, y);
          y += 18;
        }
      }
      if (this.gameOver && this.gameOverInspectMode) {
        ctx.save();
        ctx.fillStyle = "rgba(15,23,42,0.72)";
        ctx.fillRect(14, 12, 248, 32);
        ctx.strokeStyle = "rgba(125,211,252,0.72)";
        ctx.lineWidth = 1.2;
        ctx.strokeRect(14, 12, 248, 32);
        ctx.fillStyle = "rgba(186,230,253,0.95)";
        ctx.font = "700 13px system-ui";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText("Inspect Mode - Build Locked", 24, 28);
        ctx.restore();
      }

      this.offsetX = baseOffsetX;
      this.offsetY = baseOffsetY;
    }

    getSelectedPanelObjectId(value){
      if (!value || typeof value !== "object") return "none";
      if (!this._selectedPanelObjectIds) this._selectedPanelObjectIds = new WeakMap();
      if (!this._selectedPanelObjectNextId) this._selectedPanelObjectNextId = 1;
      let id = this._selectedPanelObjectIds.get(value);
      if (!id) {
        id = this._selectedPanelObjectNextId++;
        this._selectedPanelObjectIds.set(value, id);
      }
      return id;
    }

    getSelectedPanelSignature(inspectMode=false){
      const compact = (value, scale=10) => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.round(number * scale) : 0;
      };
      const modal = isModalOpen() ? 1 : 0;
      const enemy = this.selectedEnemy;
      const tower = this.selectedTowerInstance;
      const def = this.selectedTowerDef;
      const enemyState = enemy ? [
        this.getSelectedPanelObjectId(enemy),
        enemy.typeId,
        enemy.isBoss ? 1 : 0,
        compact(enemy.hp), compact(enemy.maxHP), compact(enemy.armor),
        compact(enemy.armorShredFlat), compact(enemy.baseSpeed),
        compact(enemy.slowPct), compact(enemy.slowTime), compact(enemy.rootTime),
        Math.round(Number(enemy.poisonStacks) || 0), compact(enemy.wealth),
        compact(enemy.incomingEstimate), enemy.lastBossSkill || "",
        enemy.firstBossStatus,
        listEnemyModifiers(enemy).map((modifier) => `${modifier.id || modifier.name || ""}:${modifier.desc || ""}`).join(";"),
        enemy.bossSkills
          ? Object.values(enemy.bossSkills).map((skill) => [
              skill.id || "", skill.active ? 1 : 0, compact(skill.timer), compact(skill.cd)
            ].join(",")).join(";")
          : ""
      ].join("|") : "none";
      const towerState = tower ? [
        this.getSelectedPanelObjectId(tower), tower.def?.id || "",
        tower.level, tower.secondaryLevel || 0,
        tower.archerSpecialization, tower.focusStacks,
        tower.targetMode || "", Math.round(Number(tower.spentGold) || 0),
        Math.round(Number(tower.damageDealt) || 0), Math.round(Number(tower.kills) || 0),
        compact(tower.AD?.[0]), compact(tower.AD?.[1]), compact(tower.baseAS),
        compact(tower.baseRange), compact(tower.critChance), compact(tower.critDmg),
        compact(tower.magicBonus), compact(tower.magicBonusExact), compact(tower.mana),
        compact(tower.maxMana), compact(tower.manaRegen), compact(tower.manaOnHit),
        compact(tower.prestigeMana), compact(tower.prestigeMaxMana), compact(tower.prestigeActive),
        compact(tower.tempASMul), compact(tower.uplinkTotalCore), compact(tower.uplinkTotalGold),
        compact(tower.prestigeGoldTotal),
        Object.entries(tower.peelBuffs || {}).map(([key, buff]) => `${key}:${compact(buff?.mul)}:${compact(buff?.time)}`).join(";"),
        (tower.specialUpgrades || []).map((upgrade) => [
          upgrade.tier, upgrade.rarityId || "", boundedText(upgrade.title, "", MAX_SAVE_TEXT)
        ].join(",")).join(";"),
        Object.values(tower.perks || {}).map((value) => compact(value, 1000)).join(",")
      ].join("|") : "none";
      const totalDamage = this.towers.reduce((sum, item) => sum + (Number(item?.damageDealt) || 0), 0);
      const hoverChoice = this.hoverSpecialChoice;
      return [
        this.gameOver ? 1 : 0,
        inspectMode ? 1 : 0,
        Math.round(Number(this.totalKills) || 0),
        (this.highKills || []).join(","),
        Math.round(Number(this.gold) || 0),
        Math.round(Number(this.currentWave) || 0),
        modal,
        this.winModalOpen ? 1 : 0,
        this.uiHover?.upgrade ? 1 : 0,
        this.uiHover?.fast ? 1 : 0,
        hoverChoice ? `${this.getSelectedPanelObjectId(hoverChoice)}:${hoverChoice.tier || 0}:${boundedText(hoverChoice.title, "", MAX_SAVE_TEXT)}` : "none",
        def?.id || "none",
        enemyState,
        towerState,
        Math.round(totalDamage)
      ].join("||");
    }

    refreshWaveForecast(finalWave){
      const { waveForecastTitle, waveForecastOrder } = this.uiAdapter.refs;
      if (!waveForecastTitle || !waveForecastOrder) return;
      const wave = Math.min(this.nextWaveNum, MAX_SAVE_WAVE);
      const key = [wave, this.mapIndex, this.isCustomMapRun, this.endlessMode, this.gameOver, finalWave].join("|");
      if (this._waveForecastKey === key) return;
      this._waveForecastKey = key;
      waveForecastOrder.hidden = this.gameOver || finalWave;
      if (waveForecastOrder.hidden) {
        waveForecastTitle.textContent = this.gameOver ? "Wave" : "Final campaign wave";
        waveForecastOrder.textContent = "";
        return;
      }
      const parts = wavePlan(wave, this.wavePlanOptions());
      const { resistType } = waveModifiers(wave);
      const resistance = resistType === "armor" ? " · Armor" : resistType === "mr" ? " · Magic resist" : "";
      waveForecastTitle.textContent = `Incoming · Wave ${wave}${resistance}`;
      waveForecastOrder.textContent = parts.map(({ type, count }) =>
        `${count} × ${CONTENT_REGISTRY.enemies.get(type)?.name ?? type}`
      ).join(" → ");
    }

    refreshUI(force=false){
      if (!force) {
        this._uiDirty = true;
        return;
      }
      this._uiDirty = false;
      this._uiRefreshTimer = 0;
      // HUD stats (canvas iÃ§i ama DOM)
      if (this.hudGoldEl) this.hudGoldEl.textContent=formatCompact(this.gold);
      if (this.hudCoreHpEl) this.hudCoreHpEl.textContent=formatCompact(this.coreHP);
      if (this.hudKillsEl) this.hudKillsEl.textContent=this.totalKills;
      if (this.hudWaveEl) this.hudWaveEl.textContent=this.currentWave;

      let alive = 0;
      let firstBoss = null;
      for (const e of this.enemies) {
        if (e.dead || e.reachedExit) continue;
        alive += 1;
        if (e.isBoss && e.wave === FIRST_BOSS_WAVE) firstBoss = e;
      }
      let remaining = 0;
      for (const w of this.wavesActive) {
        if (w.finished) continue;
        remaining += w.remainingInPart;
        for (let i=w.cursor+1; i<w.plan.length; i++) {
          remaining += w.plan[i].count;
        }
      }
      if (this.hudMobsEl) this.hudMobsEl.textContent=`${alive} / ${remaining}`;

      if (this.mapNameEl) this.mapNameEl.textContent=this.map.name;

      const startBtn=this.startWaveBtnEl;
      const nextBtn=this.nextWaveNowBtnEl;
      const finalWave = this.atCampaignFinalWave();
      this.refreshWaveForecast(finalWave);
      const intel = this.uiAdapter.refs.waveBossIntel;
      if (intel) {
        let message = "";
        if (!this.gameOver && !this.winModalOpen) {
          if (firstBoss) message = `Wave ${FIRST_BOSS_WAVE} boss · ${firstBoss.firstBossStatus}`;
          else if (this.nextWaveNum === FIRST_BOSS_WAVE) message = FIRST_BOSS_BRIEFING;
        }
        if (intel.textContent !== message) {
          intel.textContent = message;
          intel.hidden = !message;
        }
      }
      if (startBtn) {
        startBtn.disabled = this.started || this.gameOver || this.winModalOpen;
        startBtn.style.display = this.started ? "none" : "";
      }
      if (nextBtn) {
        if (this.gameOver) {
          nextBtn.disabled = false;
          nextBtn.classList.add("expanded");
          nextBtn.style.setProperty("--next-wave-fill", "0");
          nextBtn.style.setProperty("--next-wave-glow", "0");
          nextBtn.innerHTML = "<span>Restart</span>";
        } else {
          nextBtn.disabled = (!this.started) || this.winModalOpen || finalWave;
          nextBtn.classList.toggle("expanded", !!this.started);
          const buff = this.nextWaveNowGoldBuff || { mult: 1, timeLeft: 0, maxTime: 0 };
          const active = buff.timeLeft > 0 && buff.mult > 1;
          const ratio = active && buff.maxTime > 0 ? clamp(buff.timeLeft / buff.maxTime, 0, 1) : 0;
          const glow = active ? clamp((buff.mult - 1) / 1.2, 0, 1.2) : 0;
          nextBtn.style.setProperty("--next-wave-fill", ratio.toFixed(4));
          nextBtn.style.setProperty("--next-wave-glow", glow.toFixed(4));
          const label = active
            ? `Next Wave Now • ${buff.mult.toFixed(1)}x Gold • ${buff.timeLeft.toFixed(1)}s`
            : "Next Wave Now";
          nextBtn.innerHTML = `<span>${label}</span>`;
        }
      }

      const info=this.selectedInfoHudEl;
      const upBtn=this.upgradeBtnHudEl;
      const fastBtn=this.fastUpgradeBtnHudEl;
      const sellBtn=this.sellBtnHudEl;
      if (!info || !upBtn || !sellBtn) return;
      const inspectMode = this.gameOver && this.gameOverInspectMode;
      const panelSignature = this.getSelectedPanelSignature(inspectMode);
      if (panelSignature === this._selectedPanelSignature) return;
      this._selectedPanelSignature = panelSignature;
      const pathPicker = this.uiAdapter.refs.archerPathPicker;
      if (pathPicker) {
        pathPicker.hidden = !this.selectedTowerInstance?.canChooseArcherPath() || this.gameOver ||
          this.winModalOpen || isModalOpen() || !!this.selectedEnemy;
      }
      const calcFastUpgradeCost = (t) => {
        if (!t) return null;
        const target = Math.min(CFG.TOWER_MAX_LEVEL, (Math.floor(t.level / 5) + 1) * 5);
        if (t.level >= target) return null;
        let lvl = t.level;
        let total = 0;
        while (lvl < target) {
          const cost = (lvl === CFG.TOWER_MAX_LEVEL - 1)
            ? (upgradeCostCurve(t.def.cost, lvl) * 2)
            : upgradeCostCurve(t.def.cost, lvl);
          total += cost;
          lvl += 1;
        }
        return total;
      };
      const buildSimTowerState = (t, steps = 0, specialChoice = null) => {
        if (!t) return null;
        const peelAs = t.peelMul("as");
        const peelAd = t.peelMul("ad");
        const peelMag = t.peelMul("mag");
        const sim = {
          def: t.def,
          level: t.level,
          AD: [t.AD[0], t.AD[1]],
          baseAS: t.baseAS,
          baseRange: t.baseRange,
          critChance: t.critChance,
          critDmg: t.critDmg,
          magicBonus: t.magicBonus,
          magicBonusExact: Number(t.magicBonusExact ?? t.magicBonus ?? 0),
          manaRegen: t.manaRegen,
          manaOnHit: t.manaOnHit,
          perks: {
            adMul: t.perks.adMul,
            asMul: t.perks.asMul,
            magMul: t.perks.magMul,
            dmgMul: t.perks.dmgMul
          },
          tempASMul: t.tempASMul,
          peelBuffs: { mag: { mul: peelMag } },
          specialMagicActualMul: t.specialMagicActualMul,
          specialMagicExpectedMul: t.specialMagicExpectedMul,
          specialUpgrades: Array.isArray(t.specialUpgrades) ? [...t.specialUpgrades] : []
        };

        const count = Math.max(0, Math.floor(steps));
        for (let i = 0; i < count; i += 1) {
          const lvlBefore = sim.level;
          const g = scaledGain(lvlBefore);
          const adGainMul = (sim.def.id === "sniper")
            ? (1 + g * 1.35)
            : (sim.def.id === "archer")
              ? (1 + g * 0.88)
              : (1 + g);
          sim.AD = [
            Math.round(sim.AD[0] * adGainMul),
            Math.round(sim.AD[1] * adGainMul)
          ];
          sim.baseAS *= (1 + g * 0.22);
          sim.baseRange += (0.10 + g * 0.10);
          sim.critChance = clamp(sim.critChance + g * 0.010, 0, 0.45);
          const magicMult = (sim.def.id === "mage")
            ? (1 + g * 0.42)
            : (sim.def.id === "breaker")
              ? (1 + g * 0.95)
            : (sim.def.id === "archer")
              ? (1 + g * 0.40)
              : (1 + g * 0.30);
          sim.magicBonusExact = Math.max(0, sim.magicBonusExact * magicMult);
          sim.magicBonus = Math.max(0, Math.round(sim.magicBonusExact));
          if (sim.def.id !== "sniper") {
            sim.manaRegen *= (1 + g * 0.16);
            sim.manaOnHit *= (1 + g * 0.12);
          }
          sim.level = (lvlBefore === CFG.TOWER_MAX_LEVEL) ? CFG.PRESTIGE_LEVEL : (lvlBefore + 1);
        }

        if (specialChoice && typeof specialChoice.apply === "function") {
          try {
            specialChoice.apply(sim);
          } catch (_) {
            // Ignore invalid preview application and keep baseline values.
          }
        }

        const adLow = Math.round(sim.AD[0] * sim.perks.adMul * sim.perks.dmgMul * peelAd);
        const adHigh = Math.round(sim.AD[1] * sim.perks.adMul * sim.perks.dmgMul * peelAd);
        const as = Math.max(0.05, sim.baseAS * sim.perks.asMul * sim.tempASMul * peelAs);
        const peelRange = t.peelMul("rng");
        const range = Math.max(1, 1 + (Math.max(1, sim.baseRange) - 1) * peelRange);
        const critChance = clamp(sim.critChance, 0, 1);
        const critMult = Math.max(1, Number(sim.critDmg) || 1);
        const magic = Math.round(sim.magicBonus * sim.perks.magMul * sim.perks.dmgMul * peelMag);
        const manaRegen = Math.max(0, Number(sim.manaRegen) || 0);
        const bounce = sim.def.id === "peel" ? peelBounceCountFromAD(sim.AD, sim.perks.adMul * peelAd) : 0;
        const skillText = (sim.def.skillDesc ? sim.def.skillDesc(sim) : "—");
        const peelPower = (sim.def.id === "peel") ? Math.round(peelBuffPower(sim) * 100) : 0;

        return {
          level: sim.level,
          adLow,
          adHigh,
          as,
          range,
          critChance,
          critMult,
          magic,
          manaRegen,
          manaHit: sim.manaOnHit,
          bounce,
          skillText,
          peelPower
        };
      };
      const resetFastBtn = () => {
        if (!fastBtn) return;
        fastBtn.disabled = true;
        fastBtn.textContent = "Fast Upgrade (X)";
        fastBtn.title = "";
      };
      resetFastBtn();

      if(this.gameOver && !this.gameOverInspectMode){
        info.innerHTML = `
          <div class="selRow"><div class="k">Status</div><div class="v"><b>GAME OVER</b></div></div>
          <div class="selRow"><div class="k">Kills</div><div class="v">${this.totalKills}</div></div>
          <div class="selRow"><div class="k">Top 10</div><div class="v">${(this.highKills||[]).join(", ")}</div></div>
        `;
        upBtn.disabled=true;
        upBtn.title="";
        sellBtn.disabled=true;
        sellBtn.textContent="Sell (C)";
        sellBtn.classList.remove("good");
        sellBtn.classList.add("danger");
        upBtn.textContent="Upgrade (Z)";
        return;
      }else{
        sellBtn.classList.remove("good");
        sellBtn.classList.add("danger");
      }

      // Enemy selected
      if(this.selectedEnemy){
        const e=this.selectedEnemy;
        const type = e.isBoss ? "Boss" : (CONTENT_REGISTRY.enemies.get(e.typeId)?.name ?? e.typeId);
        const modifiers = listEnemyModifiers(e);
        const modifier = modifiers[0] || null;
        const modifierLine = modifier
          ? `<div class="selRow"><div class="k">Modifier</div><div class="v">${modifier.name}</div></div>`
          : "";
        let bossSkillLines = "";
        let bossNextLine = "";
        if (e.isBoss && e.bossSkills) {
          const skills = Object.values(e.bossSkills).filter(s => s.active);
          const nextSkill = this.getBossNextSkill(e) || skills[0];
          if (nextSkill) {
            const nextInfo = BOSS_SKILL_INFO[nextSkill.id] || { name: nextSkill.name, color: "rgba(168,85,247,0.85)" };
            bossNextLine = `<div class="selRow"><div class="k">Next Skill</div><div class="v"><span style="color:${nextInfo.color}">■</span> ${nextInfo.name}</div></div>`;
          }

          for (const s of skills) {
            const info = BOSS_SKILL_INFO[s.id] || { name: s.name, color: "rgba(168,85,247,0.85)" };
            const remain = Math.max(0, s.timer).toFixed(1);
            const ready = (s.timer <= 0) ? "ready" : `${remain}s`;
            const pct = Math.round(clamp(1 - (s.timer || 0) / s.cd, 0, 1) * 100);
            bossSkillLines += `<div class="selRow"><div class="k"><span style="color:${info.color}">■</span> ${info.name}</div><div class="v">${pct}% (${ready})</div></div>`;
          }
        }
        const bossLastLine = (e.isBoss && e.lastBossSkill)
          ? `<div class="selRow"><div class="k">Last Skill</div><div class="v">${e.lastBossSkill}</div></div>`
          : "";
        const skillStatusLine = e.firstBossPhase
          ? `<div class="selRow"><div class="k">Boss cycle</div><div class="v">${e.firstBossStatus}</div></div>`
          : (e.isBoss)
          ? (() => {
              const debuffed = (e.poisonStacks > 0) || (e.slowPct > 0.2) || (e.frostbiteTime > 0) || (e.frostbiteDotTime > 0);
              const cleanse = debuffed ? "ready" : "needs debuff";
              const heal = (e.hp < e.maxHP) ? "ready" : "full hp";
              const summon = "ready";
              return `<div class="selRow"><div class="k">Skills</div><div class="v">Cleanse: ${cleanse} • Heal: ${heal} • Summon: ${summon}</div></div>`;
            })()
          : "";
        const modifierDescLine = modifier
          ? `<div class="selHint"><b>Modifier</b>: ${modifier.desc}</div>`
          : "";
        const bossDescLine = e.firstBossPhase ? `<div class="selHint">${FIRST_BOSS_BRIEFING}</div>`
          : (e.isBoss) ? `<div class="selHint"><b>Boss Skills</b>: Cleanse (removes debuffs), Heal (recovers HP), Summon (spawns minions).</div>` : "";
        const armorState = (e.armor <= 0.01)
          ? "X: BROKEN"
          : `X:${Math.round(e.armorShredFlat)}`;

        info.innerHTML = `
          <div class="selRow"><div class="k">Enemy</div><div class="v">${type}</div></div>
          <div class="selRow"><div class="k">HP</div><div class="v">${formatCompact(e.hp)} / ${formatCompact(e.maxHP)}</div></div>
          <div class="selRow"><div class="k">Armor</div><div class="v">${e.armor.toFixed(0)} (${armorState})</div></div>
          <div class="selRow"><div class="k">Speed</div><div class="v">${(e.rootTime > 0 ? 0 : (e.baseSpeed*(1-e.slowPct))).toFixed(2)}</div></div>
          <div class="selRow"><div class="k">Slow</div><div class="v">%${Math.round(e.slowPct*100)} / ${e.slowTime.toFixed(1)}s</div></div>
          <div class="selRow"><div class="k">Root</div><div class="v">${e.rootTime > 0 ? `${e.rootTime.toFixed(1)}s` : "No"}</div></div>
          <div class="selRow"><div class="k">Poison</div><div class="v">${Math.round(e.poisonStacks)} stack</div></div>
          ${modifierLine}
          ${bossNextLine}
          ${bossSkillLines}
          ${bossLastLine}
          ${skillStatusLine}
          <div class="selRow"><div class="k">Wealth</div><div class="v">${formatCompact(e.wealth)}</div></div>
          <div class="selRow"><div class="k">Incoming(est)</div><div class="v">${formatCompact(e.incomingEstimate)}</div></div>
          ${modifierDescLine}
          ${bossDescLine}
        `;
        upBtn.disabled=true; upBtn.textContent="Upgrade (Z)"; upBtn.title="";
        resetFastBtn();
        sellBtn.disabled=true; sellBtn.textContent="Sell (C)";
        return;
      }

      // Tower selected
      if(this.selectedTowerInstance){
        const t=this.selectedTowerInstance;
        const canUp=!inspectMode && t.canUpgrade();
        const cost=canUp ? t.upgradeCost() : null;
        const refund=Math.round(t.spentGold*0.50);
        const fastCost = canUp ? calcFastUpgradeCost(t) : null;
        const totalDamage = this.towers.reduce((sum, tw) => sum + (tw.damageDealt || 0), 0);
        const dmgPct = totalDamage > 0 ? (t.damageDealt / totalDamage) * 100 : 0;
        const isPeel = t.def.id === "peel";
        const baseView = buildSimTowerState(t, 0, null);
        const uplinkCastsLine = isPeel
          ? `<div class="selRow"><div class="k">Uplink Casts (Wave)</div><div class="v">${this.getPeelUplinkCasts(this.currentWave)}</div></div>`
          : ``;
        const peelBuffs = t.peelBuffs ? Object.entries(t.peelBuffs).filter(([, b]) => b.time > 0) : [];
        const peelBuffLine = peelBuffs.length
          ? `<div class="selRow"><div class="k">Peel Buffs</div><div class="v">${peelBuffs.map(([k,b]) => {
              const info = PEEL_BUFF_INFO[k] || { name: k.toUpperCase() };
              void b;
              return `${info.name}`;
            }).join(" • ")}</div></div>`
          : ``;
        const baseSkillTextRaw = baseView?.skillText || "—";
        const autoAttackText = (typeof t.def.autoAttackDesc === "function")
          ? (t.def.autoAttackDesc(t) || "—")
          : (t.def.autoAttackDesc || "—");
        const skillText = baseSkillTextRaw.replaceAll("\n","<br/>");
        const prestigeDesc = typeof t.def.prestige?.desc === "function"
          ? t.def.prestige.desc(t)
          : t.def.prestige?.desc;
        const prestigeText = t.def.prestige ? `${t.def.prestige.name}: ${prestigeDesc || "—"}` : "—";
        const hideMageCombatDetail = (t.def.id === "mage" && t.level >= CFG.PRESTIGE_LEVEL);

        const primaryManaLine = (t.maxMana>0)
          ? `${t.mana.toFixed(0)}/${t.maxMana}`
          : "—";

        const prestigeManaLine = (t.level>=CFG.PRESTIGE_LEVEL && t.prestigeMaxMana>0)
          ? `${t.prestigeMana.toFixed(0)}/${t.prestigeMaxMana} (${(t.prestigeActive>0? `ACTIVE ${t.prestigeActive.toFixed(1)}s` : "ready in ~"+Math.max(0, (t.prestigeMaxMana - t.prestigeMana)/(t.prestigeMaxMana/CFG.PRESTIGE_RECHARGE_TIME_SEC)).toFixed(0)+"s")})`
          : "";
        const towerOverkill = this.runStats?.towerOverkill?.[t.def.id] || 0;
        const damageSummary = `${formatCompact(t.damageDealt)} real / ${formatCompact(towerOverkill)} overkill / ${t.kills} kills (${dmgPct.toFixed(1)}%)`;
        const peelUplinkTotalsLine = isPeel
          ? `<div class="selRow"><div class="k">Uplink HP / Gold</div><div class="v">+${formatCompact(t.uplinkTotalCore || 0)} HP / +${formatCompact(t.uplinkTotalGold || 0)}g</div></div>`
          : ``;
        const sniperPrestigeGoldLine = (t.def.id === "sniper")
          ? `<div class="selRow"><div class="k">Prestige Gold</div><div class="v">+${formatCompact(t.prestigeGoldTotal || 0)}g</div></div>`
          : ``;

        let specialSummary = "";
        let specialUpgradeTitles = [];
        if (t.specialUpgrades && t.specialUpgrades.length) {
          const sorted = [...t.specialUpgrades].sort((a,b)=>a.tier-b.tier);
          specialUpgradeTitles = sorted.map(u => boundedText(u?.title, "", MAX_SAVE_TEXT));
          specialSummary = `
            <div class="selUpgrades">
              <div class="selUpgradesTitle">Special Upgrades</div>
              ${sorted.map((u, idx) => `
                <div class="selUpgradeItem rarity-${u.rarityId || "common"}">
                  <div class="selUpgradeTier">Tier ${u.tier}</div>
                  <div class="selUpgradeText" data-special-upgrade-index="${idx}"></div>
                </div>
              `).join("")}
            </div>
          `;
        }

        const levelClass = (t.level >= CFG.PRESTIGE_LEVEL)
          ? "selTowerLevel selTowerLevelPrestige"
          : (t.level === CFG.TOWER_MAX_LEVEL ? "selTowerLevel selTowerLevelMax" : "selTowerLevel");
        const nameClass = (t.level >= CFG.PRESTIGE_LEVEL)
          ? "selTowerName selTowerNamePrestige"
          : (t.level === CFG.TOWER_MAX_LEVEL ? "selTowerName selTowerNameMax" : "selTowerName");
        const secondaryClass = (t.def.id === "sniper" && (t.secondaryLevel ?? 0) >= 100)
          ? "selTowerSecondary selTowerSecondaryOver"
          : "selTowerSecondary";
        const fastTarget = Math.min(CFG.TOWER_MAX_LEVEL, (Math.floor(t.level / 5) + 1) * 5);
        const fastSteps = Math.max(0, fastTarget - t.level);
        const hoverSpecial = (isModalOpen() && this.hoverSpecialChoice) ? this.hoverSpecialChoice : null;
        const hoverUpgrade = canUp && !!this.uiHover?.upgrade;
        const hoverFast = canUp && !!this.uiHover?.fast;
        const previewSteps = hoverSpecial
          ? 0
          : (hoverUpgrade
          ? 1
          : (hoverFast && fastSteps > 0 ? fastSteps : 0));
        const previewView = (hoverSpecial || (canUp && previewSteps > 0))
          ? buildSimTowerState(t, previewSteps, hoverSpecial)
          : null;
        const levelPreview = (previewView && baseView && (previewView.level - baseView.level) !== 0)
          ? `<span class="selPlus"> (+${previewView.level - baseView.level})</span>`
          : "";
        const compactSigned = (n) => `${n >= 0 ? "+" : "-"}${formatCompact(Math.abs(n))}`;
        const adDiffLow = (previewView && baseView) ? (previewView.adLow - baseView.adLow) : 0;
        const adDiffHigh = (previewView && baseView) ? (previewView.adHigh - baseView.adHigh) : 0;
        const adPreview = (previewView && baseView && t.def.id !== "peel" && (adDiffLow !== 0 || adDiffHigh !== 0))
          ? `<span class="selPlus"> (${compactSigned(adDiffLow)}-${compactSigned(adDiffHigh)})</span>`
          : "";
        const bouncePreview = (previewView && baseView && t.def.id === "peel" && (previewView.bounce - baseView.bounce) !== 0)
          ? `<span class="selPlus"> (+${previewView.bounce - baseView.bounce})</span>`
          : "";
        const asPreview = (previewView && baseView && Math.abs(previewView.as - baseView.as) > 0.0001)
          ? `<span class="selPlus"> (+${(previewView.as - baseView.as).toFixed(2)})</span>`
          : "";
        const rangePreview = (previewView && baseView && Math.abs(previewView.range - baseView.range) > 0.0001)
          ? `<span class="selPlus"> (+${(previewView.range - baseView.range).toFixed(2)})</span>`
          : "";
        const critChanceDiffPct = (previewView && baseView)
          ? ((previewView.critChance - baseView.critChance) * 100)
          : 0;
        const critMultDiff = (previewView && baseView)
          ? (previewView.critMult - baseView.critMult)
          : 0;
        const critPreview = (() => {
          if (!previewView || !baseView) return "";
          const parts = [];
          if (Math.abs(critChanceDiffPct) > 0.0001) {
            const sign = critChanceDiffPct >= 0 ? "+" : "";
            parts.push(`${sign}${critChanceDiffPct.toFixed(1)}%`);
          }
          if (Math.abs(critMultDiff) > 0.0001) {
            const sign = critMultDiff >= 0 ? "+" : "";
            parts.push(`${sign}x${critMultDiff.toFixed(2)}`);
          }
          return parts.length ? `<span class="selPlus"> (${parts.join(" / ")})</span>` : "";
        })();
        const magicPreview = (previewView && baseView && (previewView.magic - baseView.magic) !== 0)
          ? `<span class="selPlus"> (+${previewView.magic - baseView.magic})</span>`
          : "";
        const manaRegenPreview = (previewView && baseView && Math.abs(previewView.manaRegen - baseView.manaRegen) > 0.0001)
          ? `<span class="selPlus"> (+${(previewView.manaRegen - baseView.manaRegen).toFixed(2)})</span>`
          : "";
        const manaHitPreview = (previewView && baseView && Math.abs(previewView.manaHit - baseView.manaHit) > 0.0001)
          ? `<span class="selPlus"> (+${(previewView.manaHit - baseView.manaHit).toFixed(2)})</span>`
          : "";
        const adValue = (t.def.id === "peel")
          ? `${baseView?.bounce ?? t.getBounceCount()}${bouncePreview}`
          : `${formatCompact(baseView?.adLow ?? 0)}-${formatCompact(baseView?.adHigh ?? 0)}${adPreview}`;
        const asValue = `${(baseView?.as ?? t.AS).toFixed(2)}${asPreview}`;
        const rangeValue = `${(baseView?.range ?? t.range).toFixed(2)}${rangePreview}`;
        const critChancePct = (Number(baseView?.critChance ?? t.critChance) || 0) * 100;
        const critMult = Number(baseView?.critMult ?? t.critDmg) || 1;
        const critValue = `${critChancePct.toFixed(1)}% / x${critMult.toFixed(2)}${critPreview}`;
        const manaRegenValue = `${(baseView?.manaRegen ?? t.manaRegen).toFixed(2)}/s${manaRegenPreview}`;
        const magicValue = `${baseView?.magic ?? Math.round(t.magicBonus * t.perks.magMul * t.perks.dmgMul * t.peelMul("mag"))}${magicPreview}`;
        const manaHitValue = `${(baseView?.manaHit ?? t.manaOnHit).toFixed(2)}${manaHitPreview}`;
        const peelPowerPreview = (isPeel && previewView && baseView && (previewView.peelPower - baseView.peelPower) !== 0)
          ? `<span class="selPlus"> (+${previewView.peelPower - baseView.peelPower}%)</span>`
          : "";
        const peelPowerLine = isPeel
          ? `<div class="selRow"><div class="k">Buff Power</div><div class="v">+${baseView?.peelPower ?? Math.round(peelBuffPower(t)*100)}%${peelPowerPreview}</div></div>`
          : ``;
        const magePrestigeBuffLine = (t.def.id === "mage" && t.level >= CFG.PRESTIGE_LEVEL)
          ? (() => {
              const aura = magePrestigeAuraProfile();
              const auraMul = aura.manaMultiplier;
              const auraRange = t.range + aura.rangeBonus;
              return `<div class="selHint"><b>Mage Prestige Buff</b>: Mana x${auraMul.toFixed(2)} in ${auraRange.toFixed(2)} range.</div>`;
            })()
          : ``;
        const magePrestigeCantAttackLine = (t.def.id === "mage" && t.level >= CFG.PRESTIGE_LEVEL)
          ? `<div class="selHint"><b>Mage</b>: Can't attack due to prestige reasons. Arcane union rules.</div>`
          : ``;
        const magePrestigePreviewLine = (t.def.id === "mage" && t.level === CFG.TOWER_MAX_LEVEL)
          ? `<div class="selHint"><b>Next upgrade — Mage Prestige</b>: this permanently stops Mage auto-attacks and unlocks its Mana aura. Choose it only when the support role fits your defense.</div>`
          : ``;
        const buildSkillInlinePreview = (towerId, baseRaw, previewRaw) => {
          if (!previewRaw || previewRaw === baseRaw) return "";
          const parts = [];
          if (towerId === "archer") {
            const bx = /x(\d+(?:\.\d+)?)/.exec(baseRaw);
            const px = /x(\d+(?:\.\d+)?)/.exec(previewRaw);
            if (bx && px) {
              const b = Number(bx[1]);
              const p = Number(px[1]);
              if (Number.isFinite(b) && Number.isFinite(p) && Math.abs(p - b) > 0.0001) {
                return `<span class="skillPreviewInline">(x${p.toFixed(2)})</span>`;
              }
            }
            return "";
          }
          if (towerId === "mage") {
            const b = /(\d+)\s+jumps\s+in\s+([\d.]+)\s+range[\s\S]*x([\d.]+)/i.exec(baseRaw);
            const p = /(\d+)\s+jumps\s+in\s+([\d.]+)\s+range[\s\S]*x([\d.]+)/i.exec(previewRaw);
            if (b && p) {
              const dJ = Number(p[1]) - Number(b[1]);
              const dR = Number(p[2]) - Number(b[2]);
              const dM = Number(p[3]) - Number(b[3]);
              if (dJ !== 0) parts.push(`Chains +${dJ}`);
              if (Math.abs(dR) > 0.0001) parts.push(`Radius +${dR.toFixed(2)}`);
              if (Math.abs(dM) > 0.0001) parts.push(`Jump x +${dM.toFixed(2)}`);
            }
          } else if (towerId === "breaker") {
            const b = /in\s+([\d.]+)\s+radius[\s\S]*Armor Shred\s+(\d+)/i.exec(baseRaw);
            const p = /in\s+([\d.]+)\s+radius[\s\S]*Armor Shred\s+(\d+)/i.exec(previewRaw);
            if (b && p) {
              const dRadius = Number(p[1]) - Number(b[1]);
              const dShred = Number(p[2]) - Number(b[2]);
              if (Math.abs(dRadius) > 0.0001) parts.push(`Radius +${dRadius.toFixed(2)}`);
              if (dShred !== 0) parts.push(`Armor Shred +${dShred}`);
            }
          } else if (towerId === "blizzard") {
            const b = /(\d+)% slow for ([\d.]+)s[\s\S]*?(\d+) magic damage/i.exec(baseRaw);
            const p = /(\d+)% slow for ([\d.]+)s[\s\S]*?(\d+) magic damage/i.exec(previewRaw);
            if (b && p) {
              const dSlow = Number(p[1]) - Number(b[1]);
              const dDur = Number(p[2]) - Number(b[2]);
              const dDmg = Number(p[3]) - Number(b[3]);
              if (dSlow !== 0) parts.push(`Slow +${dSlow}%`);
              if (Math.abs(dDur) > 0.0001) parts.push(`Duration +${dDur.toFixed(2)}s`);
              if (dDmg !== 0) parts.push(`Pulse DMG +${dDmg}`);
            }
          } else if (towerId === "poison") {
            const b = /x(\d+(?:\.\d+)?)/i.exec(baseRaw);
            const p = /x(\d+(?:\.\d+)?)/i.exec(previewRaw);
            if (b && p) {
              const dMult = Number(p[1]) - Number(b[1]);
              if (Math.abs(dMult) > 0.0001) parts.push(`Poison x +${dMult.toFixed(2)}`);
            }
          } else if (towerId === "sniper") {
            const b = /Current gain \+(\d+(?:\.\d+)?)%/i.exec(baseRaw);
            const p = /Current gain \+(\d+(?:\.\d+)?)%/i.exec(previewRaw);
            if (b && p) {
              const dPct = Number(p[1]) - Number(b[1]);
              if (Math.abs(dPct) > 0.0001) parts.push(`Overlevel +${dPct.toFixed(2)}%`);
            }
          } else if (towerId === "peel") {
            const dMagic = (previewView && baseView) ? (previewView.magic - baseView.magic) : 0;
            if (dMagic !== 0) parts.push(`Magic +${dMagic}`);
            const dBuff = (previewView && baseView) ? (previewView.peelPower - baseView.peelPower) : 0;
            if (dBuff !== 0) parts.push(`Buff Power +${dBuff}%`);
          }
          return parts.length ? `<span class="skillPreviewInline">(${parts.join(", ")})</span>` : "";
        };

        let skillTextWithPreview = skillText;
        let skillPreviewSlot = "&nbsp;";
        if (previewView && baseView) {
          const previewSkillRaw = previewView.skillText || "";
          const inlinePreview = buildSkillInlinePreview(t.def.id, baseSkillTextRaw, previewSkillRaw);
          if (inlinePreview) {
            if (t.def.id === "archer") {
              const baseX = /x(\d+(?:\.\d+)?)/.exec(baseSkillTextRaw);
              if (baseX) {
                const oldTok = `x${baseX[1]}`;
                const newTok = `x${baseX[1]} ${inlinePreview}`;
                skillTextWithPreview = skillText.replace(oldTok, newTok);
              }
            } else {
              skillPreviewSlot = inlinePreview;
            }
          }
        }

        info.innerHTML = `
          <div class="selRow"><div class="k">Tower</div><div class="v"><span class="${nameClass}">${t.def.name}</span></div></div>
          <div class="selRow"><div class="k">Level</div><div class="v"><span class="${levelClass}">${t.level}</span>${levelPreview}</div></div>
          ${t.def.id==="sniper" ? `<div class="selRow"><div class="k">Secondary Lv</div><div class="v"><span class="${secondaryClass}">${t.secondaryLevel ?? 0}</span></div></div>` : ``}
          <div class="selRow"><div class="k">${t.def.id === "peel" ? "Bounce" : "AD"}</div><div class="v">${adValue}</div></div>
          <div class="selRow"><div class="k">AS</div><div class="v">${asValue}</div></div>
          <div class="selRow"><div class="k">Range</div><div class="v">${rangeValue}</div></div>
          <div class="selRow"><div class="k">Crit</div><div class="v">${critValue}</div></div>
          <div class="selRow"><div class="k">Magic</div><div class="v">${magicValue}</div></div>
          ${peelPowerLine}
          ${uplinkCastsLine}
          <div class="selRow"><div class="k">Mana</div><div class="v">${primaryManaLine}</div></div>
          <div class="selRow"><div class="k">Mana Regen</div><div class="v">${manaRegenValue}</div></div>
          <div class="selRow"><div class="k">Mana/Hit</div><div class="v">${manaHitValue}</div></div>
          ${isPeel ? `` : `<div class="selRow"><div class="k">Damage / Kills</div><div class="v">${damageSummary}</div></div>`}
          ${peelUplinkTotalsLine}
          ${sniperPrestigeGoldLine}
          ${t.level>=CFG.PRESTIGE_LEVEL ? `<div class="selRow"><div class="k">Prestige Mana</div><div class="v">${prestigeManaLine}</div></div>` : ``}
          ${peelBuffLine}
          ${t.archerSpecialization === "focus" ? `<div class="selRow"><div class="k">Next shot damage on same enemy</div><div class="v">+${focusBonusPercent(t, t.focusTarget)}%</div></div>` : ""}

          ${hideMageCombatDetail ? `` : `<div class="selHint"><b>Auto Attack</b>: ${autoAttackText}</div>`}
          ${hideMageCombatDetail ? `` : `<div class="selHint"><b>${t.def.skillName}</b>: ${skillTextWithPreview}<span class="skillPreviewSlot">${skillPreviewSlot}</span></div>`}
          ${magePrestigePreviewLine}
          ${t.level>=CFG.PRESTIGE_LEVEL ? `<div class="selHint"><b>Prestige</b>: ${prestigeText}</div>` : ``}
          ${magePrestigeCantAttackLine}
          ${magePrestigeBuffLine}
          ${specialSummary}
        `;
        if (specialUpgradeTitles.length) {
          info.querySelectorAll("[data-special-upgrade-index]").forEach((node) => {
            const idx = Math.floor(Number(node.getAttribute("data-special-upgrade-index")) || 0);
            node.textContent = specialUpgradeTitles[idx] || "";
          });
        }

        upBtn.disabled = (!canUp) || (this.gold < cost) || isModalOpen();
        upBtn.textContent = canUp
          ? `${t.def.id === "mage" && t.level === CFG.TOWER_MAX_LEVEL ? "Prestige (Z)" : "Upgrade (Z)"} ${cost}`
          : "MAX";
        upBtn.title = "";
        if (fastBtn) {
          const canFast = !!fastCost && this.gold >= fastCost && !isModalOpen() && !inspectMode;
          fastBtn.disabled = !canFast;
          fastBtn.textContent = fastCost ? `Fast Upgrade (X) ${fastCost}` : "Fast Upgrade (X)";
          fastBtn.title = "";
        }
        sellBtn.disabled = isModalOpen() || inspectMode;
        sellBtn.textContent = `Sell (C) +${refund}`;
        return;
      }

      // Only tower selected from shop
      if(this.selectedTowerDef){
        const d=this.selectedTowerDef;
        const b=d.base;
        const autoAttackText = (typeof d.autoAttackDesc === "function")
          ? (d.autoAttackDesc({
              level: 1,
              magicBonus: b.MD,
              magicBonusExact: b.MD,
              perks: { magMul: 1 },
              peelBuffs: { mag: { mul: 1 } }
            }) || "—")
          : (d.autoAttackDesc || "—");
        const desc=(d.skillDesc ? d.skillDesc({level:1, magicBonus:d.base.MD, perks:{magMul:1, dmgMul:1}}) : "—").replaceAll("\n","<br/>");
        const manaLine = (d.skillManaCost>0) ? `${d.skillManaCost}` : (d.id==="sniper" ? "Carepackage" : "—");
        const isPeel = d.id === "peel";
        const baseBounce = isPeel ? peelBounceCountFromAD(b.AD, 1) : 0;
        const adLine = isPeel
          ? `<div class="selRow"><div class="k">Bounce</div><div class="v">${baseBounce}</div></div>`
          : `<div class="selRow"><div class="k">AD</div><div class="v">${formatCompact(b.AD[0])}-${formatCompact(b.AD[1])}</div></div>`;
        const peelPowerLine = isPeel
          ? `<div class="selRow"><div class="k">Buff Power</div><div class="v">+${Math.round(peelBuffPower({ magicBonus: b.MD, perks:{ magMul:1 } })*100)}%</div></div>`
          : ``;
        info.innerHTML = `
          <div class="selRow"><div class="k">Tower</div><div class="v"><b>${d.name}</b></div></div>
          <div class="selRow"><div class="k">Cost</div><div class="v">${d.cost}</div></div>
          ${adLine}
          <div class="selRow"><div class="k">AS</div><div class="v">${b.AS.toFixed(2)}</div></div>
          <div class="selRow"><div class="k">Range</div><div class="v">${b.Range.toFixed(2)}</div></div>
          <div class="selRow"><div class="k">Crit</div><div class="v">${(b.CrC*100).toFixed(1)}% / x${b.CrD.toFixed(2)}</div></div>
          <div class="selRow"><div class="k">Magic</div><div class="v">${b.MD}</div></div>
          ${peelPowerLine}
          <div class="selRow"><div class="k">Skill Mana</div><div class="v">${manaLine}</div></div>
          <div class="selRow"><div class="k">Mana Regen</div><div class="v">${b.MaR.toFixed(1)}/s</div></div>
          <div class="selRow"><div class="k">Mana/Hit</div><div class="v">${b.manaOnHit.toFixed(2)}</div></div>
          <div class="selRow"><div class="k">ArP</div><div class="v">${(b.ArP*100).toFixed(0)}%</div></div>
          <div class="selRow"><div class="k">MaP</div><div class="v">${b.MaP}</div></div>
          <div class="selHint"><b>Auto Attack</b>: ${autoAttackText}</div>
          <div class="selHint"><b>${d.skillName}</b>: ${desc}</div>
        `;
        upBtn.disabled=true; upBtn.textContent="Upgrade (Z)"; upBtn.title="";
        resetFastBtn();
        sellBtn.disabled=true; sellBtn.textContent="Sell (C)";
        return;
      }

      info.textContent="—";
      upBtn.disabled=true; upBtn.textContent="Upgrade (Z)"; upBtn.title="";
      resetFastBtn();
      sellBtn.disabled=true; sellBtn.textContent="Sell (C)";
    }
    loop(){
      const t=now();
      const elapsed=Math.max(0, t-this.lastT);
      this.lastT=t;
      const dt=Math.min(elapsed, MAX_FRAME_DELTA_SEC);
      const perfEnabled = !!window.__armtdPerf;
      const perfHud = this.uiAdapter?.refs?.perfHud || null;
      if (perfHud) perfHud.style.display = "block";
      const perfFrameStart = perfEnabled ? performance.now() : 0;
      let perfStart = 0;

      const fpsAcc = this._fpsAcc || (this._fpsAcc = { sec: 0, frames: 0, label: "--" });
      fpsAcc.sec += elapsed;
      fpsAcc.frames += 1;
      if (fpsAcc.sec >= 0.5) {
        const fps = fpsAcc.frames / Math.max(0.001, fpsAcc.sec);
        fpsAcc.label = Number.isFinite(fps) ? fps.toFixed(0) : "--";
        fpsAcc.sec = 0;
        fpsAcc.frames = 0;
      }
      if (perfHud && !perfEnabled) {
        perfHud.textContent = `FPS: ${fpsAcc.label}`;
      }

      const currentMapKey = `${this.map?.w || 0}x${this.map?.h || 0}`;
      if (this._resizeDirty || this._resizeMapKey !== currentMapKey) {
        this.resizeCanvasToDisplaySize();
      }

      const menuOpen = typeof this.menuVisibility === "function" && this.menuVisibility();
      if (perfEnabled) perfStart = performance.now();
      let simulationSteps = 0;
      if (!menuOpen) {
        this._simulationAccumulator = Math.min(
          (Number(this._simulationAccumulator) || 0) + dt,
          SIMULATION_STEP_SEC * MAX_SIMULATION_STEPS_PER_FRAME
        );
        while (this._simulationAccumulator + 1e-9 >= SIMULATION_STEP_SEC
          && simulationSteps < MAX_SIMULATION_STEPS_PER_FRAME) {
          this.update(SIMULATION_STEP_SEC);
          this._simulationAccumulator -= SIMULATION_STEP_SEC;
          simulationSteps += 1;
        }
      } else {
        // The menu overlays the battlefield; pausing simulation here avoids
        // running enemy/tower work while the player is browsing the menu.
        this._simulationAccumulator = 0;
      }
      if (perfEnabled) this._perfAcc.updateMs += (performance.now() - perfStart);

      if (perfEnabled) perfStart = performance.now();
      if (!menuOpen) this.draw();
      if (perfEnabled) this._perfAcc.drawMs += (performance.now() - perfStart);

      this._uiRefreshTimer += dt;
      if (this._uiDirty && this._uiRefreshTimer >= this._uiRefreshInterval) {
        if (perfEnabled) perfStart = performance.now();
        this.refreshUI(true);
        if (perfEnabled) this._perfAcc.uiMs += (performance.now() - perfStart);
      }

      if (perfEnabled) {
        const acc = this._perfAcc;
        acc.sec += elapsed;
        acc.frames += 1;
        const framePacingMs = elapsed * 1000;
        const jsFrameCostMs = performance.now() - perfFrameStart;
        acc.framePacingMs += framePacingMs;
        acc.framePacingSamples.push(framePacingMs);
        acc.jsFrameMs += jsFrameCostMs;
        if (acc.sec >= 1.0) {
          const inv = 1 / Math.max(1, acc.frames);
          const sortedFrames = [...acc.framePacingSamples].sort((a, b) => a - b);
          const percentile = (ratio) => {
            if (!sortedFrames.length) return 0;
            const index = Math.min(sortedFrames.length - 1, Math.max(0, Math.ceil(sortedFrames.length * ratio) - 1));
            return sortedFrames[index];
          };
          const summary = `fps:${(acc.frames / acc.sec).toFixed(1)} frame:${(acc.framePacingMs * inv).toFixed(2)}ms p95:${percentile(0.95).toFixed(2)}ms p99:${percentile(0.99).toFixed(2)}ms js:${(acc.jsFrameMs * inv).toFixed(2)}ms update:${(acc.updateMs * inv).toFixed(2)}ms draw:${(acc.drawMs * inv).toFixed(2)}ms ui:${(acc.uiMs * inv).toFixed(2)}ms`;
          console.debug(
            `[PERF] ${summary}`
          );
          if (perfHud) perfHud.textContent = summary;
          acc.sec = 0;
          acc.frames = 0;
          acc.framePacingMs = 0;
          acc.framePacingSamples.length = 0;
          acc.jsFrameMs = 0;
          acc.updateMs = 0;
          acc.drawMs = 0;
          acc.uiMs = 0;
        }
      } else if (this._perfAcc.frames > 0) {
        if (perfHud) perfHud.textContent = "";
        this._perfAcc.sec = 0;
        this._perfAcc.frames = 0;
        this._perfAcc.framePacingMs = 0;
        this._perfAcc.framePacingSamples.length = 0;
        this._perfAcc.jsFrameMs = 0;
        this._perfAcc.updateMs = 0;
        this._perfAcc.drawMs = 0;
        this._perfAcc.uiMs = 0;
      }

      requestAnimationFrame(()=>this.loop());
    }
  }

  // =========================================================
  // Modal logic
  // =========================================================
  
export {
  Game,
  GAME_VERSION,
  RUN_SAVE_SCHEMA,
  escapeHtmlText,
  normalizeMapDef,
  normalizeSpecialUpgrades
};
