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

      // Nur Repos
