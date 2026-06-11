// SPRT (Sequential Probability Ratio Test) — trinomial GSPRT approximation.
// H0: elo <= elo0   H1: elo >= elo1
// Standard Fishtest-style bounds: elo0=0, elo1=5, alpha=beta=0.05.

export const SPRT_DEFAULTS = {
  elo0: 0,
  elo1: 5,
  alpha: 0.05,
  beta: 0.05,
};

function eloToScore(elo) {
  return 1 / (1 + Math.pow(10, -elo / 400));
}

// Log-likelihood ratio for (wins, losses, draws) under elo1 vs elo0.
export function llr(wins, losses, draws, elo0, elo1) {
  const n = wins + losses + draws;
  if (n === 0) return 0;
  const w = wins / n,
    l = losses / n,
    d = draws / n;
  const score = w + d / 2;
  const variance = w * (1 - score) ** 2 + l * (0 - score) ** 2 + d * (0.5 - score) ** 2;
  if (variance <= 0) return 0;
  const s0 = eloToScore(elo0),
    s1 = eloToScore(elo1);
  return ((n * (s1 - s0)) / variance) * (score - (s0 + s1) / 2);
}

// Returns "accept" (H1: new engine better), "reject" (H0), or "continue".
export function sprtVerdict(wins, losses, draws, opts = SPRT_DEFAULTS) {
  const { elo0, elo1, alpha, beta } = { ...SPRT_DEFAULTS, ...opts };
  const la = Math.log(beta / (1 - alpha)); // lower bound
  const lb = Math.log((1 - beta) / alpha); // upper bound
  const v = llr(wins, losses, draws, elo0, elo1);
  if (v >= lb) return "accept";
  if (v <= la) return "reject";
  return "continue";
}

// Rough elo estimate + error bars for the dashboard.
export function eloEstimate(wins, losses, draws) {
  const n = wins + losses + draws;
  if (n === 0) return { elo: 0, err: Infinity };
  const score = (wins + draws / 2) / n;
  const clamped = Math.min(Math.max(score, 1e-6), 1 - 1e-6);
  const elo = -400 * Math.log10(1 / clamped - 1);
  const w = wins / n,
    l = losses / n,
    d = draws / n;
  const variance = w * (1 - clamped) ** 2 + l * clamped ** 2 + d * (0.5 - clamped) ** 2;
  const se = Math.sqrt(variance / n);
  const errLo = -400 * Math.log10(1 / Math.max(clamped - 1.96 * se, 1e-6) - 1);
  return { elo, err: Math.abs(elo - errLo) };
}
