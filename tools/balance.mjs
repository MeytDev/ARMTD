import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Game, GAME_VERSION } from "../game/game.js";
import { CONTENT_REGISTRY as registry } from "../game/content_registry.js";
import { SFX } from "../game/audio.js";
import { GAME_EVENTS } from "../game/events.js";
import { applyMagicDamage, applyPhysicalDamage } from "../game/damage.js";
import { WaveState } from "../game/waves.js";
import { Tower, milestoneTier, getSpecialRarityTableAtLevel, setSpecialRarityUpgradeLevel, SPECIAL_RARITY_UPGRADE_MAX_LEVEL } from "../game/towers.js";
import { mapGeometry, placements, round } from "./balance_geometry.mjs";

// Only UI, audio and browser persistence are suppressed. Timers, targeting,
// movement, projectiles, rewards and the spatial indexes use the live engine.
export class Simulation extends Game {
  constructor(mapIndex, seed) {
    super(null, { headless: true, mapIndex, seed });
    this.investmentSlots = new Map();
    this.nextBuildSlot = 0;
    SFX.setMuted(true);
  }
  refreshUI() {}
  syncSpeedUI() {}
  maybeShowModifierIntro() {}
  persistLifetimeStats() {}
  saveHighKills() {}
  resolvePeelUplinkWaveEnd() {
    const before = this.coreHP;
    super.resolvePeelUplinkWaveEnd();
    if (this.experimentalCoreCap !== undefined) {
      this.coreHP = Math.min(this.coreHP, Math.max(before, this.experimentalCoreCap));
    }
  }
}

export function census(lastWave, seed) {
  const game = new Simulation(0, seed);
  const rows = [];
  for (let wave = 1; wave <= lastWave; wave++) {
    const state = new WaveState(wave);
    let hp = 0, bossHP = 0, bounty = 0, physicalEHP = 0, magicEHP = 0;
    let count = 0, armor = 0, mr = 0, speed = 0;
    for (const part of state.plan) {
      for (let i = 0; i < part.count; i++) {
        const e = game.spawnWaveEnemy(part.type, wave, state.modifiers);
        count++;
        hp += e.maxHP;
        armor += e.armor;
        mr += e.mr;
        speed += Math.min(10, e.baseSpeed);
        if (e.isBoss) bossHP += e.maxHP;
        bounty += e.wealth;
        physicalEHP += e.maxHP / applyPhysicalDamage(1, e.armor, 0);
        magicEHP += e.maxHP / applyMagicDamage(1, e.mr, 0);
      }
    }
    rows.push({ wave, count, hp, bossHP, bounty, physicalEHP: Math.round(physicalEHP),
      magicEHP: Math.round(magicEHP), meanArmor: round(armor / count), meanMR: round(mr / count),
      meanSpeed: round(speed / count), interval: round(state.spawnInterval), burstEvery: state.burstEvery,
      formation: state.plan.map(p => p.type + "×" + p.count).join(" ") });
    game.enemies.length = 0;
  }
  return rows;
}

const roster = ["archer", "mage", "blizzard", "breaker", "poison", "sniper", "mage", "archer", "peel", "poison", "blizzard", "breaker"];
const openingLevels = [2, 3, 4, 5, 5, 6, 8, 10, 12, 14];
const rarityRank = new Map(getSpecialRarityTableAtLevel(0).map((r, i) => [r.id, i]));
const siteCache = new Map();

// A player pursuing breakpoints can field cheap damage first and delay the
// expensive support investment. Indices identify distinct copies on the board.
const breakpointRoster = ["archer", "mage", "blizzard", "breaker", "mage", "poison", "mage", "breaker",
  "mage", "blizzard", "poison", "mage", "sniper", "peel", "breaker", "mage"];
const earlyInvestments = [
  [0,1],[1,1],[0,2],[1,2],[2,2],[3,2],[1,5],[4,5],[0,5],[5,3],[2,5],[3,5],
  [6,5],[7,5],[8,5],[9,5],[10,5],[11,5],[3,10],[1,10]
];
const breakpointPlan = [...earlyInvestments, [0,10],[5,10],[3,21],[1,21],[12,5],[13,1],[2,21],[0,21],[5,21],[14,10],[15,10]];
const synergyRoster = ["archer", "mage", "blizzard", "breaker", "archer", "poison", "archer", "breaker",
  "poison", "blizzard", "archer", "breaker", "sniper", "peel", "poison", "archer"];
