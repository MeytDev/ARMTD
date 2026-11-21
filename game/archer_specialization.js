import { acquireEffectLine } from "./projectiles.js";

export const ARCHER_SPECIALIZATION_LEVEL = 5;
const PIERCE_LENGTH = 2.5;
const PIERCE_HALF_WIDTH = 0.32;
const PIERCE_HITS = 2;
const PIERCE_PERCENT = 55;
const FOCUS_STEP_PERCENT = 12;
const MAX_FOCUS_STACKS = 5;

export const ARCHER_PATHS = Object.freeze({
  pierce: {
    name: "Piercing Shot",
    description: `After impact, the arrow strikes up to ${PIERCE_HITS} enemies in line within ${PIERCE_LENGTH} tiles behind the target for ${PIERCE_PERCENT}% shot damage each.`
  },
  focus: {
    name: "Focused Fire",
    description: `Each repeat hit adds ${FOCUS_STEP_PERCENT}% of this Archer’s own shot damage before defenses. With a 100-damage shot: hit 1 deals 100, hit 2 deals ${100 + FOCUS_STEP_PERCENT}, hit ${MAX_FOCUS_STACKS + 1} onward deals ${100 + MAX_FOCUS_STACKS * FOCUS_STEP_PERCENT}. Stronger arrows, crits and Power Shot scale the bonus. Hitting another enemy resets it.`
  }
});

export function focusBonusPercent(tower, target){
  return target && tower.focusTarget === target ? tower.focusStacks * FOCUS_STEP_PERCENT : 0;
}

export function registerFocusHit(tower, target){
  const bonus = focusBonusPercent(tower, target);
  tower.focusStacks = tower.focusTarget === target ? Math.min(MAX_FOCUS_STACKS, tower.focusStacks + 1) : 1;
  tower.focusTarget = target;
  return 1 + bonus / 100;
}

export function pierceBehind(tower, primary, game, payload){
  const dx = primary.x - tower.x;
  const dy = primary.y - tower.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return;
  const ux = dx / length;
  const uy = dy / length;
  const midpoint = PIERCE_LENGTH / 2;
  const nearby = game.getEnemiesInRange?.(
    primary.x + ux * midpoint, primary.y + uy * midpoint, Math.hypot(midpoint, PIERCE_HALF_WIDTH)
  ) ?? game.enemies;
  const hits = [];
  for (const enemy of nearby) {
    if (enemy === primary || enemy.dead || enemy.reachedExit) continue;
    const ex = enemy.x - primary.x;
    const ey = enemy.y - primary.y;
    const forward = ex * ux + ey * uy;
    const offset = Math.abs(ex * uy - ey * ux);
    if (forward > 0 && forward <= PIERCE_LENGTH && offset <= PIERCE_HALF_WIDTH) hits.push({ enemy, forward });
  }
  hits.sort((a, b) => a.forward - b.forward);
  const count = Math.min(hits.length, PIERCE_HITS);
  for (let i = 0; i < count; i++) {
    tower.damageDealt += hits[i].enemy.takeDamage(
      payload.physRaw * PIERCE_PERCENT / 100, payload.magicRaw * PIERCE_PERCENT / 100,
      payload.armorPenPct, payload.magicPenFlat, tower, true, false, payload.floatColor, payload.isCrit
    );
  }
  const reach = count === PIERCE_HITS ? hits[count - 1].forward : PIERCE_LENGTH;
  game.effects.push(acquireEffectLine(primary.x, primary.y,
    primary.x + ux * reach, primary.y + uy * reach, 0.12, "rgba(125,211,252,0.9)", 2));
}
