import { CONTENT_REGISTRY } from "../game/content_registry.js";
import { WaveState, scaleForWave } from "../game/waves.js";

export const round = n => Number(n.toFixed(2));

// Clip every traversed segment against the range circle, retaining distance
// along the route. Separate intersections are distinct firing opportunities.
export function exposure(path, x, y, radius) {
  let distance = 0;
  const intervals = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (!length) continue;
    const ax = x - (a.x + 0.5), ay = y - (a.y + 0.5);
    const along = (ax * dx + ay * dy) / length;
    const across = (ax * dy - ay * dx) / length;
    const half = Math.sqrt(Math.max(0, radius * radius - across * across));
    const left = distance + Math.max(0, along - half);
    const right = distance + Math.min(length, along + half);
    if (right > left + 1e-9) {
      const last = intervals.at(-1);
      if (last && left <= last[1] + 1e-9) last[1] = right;
      else intervals.push([left, right]);
    }
    distance += length;
  }
  return { distance, intervals, covered: intervals.reduce((n, [a, b]) => n + b - a, 0) };
}

// Exact peak for finite wave-1 runners at constant unimpeded speed.
function peakTargets(intervals, speed, spacing, count) {
  const events = [];
  for (let i = 0; i < count; i++) {
    for (const [start, end] of intervals) {
      events.push([i * spacing + start / speed, 1], [i * spacing + end / speed, -1]);
    }
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let peak = 0, active = 0;
  for (const [, delta] of events) { active += delta; peak = Math.max(peak, active); }
  return peak;
}

export function placements(game, def) {
  const result = [];
  const size = def.size ?? 1;
  for (let y = 0; y < game.map.h; y++) {
    for (let x = 0; x < game.map.w; x++) {
      if (!game.canPlaceTowerAt(x, y, def)) continue;
      const measure = exposure(game.map.path, x + size / 2, y + size / 2, def.base.Range);
      result.push({ x, y, ...measure });
    }
  }
  return result.sort((a, b) => b.covered - a.covered || a.y - b.y || a.x - b.x);
}

export function mapGeometry(game) {
  const wave = new WaveState(1);
  const runnerSpeed = scaleForWave(CONTENT_REGISTRY.enemies.get("runner"), 1).Speed;
  const runners = wave.plan.find(p => p.type === "runner").count;
  const length = exposure(game.map.path, 0, 0, 0).distance;
  const buildable = game.map.grid.reduce((n, row, y) => n + row.filter((_, x) => game.map.isBuildable(x, y)).length, 0);
  const towers = {};
  for (const def of CONTENT_REGISTRY.towers.list) {
    const sites = placements(game, def);
    if (def.behavior === "support") {
      const size = def.size ?? 1;
      const slots = sites.map(site => {
        let allies = 0;
        for (let y = 0; y < game.map.h; y++) for (let x = 0; x < game.map.w; x++) {
          if (!game.map.isBuildable(x, y)) continue;
          if (x >= site.x && x < site.x + size && y >= site.y && y < site.y + size) continue;
          if (Math.hypot(x + 0.5 - site.x - size / 2, y + 0.5 - site.y - size / 2) <= def.base.Range) allies++;
        }
        return allies;
      });
      towers[def.id] = { legalSites: sites.length, bestAllySlots: Math.max(0, ...slots) };
      continue;
    }
    if (!sites.length) { towers[def.id] = { legalSites: 0 }; continue; }
    const best = sites[0];
    towers[def.id] = {
      range: def.base.Range, legalSites: sites.length,
      medianTiles: round(sites[Math.floor(sites.length / 2)].covered),
      p90Tiles: round(sites[Math.floor((sites.length - 1) * 0.1)].covered),
      bestTiles: round(best.covered), bestSite: [best.x, best.y],
      bestPasses: best.intervals.length, multiPassSites: sites.filter(p => p.intervals.length > 1).length,
      bestRunnerSeconds: round(best.covered / runnerSpeed),
      bestSitePeakRunners: peakTargets(best.intervals, runnerSpeed, wave.spawnInterval, runners)
    };
  }
  return { map: game.map.name, length, buildable, runnerTransitSeconds: round(length / runnerSpeed), towers };
}