const synergyPlan = [...earlyInvestments,
  [0,21],[3,21],[13,1],[1,21],[5,21],[2,21],[12,5],[14,10],[15,10]];

function buyLevel(game, tower) {
  if (!game.purchaseTowerLevel(tower, "simulation")) return false;
  const tier = milestoneTier(tower.level);
  if (tier) {
    const { choices: offers } = game.rollMilestoneChoices(tower, tier);
    // Prefer the rarest real offer. Tie-break in favor of speed, then damage.
    offers.sort((a, b) => rarityRank.get(b.rarityId) - rarityRank.get(a.rarityId)
      || ["as", "ad", "mag"].indexOf(a.code) - ["as", "ad", "mag"].indexOf(b.code));
    offers[0].apply(tower);
  }
  if (tower.canChooseArcherPath()) tower.chooseArcherPath(game.towers.indexOf(tower) === 0 ? "pierce" : "focus");
  return true;
}

function investAtBreakpoints(game, synergy) {
  const lineup = synergy ? synergyRoster : breakpointRoster;
  const plan = synergy ? synergyPlan : breakpointPlan;
  for (const [slot, level] of plan) {
    let tower = game.investmentSlots.get(slot);
    if (tower === null) continue;
    if (!tower) {
      const def = registry.towers.get(lineup[slot]);
      const site = chooseSite(game, def, "coverage");
      if (!site) {
        game.investmentSlots.set(slot, null);
        continue;
      }
      if (game.gold < def.cost) return;
      tower = game.purchaseTower(def, site.x, site.y);
      if (!tower) return;
      game.investmentSlots.set(slot, tower);
      if (synergy && (slot === 2 || slot === 8)) tower.targetMode = "pure";
    }
    while (tower.level < level) if (!buyLevel(game, tower)) return;
  }
  for (;;) {
    const tower = game.towers.filter(t => t.canUpgrade()).sort((a,b) => a.upgradeCost() - b.upgradeCost())[0];
    if (!tower || !buyLevel(game, tower)) return;
  }
}

function chooseSite(game, def, policy) {
  const key = game.mapIndex + "/" + def.id;
  if (game.pendingSite?.key === key && game.pendingSite.count === game.towers.length) return game.pendingSite.site;
  if (!siteCache.has(key)) {
    // Use an empty board to cache route intersections, even if first requested mid-run.
    // Never construct another Game here: its constructor seeds the combat RNG.
    const empty = Object.create(game);
    empty.towers = [];
    siteCache.set(key, placements(empty, def));
  }
  const legal = siteCache.get(key).filter(p => game.canPlaceTowerAt(p.x, p.y, def));
  let site;
  if (def.behavior === "support") {
    const score = p => game.towers.filter(t => Math.hypot(t.x - p.x - def.size / 2, t.y - p.y - def.size / 2) <= def.base.Range).length;
    legal.sort((a, b) => score(b) - score(a));
    site = legal[0];
  } else {
    const firing = legal.filter(p => p.covered > 0);
    site = policy === "median" ? firing[Math.floor(firing.length / 2)] : firing[0];
  }
  game.pendingSite = { key, count: game.towers.length, site };
  return site;
}

function spend(game, policy) {
  if (policy === "breakpoints" || policy === "synergy") return investAtBreakpoints(game, policy === "synergy");
  const mono = policy === "archers";
  const slots = roster.length;
  for (;;) {
    const n = game.nextBuildSlot;
    const lowest = [...game.towers].filter(t => t.canUpgrade())
      .sort((a, b) => a.level - b.level || a.upgradeCost() - b.upgradeCost())[0];
    const buy = n < slots && (n < 2 || !lowest || lowest.level >= openingLevels[n - 2]);
    if (buy) {
      const def = registry.towers.get(mono ? "archer" : roster[n]);
      const pos = chooseSite(game, def, policy);
      if (pos && game.gold < def.cost) return;
      if (pos && !game.purchaseTower(def, pos.x, pos.y)) return;
      game.nextBuildSlot++;
      continue;
    }
    if (!lowest || !buyLevel(game, lowest)) return;
  }
}

