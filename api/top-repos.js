// api/top-repos.js — schnelle, robuste Version
const GITHUB_API = "https://api.github.com";

// kleine Helfer
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

// fetch mit Timeout
async function gh(path, token, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
      headers: {
        Authorization: `token ${token}`,
        "User-Agent": "lyzrex-stats",
        Accept: "application/vnd.github+json",
      },
      signal: ctrl.signal,
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// holt private + public Repos (wenn PAT = Owner)
async function fetchAllRepos(owner, token, pageLimit = 2) {
  // /user: Wer ist der Token-Owner?
  const meRes = await gh(`/user`, token);
  const me = meRes.status === 200 ? await meRes.json() : null;
  const isSelf = me && me.login?.toLowerCase() === owner.toLowerCase();

  const repos = [];
  let page = 1;

  if (isSelf) {
    // sieht auch private
    while (page <= pageLimit) {
      const r = await gh(`/user/repos?per_page=100&visibility=all&affiliation=owner&sort=updated&page=${page}`, token);
      if (r.status !== 200) break;
      const list = await r.json();
      if (!Array.isArray(list) || list.length === 0) break;
      repos.push(...list.filter(x => x.owner?.login?.toLowerCase() === owner.toLowerCase()));
      if (list.length < 100) break;
      page++;
    }
  } else {
    // nur public
    while (page <= pageLimit) {
      const r = await gh(`/users/${owner}/repos?per_page=100&sort=updated&page=${page}`, token);
      if (r.status !== 200) break;
      const list = await r.json();
      if (!Array.isArray(list) || list.length === 0) break;
      repos.push(...list);
      if (list.length < 100) break;
      page++;
    }
  }

  return repos;
}

// summiert Commits der letzten 52 Wochen
async function commitActivity(owner, repo, token) {
  const maxRetries = 2;
  for (let i = 0; i <= maxRetries; i++) {
    const r = await gh(`/repos/${owner}/${repo}/stats/commit_activity`, token);
    if (r.status === 200) {
      const data = await r.json();
      return Array.isArray(data) ? data.reduce((s,w)=> s + (w.total || 0), 0) : 0;
    }
    if (r.status === 202) {
      // GitHub berechnet noch
      await sleep(500 + i * 400);
      continue;
    }
    // 401/403/404 etc.
    return 0;
  }
  return 0;
}

// einfache Concurrency-Steuerung
async function mapLimit(items, limit, iter) {
  const ret = [];
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await iter(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return ret;
}

export default async function handler(req, res) {
  try {
    const owner = (req.query.username || req.query.user || "Lyzrex").toString();
    const token = process.env.PAT_1;
    if (!token) {
      res.status(500).send("Missing PAT_1 environment variable.");
      return;
    }

    // Parameter
    const limitToCheck = Math.max(3, Math.min(40, parseInt(req.query.limit || "12", 10)));
    const showCount     = Math.max(1, Math.min(20, parseInt(req.query.show  || "5", 10)));

    // Repos holen & auf die zuletzt aktualisierten begrenzen
    const all = await fetchAllRepos(owner, token, 2);
    const candidates = all
      .filter(r => !r.fork)
      .sort((a,b) => new Date(b.pushed_at) - new Date(a.pushed_at))
      .slice(0, limitToCheck);

    // Commits parallel (max 4 gleichzeitige Requests)
    const results = await mapLimit(candidates, 4, async (repo) => {
      const commits = await commitActivity(owner, repo.name, token);
      return { name: repo.name, commits, url: repo.html_url };
    });

    results.sort((a,b) => b.commits - a.commits);
    const top = results.slice(0, showCount);

    const lines = top.map((r,i) => `${i+1}. ${esc(r.name)} — ${r.commits} commits`);
    const h = 90 + Math.max(lines.length,1) * 24;

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
  ${lines.length ? lines.map((l, idx) => `<text x="20" y="${80 + idx*24}" class="line">${l}</text>`).join("\n  ")
                  : `<text x="20" y="80" class="line">No data</text>`}
</svg>`;

    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).send(svg);
  } catch (err) {
    console.error("top-repos error:", err);
    res.status(500).send("Internal error. Check Vercel Runtime Logs.");
  }
}
