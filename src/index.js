// Quoridor distributed-testing coordinator (Cloudflare Worker).
//
// Endpoints:
//   POST /webhook        — GitHub push webhook (HMAC-verified). Debounces, queues SPRT batch 0.
//   GET  /api/job        — worker claims a job (compare-and-swap via KV read-back).
//   POST /api/result     — worker submits batch result; SPRT update; queue next batch or finish.
//   GET  /api/status     — dashboard JSON: mode, queue, tests, spend.
//   POST /api/mode       — owner: {"mode":"FRUGAL"|"BALANCE"|"SPEED"} (Bearer OWNER_TOKEN).
//   POST /api/spend-cap  — owner: {"eur": 15} (absolute code ceiling 50).
//
// KV layout:
//   config                  {mode, speedCapEur}
//   spend:<YYYY-MM>         {eur}
//   queue                   [jobId, ...]  (small array; fine for hobby scale)
//   job:<id>                {commit, batch, games, claimedBy, claimedAt, status}
//   test:<sha>              {branch, w, l, d, batches, verdict, createdAt}
//   result:<sha>            published verdict JSON (website reads this)

import { sprtVerdict, eloEstimate, SPRT_DEFAULTS } from "./sprt.js";

const BATCH_GAMES = 32;
const MAX_GAMES = { FRUGAL: 1024, BALANCE: 2048, SPEED: 2048 };
const INITIAL_BATCHES = { FRUGAL: 2, BALANCE: 2, SPEED: 4 }; // ×32 games
const CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
const ABSOLUTE_CAP_EUR = 50;

// ---------- helpers ----------

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

