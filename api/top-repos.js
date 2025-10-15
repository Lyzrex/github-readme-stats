// api/top-repos.js
import fetch from "node-fetch";

const GITHUB_API = "https://api.github.com";
function svgEscape(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

async function ghFetch(path, token) {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: { Authorization: `token ${token}`, "User-Agent": "lyzrex-stats" }
  });
  return res;
}

async function getCommitActivity(owner, repo, token){
  const maxAttempts = 8;
  let attempt = 0;
  while(attempt++ < maxAttempts){
    const res = await ghFetch(`/repos/${owner}/${repo}/stats/commit_activity`, token);
    if(res.status === 200){
      const data = await res.json();
      return Array.isArray(data) ? data.reduce((s,w)=>s + (w.total||0),0) : 0;
    }
    if(res.status === 202){
      await new Promise(r => setTimeout(r, 800 + attempt*300));
      continue;
    }
    return 0;
  }
  return 0;
}

export default async function handler(req, res){
  try{
    const owner = (req.query.username || req.query.user || "Lyzrex").toString();
    const PAT = process.env.PAT_1;
    if(!PAT){ res.status(500).send("Missing PAT_1 env"); return; }

    let page = 1;
    const allRepos = [];
    while(true){
      const r = await ghFetch(`/users/${owner}/repos?per_page=100&page=${page}`, PAT);
      if(r.status !== 200) break;
      const list = await r.json();
      if(!list || list.length === 0) break;
      allRepos.push(...list);
      if(list.length < 100) break;
      page++;
    }

    if(allRepos.length === 0){
      const r2 = await ghFetch(`/user/repos?per_page=100&page=1`, PAT);
      if(r2.status === 200){
        const list = await r2.json();
        allRepos.push(...list.filter(r => r.owner && r.owner.login.toLowerCase()===owner.toLowerCase()));
      }
    }

    const candidate = allRepos
      .filter(r => !r.fork)
      .sort((a,b)=> (b.stargazers_count||0) - (a.stargazers_count||0))
      .slice(0, 30);

    const results = [];
    for(const repo of candidate){
      const commits = await getCommitActivity(owner, repo.name, PAT);
      results.push({ name: repo.name, commits, url: repo.html_url });
    }
    results.sort((a,b)=> b.commits - a.commits);

    const top = results.slice(0, 5);
    const lines = top.map((r,i)=> `${i+1}. ${svgEscape(r.name)} — ${r.commits} commits`);

    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="700" height="${90 + lines.length*24}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .title{font:700 16px 'Segoe UI', Roboto, sans-serif; fill:#9ccfff}
    .sub{font:400 12px 'Segoe UI', Roboto, sans-serif; fill:#7b8a99}
    .line{font:500 14px 'Segoe UI', Roboto, sans-serif; fill:#dbe9ff}
    rect{rx:10; fill:#0b1220}
  </style>
  <rect width="100%" height="100%" />
  <text x="20" y="32" class="title">Top active repositories (last 52 weeks)</text>
  <text x="20" y="52" class="sub">Sorted by total commits in the last year</text>
  ${lines.map((l,idx)=> `<text x="20" y="${80 + idx*24}" class="line">${l}</text>`).join("\n  ")}
</svg>`;

    res.setHeader("Content-Type","image/svg+xml");
    res.setHeader("Cache-Control","s-maxage=1800, stale-while-revalidate=3600");
    res.status(200).send(svg);
  }catch(err){
    console.error(err);
    res.status(500).send("error");
  }
}