export function simulate({ map = 0, seed = 17, policy = "coverage", stars = 0, until = 100, from = 1, budget, coreCap }) {
  const game = new Simulation(map, seed);
  game.experimentalCoreCap = coreCap;
  setSpecialRarityUpgradeLevel(stars);
  if (budget !== undefined) game.gold = budget;
  const startingGold = game.gold;
  let cleared = from - 1, firstLeak = null, leaks = 0, bossLeaks = 0;
  const checkpoints = [];
  game.events.on(GAME_EVENTS.CORE_DAMAGED, e => {
    firstLeak ??= e.waveNum;
    leaks++;
    if (e.isBossSource) bossLeaks++;
  });
  game.events.on(GAME_EVENTS.WAVE_ENDED, e => {
    if (game.coreHP <= 0) return;
    cleared = e.waveNum;
    if (cleared % 10 === 0 || cleared === until) checkpoints.push([cleared, game.coreHP, Math.round(game.gold), game.totalKills]);
  });
  game.nextWaveNum = from;
  spend(game, policy);
  game.start();
  let steps = 0;
  while (!game.gameOver && !game.winModalOpen && cleared < until) {
    if (++steps > 18000 * (until - from + 2)) throw new Error("Simulation time limit exceeded");
    if (steps % 60 === 0) spend(game, policy);
    game.update(1 / 60);
  }
  const towers = game.towers.map(t => ({
    id: t.def.id, level: t.level, site: [t.gx, t.gy], spent: t.spentGold,
    kills: t.kills, damage: Math.round(t.damageDealt),
    choices: t.specialUpgrades.map(s => s.rarityId)
  }));
  const spendTotal = towers.reduce((n, tower) => n + tower.spent, 0);
  const uplinkGold = game.towers.reduce((n, tower) => n + (tower.uplinkTotalGold || 0), 0);
  return { map: map + 1, seed, policy, stars, from, until, startingGold, ...(coreCap === undefined ? {} : { experimentalCoreCap: coreCap }), wave: game.currentWave, cleared,
    core: game.coreHP, firstLeak, leaks, bossLeaks, gold: Math.round(game.gold), kills: game.totalKills,
    simulatedSeconds: round(game.simTime), spendTotal, earnedGold: Math.round(game.gold + spendTotal - startingGold),
    supportGold: game.runStats.supportGold + uplinkGold, uplinkGold,
    damageByType: Object.fromEntries(Object.entries(game.runStats.towerDamage).map(([id, n]) => [id, Math.round(n)])),
    supportBuffSeconds: round(game.runStats.supportBuffSeconds), checkpoints, towers };
}

function integerList(raw, min, max) {
  const values = raw.split(",").map(s => s.trim()).map(s => /^\d+$/.test(s) ? Number(s) : NaN);
  if (values.some(n => !Number.isSafeInteger(n) || n < min || n > max)) throw new Error("Out of range: " + raw);
  return [...new Set(values)];
}

// An identical level-5 Archer provides a beneficiary for buffs and control.
// The high core and setup wallet are diagnostic only. No spending is allowed
// during the encounter; run one control and one trial for each registry entry.
export function towerTrial(map, seed, wave, level, def = null) {
  const game = new Simulation(map, seed);
  setSpecialRarityUpgradeLevel(0);
  game.coreHP = 10000;
  game.gold = 1e9;
  const install = (type, targetLevel) => {
    const site = chooseSite(game, type, "coverage");
    if (!site) return null;
    const tower = game.purchaseTower(type, site.x, site.y);
    while (tower.level < targetLevel) {
      if (!buyLevel(game, tower)) throw new Error("Could not reach the requested trial level");
    }
    return tower;
  };
  install(registry.towers.get("archer"), 5);
  const candidate = def && install(def, level);
  if (def && !candidate) return { wave, level, id: def.id, available: false };
  let finished = false, leaks = 0;
  game.events.on(GAME_EVENTS.CORE_DAMAGED, () => leaks++);
  game.events.on(GAME_EVENTS.WAVE_ENDED, () => { finished = true; });
  game.nextWaveNum = wave;
  game.start();
  while (!finished) {
    game.update(1 / 60);
    if (game.gameOver || game.simTime > 600) throw new Error("Isolated encounter did not clear");
  }
  return { wave, level, id: def?.id ?? "control", available: true, spent: candidate?.spentGold ?? 0,
    kills: game.totalKills, leaks, hpRemoved: Math.round(game.runStats.totalDamage),
    overkill: Math.round(game.runStats.totalOverkill), buffSeconds: round(game.runStats.supportBuffSeconds),
    uplinkCore: candidate?.uplinkTotalCore ?? 0, incomeFromSkills: (candidate?.uplinkTotalGold ?? 0) + game.runStats.supportGold };
}

