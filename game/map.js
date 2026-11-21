function mapCoordinate(raw, fallback){
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function buildSMap(w = 20, h = 15) {
  const g = Array.from({ length: h }, () => Array.from({ length: w }, () => 0));
  const mark = (x, y) => { if (x >= 0 && y >= 0 && x < w && y < h) g[y][x] = 1; };

  for (let x = 0; x <= 5; x += 1) mark(x, 7);
  for (let y = 7; y >= 3; y -= 1) mark(5, y);
  for (let x = 5; x <= 14; x += 1) mark(x, 3);
  for (let y = 3; y <= 10; y += 1) mark(14, y);
  for (let y = 10; y >= 7; y -= 1) mark(18, y);
  for (let x = 15; x <= 18; x += 1) mark(x, 10);
  mark(5, 4);
  mark(6, 3);
  mark(13, 3);
  mark(14, 4);

  return g;
}

const MAP_CODE_W = 20;
const MAP_CODE_H = 15;
const MAP_CODE_X = "abcdefghijklmnopqrst";
const MAP_CODE_Y = "0123456789!?#*=";

function buildEmptyMapCodeGrid() {
  return Array.from({ length: MAP_CODE_H }, () => Array.from({ length: MAP_CODE_W }, () => 0));
}

function decodeCampaignMapCode(rawCode) {
  const raw = String(rawCode || "").trim();
  if (!raw) throw new Error("Empty campaign map code.");

  let mapName = "Campaign Map";
  let dataPart = raw;
  if (raw.startsWith("ARMTD1|")) {
    const segments = raw.split("|").slice(1);
    for (const seg of segments) {
      const [k, ...rest] = seg.split("=");
      const value = rest.join("=");
      if (k === "N") {
        try { mapName = decodeURIComponent(value || "Campaign Map"); } catch (_) {}
      }
      if (k === "D") dataPart = value || "";
    }
  }

  const parts = dataPart.split(",").map(p => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error("Invalid campaign map code.");

  const grid = buildEmptyMapCodeGrid();
  let spawn = null;
  let core = null;

  for (const token of parts) {
    const m = token.match(/^([a-t])([0-9!?#*=])([scwo])$/i);
    if (!m) continue;
    const x = MAP_CODE_X.indexOf(String(m[1]).toLowerCase());
    const y = MAP_CODE_Y.indexOf(m[2]);
    if (x < 0 || y < 0) continue;
    const t = String(m[3]).toUpperCase();
    if (t === "S") spawn = { x, y };
    if (t === "C") core = { x, y };
    if (t === "W") grid[y][x] = 1;
    if (t === "O") grid[y][x] = 2;
  }

  if (!spawn || !core) throw new Error("Campaign map code must include Spawn and Core.");

  return {
    name: String(mapName || "Campaign Map"),
    gridW: MAP_CODE_W,
    gridH: MAP_CODE_H,
    entrance: { x: spawn.x, y: spawn.y },
    exit: { x: core.x, y: core.y },
    grid,
    hazards: []
  };
}

const XENO_MAP_CODE = "ARMTD1|N=Xeno|D=b2S,s*C,g1W,h1W,i1W,j1W,k1W,l1W,m1W,n1W,o1W,p1W,q1W,r1W,d2W,f2W,g2W,r2W,s2W,b3W,d3W,f3W,j3W,k3W,l3W,o3W,p3W,s3W,b4W,d4W,f4W,i4W,j4W,l4W,m4W,p4W,q4W,s4W,b5W,d5W,f5W,h5W,i5W,m5W,n5W,p5W,q5W,s5W,b6W,d6W,f6W,h6W,n6W,s6W,b7W,d7W,f7W,h7W,n7W,q7W,r7W,s7W,b8W,f8W,h8W,i8W,n8W,q8W,b9W,c9W,d9W,f9W,i9W,j9W,k9W,l9W,m9W,n9W,o9W,p9W,q9W,s9W,d!W,f!W,n!W,s!W,c?W,d?W,f?W,h?W,i?W,j?W,k?W,l?W,n?W,q?W,r?W,s?W,c#W,f#W,h#W,i#W,j#W,k#W,l#W,n#W,o#W,c*W,d*W,e*W,f*W,h*W,i*W,j*W,k*W,l*W,o*W,p*W,q*W,r*W,s*W";
const ELIXIR_MAP_CODE = "ARMTD1|N=Elixir|D=s1S,s*C,b1W,c1W,d1W,e1W,f1W,h1O,i1O,k1W,l1W,m1W,n1W,o1W,p1W,q1W,r1W,s1W,b2W,f2W,h2O,i2O,k2W,b3W,f3W,k3W,b4W,c4W,d4W,e4W,f4W,g4W,h4W,i4W,j4W,k4W,l4W,m4W,n4W,o4W,p4W,q4W,r4W,s4W,f5W,k5W,s5W,f6W,h6O,i6O,k6W,o6O,p6O,s6W,b7W,c7W,d7W,e7W,f7W,h7O,i7O,k7W,l7W,m7W,n7W,o7O,p7O,q7W,r7W,s7W,b8W,h8O,i8O,n8W,o8O,p8O,q8W,b9W,d9O,g9O,h9O,i9O,j9O,l9O,n9W,o9O,p9O,q9W,r9W,s9W,b!W,n!W,o!O,p!O,s!W,b?W,c?W,d?W,e?W,f?W,g?W,h?W,i?W,j?W,k?W,l?W,m?W,n?W,o?O,p?O,q?W,r?W,s?W,o#O,p#O,q#W,b*O,c*O,d*O,e*O,f*O,g*O,h*O,i*O,j*O,k*O,l*O,m*O,n*O,o*O,p*O,q*W,r*W,s*W";
const DATA_RUSH_2099_MAP_CODE = "ARMTD1|N=Data%20Rush%202099|D=r7S,b7C,b1O,c1O,d1O,e1O,m1O,n1O,o1O,p1O,q1O,r1O,s1O,b2O,c2O,d2O,e2O,g2W,h2W,i2W,j2W,m2O,n2O,o2O,p2O,q2O,r2O,s2O,b3O,c3O,d3O,e3O,g3W,j3W,m3O,n3O,o3O,p3O,q3O,r3O,s3O,b4O,c4O,d4O,e4O,g4W,j4W,m4O,n4O,o4O,p4O,q4O,r4O,s4O,b5O,c5O,d5O,e5O,g5W,j5W,m5O,n5O,o5O,p5O,q5O,r5O,s5O,g6W,j6W,b7W,c7W,d7W,e7W,f7W,g7W,j7W,n7W,o7W,p7W,q7W,r7W,j8W,n8W,b9O,c9O,d9O,e9O,f9O,g9O,h9O,j9W,n9W,p9O,q9O,r9O,s9O,b!O,c!O,d!O,e!O,f!O,g!O,h!O,j!W,n!W,p!O,q!O,r!O,s!O,b?O,c?O,d?O,e?O,f?O,g?O,h?O,j?W,n?W,p?O,q?O,r?O,s?O,b#O,c#O,d#O,e#O,f#O,g#O,h#O,j#W,k#W,l#W,m#W,n#W,p#O,q#O,r#O,s#O,b*O,c*O,d*O,e*O,f*O,g*O,h*O,p*O,q*O,r*O,s*O";
const ERROR_404_MAP_CODE = "ARMTD1|N=Error%20404|D=c2S,r#C,c2W,f2W,g2W,h2W,i2W,o2W,p2W,q2W,r2W,c3W,f3W,i3W,o3W,r3W,c4W,f4W,i4W,o4W,r4W,c5W,f5W,i5W,o5W,r5W,c6W,f6W,i6W,o6W,r6W,c7W,d7W,e7W,f7W,g7W,h7W,i7W,l7W,m7W,n7W,o7W,p7W,q7W,r7W,f8W,l8W,o8W,f9W,l9W,o9W,f!W,l!W,o!W,p!W,q!W,r!W,f?W,l?W,r?W,f#W,l#W,f*W,g*W,h*W,i*W,j*W,k*W,l*W";
const ZERACROWN_MAP_CODE = "ARMTD1|N=Zeracrown|D=c2S,r2C,c2W,j2W,k2W,l2W,c3W,e3O,f3O,g3O,j3W,l3W,o3O,p3O,r3W,s3W,c4W,e4O,f4O,g4O,j4W,l4W,o4O,p4O,s4W,c5W,e5O,f5O,g5O,j5W,l5W,s5W,c6W,i6W,j6W,l6W,m6W,s6W,c7W,d7W,e7W,f7W,g7W,h7W,i7W,m7W,n7W,o7W,p7W,q7W,s7W,c8W,d8W,q8W,s8W,c9W,d9W,g9O,h9O,i9O,j9O,l9O,m9O,n9O,o9O,p9W,q9W,s9W,c!W,d!W,g!O,h!O,i!O,j!O,l!O,m!O,n!O,o!O,p!W,s!W,c?W,d?W,g?O,h?O,i?O,j?O,l?O,m?O,n?O,p?W,q?W,s?W,c#W,d#W,q#W,r#W,s#W";
const NEUROVEIN_MAP_CODE = "ARMTD1|N=Neurovein|D=l1S,n9C,d1W,e1W,f1W,g1W,n1W,o1W,p1W,q1W,r1W,c2W,d2W,e2W,f2W,g2W,h2W,l2W,m2W,n2W,r2W,s2W,c3W,d3W,g3W,h3W,i3W,m3W,n3W,o3W,s3W,t3W,c4W,d4W,h4W,i4W,j4W,n4W,o4W,p4W,s4W,t4W,c5W,d5W,e5W,i5W,j5W,k5W,o5W,p5W,q5W,r5W,s5W,t5W,d6W,e6W,f6W,j6W,k6W,l6W,p6W,q6W,r6W,s6W,e7W,f7W,g7W,k7W,l7W,m7W,q7W,r7W,s7W,f8W,g8W,h8W,l8W,m8W,n8W,q8W,r8W,g9W,h9W,i9W,m9W,n9W,q9W,r9W,h!W,i!W,j!W,p!W,q!W,i?W,j?W,k?W,o?W,p?W,q?W,j#W,k#W,l#W,m#W,n#W,o#W,p#W,k*W,l*W,m*W,n*W,o*W";
const HEX_AGAINST_FOUR_MAP_CODE = "ARMTD1|N=Hex%20Against%20Four|D=b*S,s1C,b1W,c1W,d1W,e1W,f1W,g1W,h1W,i1W,j1W,k1W,l1W,m1W,n1W,o1W,p1W,q1W,r1W,s1W,b2W,b3W,c3W,d3W,e3W,f3W,g3W,h3W,i3W,j3W,k3W,m3W,n3W,o3W,q3W,r3W,s3W,k4W,m4W,o4W,q4W,s4W,b5W,c5W,d5W,e5W,f5W,g5W,h5W,i5W,j5W,k5W,m5W,o5W,q5W,s5W,b6W,m6W,o6W,q6W,s6W,b7W,c7W,d7W,e7W,f7W,g7W,h7W,i7W,j7W,k7W,m7W,o7W,q7W,s7W,k8W,m8W,o8W,q8W,s8W,b9W,c9W,d9W,e9W,f9W,g9W,h9W,i9W,j9W,k9W,m9W,o9W,q9W,s9W,b!W,m!W,o!W,q!W,s!W,b?W,c?W,d?W,e?W,f?W,g?W,h?W,i?W,j?W,k?W,l?W,m?W,o?W,p?W,q?W,s?W,s#W,b*W,c*W,d*W,e*W,f*W,g*W,h*W,i*W,j*W,k*W,l*W,m*W,n*W,o*W,p*W,q*W,r*W,s*W";
const SYNAPSE_GATE_MAP_CODE = "ARMTD1|N=Synapse%20Gate|D=b1S,o7C,a0O,b0O,c0O,l0O,m0O,a1O,e1W,f1W,g1W,h1W,i1W,j1W,o1W,p1W,q1W,r1W,s1W,a2O,b2W,e2W,j2W,o2W,s2W,a3O,b3W,e3W,j3W,l3O,m3O,o3W,p3W,q3W,s3W,b4W,e4W,f4W,g4W,j4W,q4W,s4W,b5W,g5W,j5W,k5W,l5W,m5W,n5W,o5W,p5W,q5W,s5W,b6W,g6W,h6W,n6O,o6O,p6O,s6W,t6O,b7W,h7W,n7O,o7W,p7O,s7W,t7O,b8W,d8W,e8W,f8W,h8W,i8W,j8W,k8W,n8O,o8W,p8O,s8W,t8O,b9W,c9W,d9W,f9W,k9W,o9W,p9W,q9W,s9W,f!W,k!W,q!W,s!W,t!O,b?W,c?W,d?W,e?W,f?W,h?O,i?O,k?W,l?W,m?W,n?W,o?W,p?W,q?W,s?W,t?O,b#W,s#W,t#O,b*W,c*W,d*W,e*W,f*W,g*W,h*W,i*W,j*W,k*W,l*W,m*W,n*W,o*W,p*W,q*W,r*W,s*W";
const NEUROLOOM_MAP_CODE = "ARMTD1|N=Neuroloom|D=c7S,r7C,c2W,d2W,e2W,f2W,g2W,h2W,i2W,j2W,k2W,l2W,m2W,n2W,o2W,p2W,c3W,p3W,c4W,g4W,h4W,i4W,j4W,k4W,l4W,p4W,c5W,g5W,l5W,p5W,c6W,g6W,l6W,p6W,c7W,e7W,f7W,g7W,h7W,i7W,j7W,k7W,l7W,p7W,r7W,e8W,g8W,p8W,r8W,e9W,g9W,p9W,r9W,e!W,g!W,h!W,i!W,j!W,k!W,l!W,m!W,n!W,o!W,p!W,q!W,r!W,e?W,p?W,e#W,f#W,g#W,h#W,i#W,j#W,k#W,l#W,m#W,n#W,o#W,p#W";

const MAP_POOL = [
  {
    name: "Neo City - S",
    gridW: 20,
    gridH: 15,
    entrance: { x: 0, y: 7 },
    exit: { x: 18, y: 7 },
    grid: buildSMap(20, 15),
    hazards: []
  },
  decodeCampaignMapCode(XENO_MAP_CODE),
  decodeCampaignMapCode(ELIXIR_MAP_CODE),
  decodeCampaignMapCode(DATA_RUSH_2099_MAP_CODE),
  decodeCampaignMapCode(ERROR_404_MAP_CODE),
  decodeCampaignMapCode(ZERACROWN_MAP_CODE),
  decodeCampaignMapCode(NEUROVEIN_MAP_CODE),
  decodeCampaignMapCode(HEX_AGAINST_FOUR_MAP_CODE),
  decodeCampaignMapCode(SYNAPSE_GATE_MAP_CODE),
  decodeCampaignMapCode(NEUROLOOM_MAP_CODE)
];

const DIRS = [
  { x: 1, y: 0 },  // right
  { x: 0, y: 1 },  // down
  { x: -1, y: 0 }, // left
  { x: 0, y: -1 }  // up
];

const DIR_SCORE_ORDER = [0, 1, 3, 2];

class GameMap {
  constructor(def) {
    this.name = String(def?.name || "Custom Map");
    this.w = Math.max(1, Math.floor(def?.gridW || 20));
    this.h = Math.max(1, Math.floor(def?.gridH || 15));
    this.grid = Array.isArray(def?.grid)
      ? def.grid.map(row => Array.isArray(row)
        ? row.map(v => {
            const cell = Math.floor(Number(v) || 0);
            if (cell === 1 || cell === 2) return cell;
            return 0;
          })
        : Array.from({ length: this.w }, () => 0))
      : Array.from({ length: this.h }, () => Array.from({ length: this.w }, () => 0));
    this.entrance = {
      x: Math.max(0, Math.min(this.w - 1, mapCoordinate(def?.entrance?.x, 0))),
      y: Math.max(0, Math.min(this.h - 1, mapCoordinate(def?.entrance?.y, 0)))
    };
    this.exit = {
      x: Math.max(0, Math.min(this.w - 1, mapCoordinate(def?.exit?.x, this.w - 1))),
      y: Math.max(0, Math.min(this.h - 1, mapCoordinate(def?.exit?.y, this.h - 1)))
    };
    this.path = this.buildPath();
  }

  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h; }
  isPath(x, y) { return this.grid[y][x] === 1; }
  isObstacle(x, y) { return this.grid[y][x] === 2; }
  isBuildable(x, y, { restoreOccupiedEndpoint = false } = {}) {
    if (this.grid[y][x] !== 0) return false;
    // Older campaign codes sometimes omitted the path marker at a portal.
    // An existing save can retain a tower bought there under the old rule.
    return restoreOccupiedEndpoint || !((x === this.entrance.x && y === this.entrance.y)
      || (x === this.exit.x && y === this.exit.y));
  }

  isPassable(x, y, start, goal) {
    if (!this.inBounds(x, y)) return false;
    if (x === start.x && y === start.y) return true;
    if (x === goal.x && y === goal.y) return true;
    return this.isPath(x, y);
  }

  buildDistanceToGoal(start, goal) {
    const q = [{ x: goal.x, y: goal.y }];
    const dist = new Map();
    const k0 = `${goal.x},${goal.y}`;
    dist.set(k0, 0);

    while (q.length) {
      const cur = q.shift();
      const curKey = `${cur.x},${cur.y}`;
      const d = dist.get(curKey) || 0;
      for (const dir of DIRS) {
        const nx = cur.x + dir.x;
        const ny = cur.y + dir.y;
        if (!this.isPassable(nx, ny, start, goal)) continue;
        const nk = `${nx},${ny}`;
        if (dist.has(nk)) continue;
        dist.set(nk, d + 1);
        q.push({ x: nx, y: ny });
      }
    }
    return dist;
  }

  buildPathBfs(start, goal) {
    const q = [{ x: start.x, y: start.y }];
    const prev = new Map();
    const key = (p) => `${p.x},${p.y}`;
    prev.set(key(start), null);

    while (q.length) {
      const cur = q.shift();
      if (cur.x === goal.x && cur.y === goal.y) break;
      for (const dir of DIRS) {
        const nx = cur.x + dir.x;
        const ny = cur.y + dir.y;
        if (!this.isPassable(nx, ny, start, goal)) continue;
        const nk = `${nx},${ny}`;
        if (prev.has(nk)) continue;
        prev.set(nk, cur);
        q.push({ x: nx, y: ny });
      }
    }

    const kGoal = key(goal);
    if (!prev.has(kGoal)) {
      const fallback = [];
      for (let x = start.x; x <= goal.x; x += 1) fallback.push({ x, y: start.y });
      return fallback.length ? fallback : [{ x: start.x, y: start.y }];
    }

    const path = [];
    let cur = goal;
    while (cur) {
      path.push({ x: cur.x, y: cur.y });
      cur = prev.get(key(cur));
    }
    path.reverse();
    return path;
  }

  buildPathDirectional(start, goal, dist) {
    const goalKey = `${goal.x},${goal.y}`;
    if (!dist.has(goalKey)) return null;

    const startKey = `${start.x},${start.y}`;
    if (!dist.has(startKey)) return null;

    const path = [{ x: start.x, y: start.y }];
    let current = { x: start.x, y: start.y };
    let currentDir = null;
    const stateVisit = new Map();
    let safety = Math.max(80, this.w * this.h * 22);

    while (safety-- > 0) {
      if (current.x === goal.x && current.y === goal.y) return path;

      const neighbors = [];
      for (let dirIndex = 0; dirIndex < DIRS.length; dirIndex += 1) {
        const d = DIRS[dirIndex];
        const nx = current.x + d.x;
        const ny = current.y + d.y;
        if (!this.isPassable(nx, ny, start, goal)) continue;
        const nk = `${nx},${ny}`;
        const goalDist = dist.has(nk) ? dist.get(nk) : Number.POSITIVE_INFINITY;
        neighbors.push({ dirIndex, x: nx, y: ny, nk, goalDist });
      }
      if (!neighbors.length) return null;

      let candidates = neighbors;
      if (currentDir !== null && neighbors.length > 1) {
        const backDir = (currentDir + 2) % 4;
        const noBack = neighbors.filter(n => n.dirIndex !== backDir);
        if (noBack.length) candidates = noBack;
      }

      let chosen = null;
      if (currentDir !== null) {
        chosen = candidates.find(n => n.dirIndex === currentDir) || null;
      }

      if (!chosen) {
        const priority = currentDir === null
          ? DIR_SCORE_ORDER
          : [currentDir, (currentDir + 1) % 4, (currentDir + 3) % 4, (currentDir + 2) % 4];
        const dirRank = new Map(priority.map((d, idx) => [d, idx]));
        candidates.sort((a, b) => {
          if (a.goalDist !== b.goalDist) return a.goalDist - b.goalDist;
          return (dirRank.get(a.dirIndex) || 99) - (dirRank.get(b.dirIndex) || 99);
        });
        chosen = candidates[0];
      }

      if (!chosen || !Number.isFinite(chosen.goalDist)) return null;

      const sk = `${chosen.x},${chosen.y},${chosen.dirIndex}`;
      const seen = (stateVisit.get(sk) || 0) + 1;
      stateVisit.set(sk, seen);
      if (seen > 3) return null;

      current = { x: chosen.x, y: chosen.y };
      currentDir = chosen.dirIndex;
      path.push({ x: current.x, y: current.y });
      if (path.length > this.w * this.h * 4) return null;
    }

    return null;
  }

  buildPath() {
    const start = this.entrance;
    const goal = this.exit;
    if (start.x === goal.x && start.y === goal.y) return [{ x: start.x, y: start.y }];

    const dist = this.buildDistanceToGoal(start, goal);
    const directional = this.buildPathDirectional(start, goal, dist);
    if (directional && directional.length >= 2) return directional;

    return this.buildPathBfs(start, goal);
  }
}

export { buildSMap, MAP_POOL, GameMap };
