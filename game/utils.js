const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const dist2 = (ax,ay,bx,by) => { const dx=ax-bx, dy=ay-by; return dx*dx + dy*dy; };
  let randomState = 0x9e3779b9;
  const setRandomSeed = (seed) => { const n = Number(seed) >>> 0; randomState = n || 0x9e3779b9; return randomState; };
  const getRandomState = () => randomState >>> 0;
  const setRandomState = setRandomSeed;
  const random = () => { let x = randomState >>> 0; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; randomState = x >>> 0; return randomState / 4294967296; };
  const randInt = (a,b) => (a + Math.floor(random()*(b-a+1)));
  const now = () => performance.now() / 1000;
  const formatCompact = (value, fracDigits=1) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "0";
    const abs = Math.abs(n);
    const units = [
      { v: 1e12, s: "T" },
      { v: 1e9,  s: "B" },
      { v: 1e6,  s: "M" },
      { v: 1e3,  s: "K" }
    ];
    for (const u of units) {
      if (abs < u.v) continue;
      const scaled = n / u.v;
      const digits = (Math.abs(scaled) >= 100) ? 0 : Math.max(0, fracDigits);
      const txt = scaled
        .toFixed(digits)
        .replace(/\.0+$/, "")
        .replace(/(\.\d*[1-9])0+$/, "$1");
      return `${txt}${u.s}`;
    }
    return `${Math.round(n)}`;
  };
  const pickN = (arr, n) => {
    const a=[...arr];
    for(let i=a.length-1;i>0;i--){
      const j=Math.floor(random()*(i+1));
      [a[i],a[j]]=[a[j],a[i]];
    }
    return a.slice(0,n);
  };

  // =========================================================
  // Damage model (armor negatif olabilir)
  // =========================================================
  
export { clamp, dist2, randInt, random, setRandomSeed, getRandomState, setRandomState, now, formatCompact, pickN };