function baseTowerLevels(def) {
  const game = new Simulation(0, 17);
  game.gold = 1e9;
  const tower = new Tower(def, 0, 0, game);
  game.towers.push(tower);
  const levels = [];
  do {
    levels.push({ level: tower.level, spent: tower.spentGold, nextCost: tower.canUpgrade() ? tower.upgradeCost() : null,
      AD: [...tower.AD], AS: round(tower.AS), range: round(tower.range), magic: round(tower.magicBonusExact),
      critChance: round(tower.critChance * 100), critMultiplier: tower.critDmg, manaRegen: round(tower.manaRegen),
      manaOnHit: round(tower.manaOnHit), armorPenPct: round(tower.armorPenPct * 100), flatMagicPen: tower.magicPenFlat });
  } while (game.purchaseTowerLevel(tower, "catalog"));
  return { id: def.id, size: def.size ?? 1, skill: def.skillName, mana: def.skillManaCost,
    prestige: def.prestige?.name, prestigeMana: def.prestige?.mana, levels };
}

function main() {
  const string = { type: "string" };
  const { values: v } = parseArgs({ options: { maps: string, seeds: string, stars: string, policies: string,
    until: string, output: string, "experimental-core-cap": string, probes: { type: "boolean" },
    "catalog-only": { type: "boolean" }, "tower-trials": { type: "boolean" } } });
  const catalogMaps = registry.maps.list.map((_, i) => i + 1).join(",");
  const maps = integerList(v.maps ?? (v["catalog-only"] ? catalogMaps : "1,2,3"), 1, registry.maps.count);
  const seeds = integerList(v.seeds ?? "17,41,97", 1, 0xffffffff);
  const starLevels = integerList(v.stars ?? "0", 0, SPECIAL_RARITY_UPGRADE_MAX_LEVEL);
  const policies = (v.policies ?? "median,coverage,archers").split(",");
  if (policies.some(p => !["median", "coverage", "archers", "breakpoints", "synergy"].includes(p))) throw new Error("Unknown policy");
  const maxWave = Math.max(...maps.map(m => registry.maps.getTargetWaveByMapIndex(m - 1)));
  const until = v.until === undefined ? maxWave : integerList(v.until, 1, maxWave)[0];
  const coreCap = v["experimental-core-cap"] === undefined ? undefined : integerList(v["experimental-core-cap"], 1, 10000)[0];
  const waves = census(until, seeds[0]);
  const result = { version: GAME_VERSION, censusSeed: seeds[0], geometry: [], waves, rarity: {}, runs: [], probes: [] };
  const censusOnly = v["catalog-only"] && !v["tower-trials"];
  const rarityLevels = censusOnly ? Array.from({ length: SPECIAL_RARITY_UPGRADE_MAX_LEVEL + 1 }, (_, i) => i) : starLevels;
  for (const stars of rarityLevels) result.rarity[stars] = getSpecialRarityTableAtLevel(stars);
  if (censusOnly) result.towerLevelsBeforeSpecials = registry.towers.list.map(baseTowerLevels);
  for (const m of maps) {
    const map = m - 1;
    const end = Math.min(until, registry.maps.getTargetWaveByMapIndex(map));
    result.geometry.push(mapGeometry(new Simulation(map, seeds[0])));
    if (v["tower-trials"]) {
      result.towerTrials ??= [];
      for (const [wave, level] of [[9,5],[39,10],[79,21],[80,21]]) {
        if (wave > end) continue;
        for (const def of [null, ...registry.towers.list]) {
          result.towerTrials.push({ map: m, seed: seeds[0], ...towerTrial(map, seeds[0], wave, level, def) });
        }
      }
    }
    if (v["catalog-only"]) continue;
    for (const seed of seeds) for (const policy of policies) for (const stars of starLevels) {
      result.runs.push(simulate({ map, seed, policy, stars, until: end, coreCap }));
    }
    if (v.probes) for (const wave of new Set([50, 80, 100, end].filter(w => w <= end))) {
      const budget = waves.slice(0, wave - 1).reduce((sum, row) => sum + row.bounty, 150);
      result.probes.push(simulate({ map, seed: seeds[0], from: wave, until: wave, budget }));
    }
  }
  // One row per measurement keeps diffs readable as the roster grows.
  const sections = Object.entries(result).map(([k, data]) => JSON.stringify(k) + ": " + (Array.isArray(data)
    ? "[\n" + data.map(row => "    " + JSON.stringify(row)).join(",\n") + "\n  ]" : JSON.stringify(data)));
  const json = "{\n  " + sections.join(",\n  ") + "\n}\n";
  if (v.output) writeFileSync(v.output, json);
  else process.stdout.write(json);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
