// api/top-repos.js
// Läuft ohne node-fetch; nutzt das globale fetch von Node/Vercel.

const GITHUB_API = "https://api.github.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function gh(path, token) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `token ${token}`,
      "User-Agent": "lyzrex-stats",
      Accept: "application/vnd.github+json",
    },
  });
  return res;
}

/**
 * Holt ALLE Repos für den angegebenen Owner.
 * - Wenn der PAT zu genau diesem Owner gehört → /user/repos (sieht auch private Repos).
 * - Sonst Fallback auf /users/:owner/repos (nur öffentliche Repos).
 */
async function fetchAllRepos(owner, token) {
  // 0) Herausfinden, zu wem der Token gehört
  const meRes = await gh(`/user`, token);
  const meOk = meRes.status === 200;
  const me = meOk ? await meRes.json() : null;
  const isSelf = me && me.login && me.login.toLowerCase() === owner.toLowerCase();

  const repos = [];
  let page = 1;

  if (isSelf) {
    // 1) Authentifizierte Route: sieht private Repos
    // visibility=all + affiliation=owner (optional collaborator/org_member, wenn gewünscht)
    while (true) {
      const r = await gh(
        `/user/repos?per_page=100&visibility=all&affiliation=owner,collaborator,organization_member&page=${page}`,
        token
      );
      if (r.status !== 200) break;
      const list = await r.json();
      if (!list || list.length === 0) break;

      // Nur Repos des Owners (Kollabo-Repos optional rausfiltern)
      repos.push(
        ...list.filter(
          (x) => x.owner && x.owner.login.toLowerCase() === owner.toLowerCase()
        )
      );

      if (list.length < 100) break;
      page++;
    }
  } else {
    // 2) Fallback: nur öffentliche Repos eines fremden Owners
    while (true) {
      const r = await gh(
        `/users/${owner}/repos?per_page=100&sort=updated&page=${page}`,
        token
      );
      if (r.status !== 200) break;
      const list = await r.json();
      if (!list || list.length === 0) break;
      repos.push(...list);
      if (list.length < 100) break;
      page++;
    }
  }

  return repos;
}

async function commitActivity(owner, repo, token) {
  // Summiert die letzten 52 Wochen; GitHub kann 202 (in Berechnung) zurückgeben.
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await gh(`/repos/${owner}/${repo}/stats/commit_activity`, token);
    if (r.status === 200) {
      const data = await r.json();
      if (Array.isArray(data)) {
        return data.reduce((sum, w) => sum + (w.total || 0), 0);
      }
      return 0;
    }
    if (r.status === 202) {
      await sleep(600 + attempt * 300);
      continue;
    }
    // 404/403/401 → 0 zählen
    return 0;
  }
  return 0;
}

export default async function handler(req, res) {
  try {
    const owner = (req.query.username || req.query.user || "Lyzrex").toString();
    const token = process.env.PAT_1;

    if (!token) {
      res
        .status(500)
        .send("Missing PAT_1 environment variable on Vercel project.");
      return;
    }

    // === HIER: Repos laden (öffentlich + privat, wenn PAT zum Owner gehört) ===
    const repos = await fetchAllRepos(owner, token);

    // Forks raus, Kandidaten begrenzen (Performance)
    const candidate = repos
      .filter((r) => !r.fork)
      .sort((a, b) => (b.stargazers_count || 0) - (a.stargazers_count || 0))
      .slice(0, 30);

    const results = [];
    for (const repo of candidate) {
      const commits = await commitActivity(owner, repo.name, token);
      results.push({ name: repo.name, commits, url: repo.html_url });
    }

    results.sort((a, b) => b.commits - a.commits);
    const top = results.slice(0, 5);
    const lines = top.map(
      (r, i) => `${i + 1}. ${esc(r.name)} — ${r.commits} commits`
    );

    const h = 90 + lines.length * 24;
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="700" height="${h}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .title{font:700 16px 'Segoe UI', Roboto, sans-serif; fill:#9ccfff}
    .sub{font:400 12px 'Segoe UI', Roboto, sans-serif; fill:#7b8a99}
    .line{font:500 14px 'Segoe UI', Roboto, sans-serif; fill:#dbe9ff}
    rect{rx:10; fill:#0b1220}
  </style>
  <rect width="100%" height="100%" />
  <text x="20" y="32" class="title">Top active repositories (last 52 weeks)</text>
  <text x="20" y="52" class="sub">Sorted by total commits in the last year</text>
  ${lines.map((l, idx) => `<text x="20" y="${80 + idx * 24}" class="line">${l}</text>`).join("\n  ")}
</svg>`;

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).send(svg);
  } catch (err) {
    console.error("top-repos error:", err);
    res.status(500).send("Internal error (check Vercel Runtime Logs).");
  }
}