async function hmacValid(secret, body, sigHeader) {
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = "sha256=" + hex;
  // constant-time-ish compare
  if (expected.length !== sigHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sigHeader.charCodeAt(i);
  return diff === 0;
}

async function getConfig(env) {
  const c = await env.QKV.get("config", "json");
  return { mode: "FRUGAL", speedCapEur: 15, ...c };
}

function monthKey() {
  return "spend:" + new Date().toISOString().slice(0, 7);
}

async function getQueue(env) {
  return (await env.QKV.get("queue", "json")) || [];
}
async function putQueue(env, q) {
  await env.QKV.put("queue", JSON.stringify(q));
}

function newJobId(sha, batch) {
  return `${sha.slice(0, 12)}-b${batch}`;
}

// ---------- webhook ----------

async function handleWebhook(req, env) {
  const body = await req.text();
  const ok = await hmacValid(env.WEBHOOK_SECRET, body, req.headers.get("x-hub-signature-256"));
  if (!ok) return json({ error: "bad signature" }, 401);

  const ev = req.headers.get("x-github-event");
  if (ev !== "push") return json({ ok: true, ignored: ev });

  const payload = JSON.parse(body);
  const sha = payload.after;
  const branch = (payload.ref || "").replace("refs/heads/", "");
  if (!sha || sha === "0000000000000000000000000000000000000000")
    return json({ ok: true, ignored: "delete" });

  // Debounce: cancel PENDING jobs of older commits on the same branch.
  const queue = await getQueue(env);
  const kept = [];
  for (const id of queue) {
    const job = await env.QKV.get("job:" + id, "json");
    if (job && job.branch === branch && job.commit !== sha && !job.claimedBy) {
      job.status = "cancelled";
      await env.QKV.put("job:" + id, JSON.stringify(job));
    } else {
      kept.push(id);
    }
  }

  // Create test record + initial batches.
  const cfg = await getConfig(env);
  const test = {
    branch,
    commit: sha,
    w: 0,
    l: 0,
    d: 0,
    batches: 0,
    gamesQueued: 0,
    verdict: "running",
    createdAt: Date.now(),
  };
  const nInit = INITIAL_BATCHES[cfg.mode] || 2;
  for (let b = 0; b < nInit; b++) {
    const id = newJobId(sha, b);
    await env.QKV.put(
      "job:" + id,
      JSON.stringify({
        id,
        commit: sha,
        branch,
        batch: b,
        games: BATCH_GAMES,
        repo: env.ENGINE_REPO,
        status: "pending",
        claimedBy: null,
        claimedAt: 0,
      })
    );
    kept.push(id);
    test.gamesQueued += BATCH_GAMES;
    test.batches++;
  }
  await env.QKV.put("test:" + sha, JSON.stringify(test));
  await putQueue(env, kept);
  return json({ ok: true, queued: nInit, commit: sha });
}

// ---------- job claim ----------

async function handleClaim(req, env) {
  const url = new URL(req.url);
  const workerId = url.searchParams.get("worker") || "anon";
  const queue = await getQueue(env);

  for (const id of queue) {
    const key = "job:" + id;
    const job = await env.QKV.get(key, "json");
    if (!job || job.status !== "pending") continue;
    const stale = job.claimedBy && Date.now() - job.claimedAt > CLAIM_TIMEOUT_MS;
    if (job.claimedBy && !stale) continue;

    job.claimedBy = workerId;
    job.claimedAt = Date.now();
    await env.QKV.put(key, JSON.stringify(job));
    // CAS read-back (KV is eventually consistent; worst case = duplicate batch,
    // which doubles as a free verification run).
    await new Promise((r) => setTimeout(r, 300));
    const check = await env.QKV.get(key, "json");
    if (check && check.claimedBy === workerId) {
      return json({
        job_id: job.id,
        commit_sha: job.commit,
        repo: job.repo,
        prebuilt_url: (await env.QKV.get("prebuilt:" + job.commit)) || null,
        game_count: job.games,
        movetime_ms: 1000,
        base_commit: (await env.QKV.get("base-commit")) || "main",
      });
    }
  }
  return json({ job_id: null }, 204);
}

// ---------- result submission ----------

async function handleResult(req, env) {
  const body = await req.json();
  const { job_id, wins, losses, draws, worker } = body;
  const key = "job:" + job_id;
  const job = await env.QKV.get(key, "json");
  if (!job) return json({ error: "unknown job" }, 404);
  if (job.status === "done") return json({ ok: true, dup: true });

  job.status = "done";
  job.result = { wins, losses, draws, worker };
  await env.QKV.put(key, JSON.stringify(job));

  // Remove from queue.
  const queue = await getQueue(env);
  await putQueue(env, queue.filter((x) => x !== job_id));

  // SPRT update.
  const tKey = "test:" + job.commit;
  const test = await env.QKV.get(tKey, "json");
  if (!test) return json({ ok: true, orphan: true });
  test.w += wins;
  test.l += losses;
  test.d += draws;

  const cfg = await getConfig(env);
  const total = test.w + test.l + test.d;
  const verdict = sprtVerdict(test.w, test.l, test.d, SPRT_DEFAULTS);

  if (verdict !== "continue" || total >= (MAX_GAMES[cfg.mode] || 2048)) {
    test.verdict = verdict === "continue" ? "inconclusive" : verdict;
    const { elo, err } = eloEstimate(test.w, test.l, test.d);
    await env.QKV.put(
      "result:" + job.commit,
      JSON.stringify({
        commit: job.commit,
        branch: test.branch,
        verdict: test.verdict,
        games: total,
        w: test.w,
        l: test.l,
        d: test.d,
        elo: Math.round(elo * 10) / 10,
        err: Math.round(err * 10) / 10,
        finishedAt: Date.now(),
      })
    );
  } else {
    // queue next adaptive batch
    const b = test.batches;
    const id = newJobId(job.commit, b);
    await env.QKV.put(
      "job:" + id,
      JSON.stringify({
        id,
        commit: job.commit,
        branch: test.branch,
        batch: b,
        games: BATCH_GAMES,
        repo: env.ENGINE_REPO,
        status: "pending",
        claimedBy: null,
        claimedAt: 0,
      })
    );
    const q = await getQueue(env);
    q.push(id);
    await putQueue(env, q);
    test.batches++;
    test.gamesQueued += BATCH_GAMES;
  }
  await env.QKV.put(tKey, JSON.stringify(test));
  return json({ ok: true, verdict: test.verdict, totals: { w: test.w, l: test.l, d: test.d } });
}

// ---------- status / owner ----------

async function handleStatus(env) {
  const cfg = await getConfig(env);
  const queue = await getQueue(env);
  const spend = (await env.QKV.get(monthKey(), "json")) || { eur: 0 };
  return json({ mode: cfg.mode, speedCapEur: cfg.speedCapEur, queueDepth: queue.length, spend });
}

function ownerAuthed(req, env) {
  const h = req.headers.get("authorization") || "";
  return h === "Bearer " + env.OWNER_TOKEN;
}

async function handleMode(req, env) {
  if (!ownerAuthed(req, env)) return json({ error: "unauthorized" }, 401);
  const { mode } = await req.json();
  if (!["FRUGAL", "BALANCE", "SPEED"].includes(mode)) return json({ error: "bad mode" }, 400);
  const cfg = await getConfig(env);
  cfg.mode = mode;
  await env.QKV.put("config", JSON.stringify(cfg));
  return json({ ok: true, mode });
}

async function handleSpendCap(req, env) {
  if (!ownerAuthed(req, env)) return json({ error: "unauthorized" }, 401);
  const { eur } = await req.json();
  const capped = Math.min(Number(eur) || 0, ABSOLUTE_CAP_EUR);
  const cfg = await getConfig(env);
  cfg.speedCapEur = capped;
  await env.QKV.put("config", JSON.stringify(cfg));
  return json({ ok: true, speedCapEur: capped });
}

// NOTE: Hetzner escape-valve (BALANCE/SPEED) is intentionally not wired yet —
// it belongs to Phase 5 along with the reaper cron. The mode plumbing above
// (config, spend counter, caps) is the interface it will use.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (req.method === "POST" && p === "/webhook") return await handleWebhook(req, env);
      if (req.method === "GET" && p === "/api/job") return await handleClaim(req, env);
      if (req.method === "POST" && p === "/api/result") return await handleResult(req, env);
      if (req.method === "GET" && p === "/api/status") return await handleStatus(env);
      if (req.method === "POST" && p === "/api/mode") return await handleMode(req, env);
      if (req.method === "POST" && p === "/api/spend-cap") return await handleSpendCap(req, env);
      if (req.method === "GET" && p.startsWith("/api/result/")) {
        const sha = p.split("/").pop();
        const r = await env.QKV.get("result:" + sha);
        return r ? new Response(r, { headers: { "content-type": "application/json" } }) : json({ error: "not found" }, 404);
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};
