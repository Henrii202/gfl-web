// Shared helpers for the Vercel functions. No long-running process: Mongo is reused between calls,
// sessions are signed cookies, and Discord is reached over its REST API.
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const E = process.env;

let client;
const db = async () => { client ||= new MongoClient(E.MONGO_URI).connect(); return (await client).db(E.MONGO_DB || undefined); };

const mac = b => crypto.createHmac('sha256', E.SESSION_SECRET).update(b).digest('base64url');
const sign = v => { const b = Buffer.from(JSON.stringify(v)).toString('base64url'); return b + '.' + mac(b); };
const verify = t => {
  const [b, s] = (t || '').split('.'); if (!b || !s) return null;
  const x = mac(b); if (x.length !== s.length || !crypto.timingSafeEqual(Buffer.from(x), Buffer.from(s))) return null;
  const v = JSON.parse(Buffer.from(b, 'base64url').toString()); return v.exp > Date.now() ? v : null;
};
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean)
  .map(c => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const setCookie = (res, name, val, maxAge) => res.setHeader('Set-Cookie', [].concat(res.getHeader('Set-Cookie') || [],
  `${name}=${encodeURIComponent(val)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`));
const session = req => verify(cookies(req).bfl);

const isAdmin = async rid => {
  if (!rid) return false;
  const p = await (await db()).collection('players').findOne({ robloxId: rid });
  return !!p && (p.isAdmin === true || (E.ADMIN_DISCORD_IDS || '').split(',').includes(p.discordId));
};

const getClub = async p => {
  const d = await db(), c = p.clubId && await d.collection('clubs').findOne({ _id: p.clubId });
  if (!c) return null;
  const squad = await d.collection('players').find({ clubId: c._id }).toArray();
  return { name: c.name, division: c.division, pts: c.points, pos: c.position, value: c.value,
    role: c.ownerIds?.includes(p.robloxId) ? 'Owner' : c.managerIds?.includes(p.robloxId) ? 'Manager' : 'Player',
    squad: squad.map(s => ({ n: s.robloxName, p: s.position, g: s.goals, a: s.assists })) };
};

const discord = path => fetch('https://discord.com/api/v10' + path, { headers: { Authorization: 'Bot ' + E.DISCORD_TOKEN } }).then(r => r.json());

// Reads club roles ("Club | Name") and their members straight from Discord, no gateway bot needed.
async function importClubs() {
  const d = await db(), prefix = E.CLUB_ROLE_PREFIX || 'Club | ';
  const roles = (await discord(`/guilds/${E.GUILD_ID}/roles`)).filter(r => r.name.startsWith(prefix));
  let members = [], after = '0';
  for (;;) {
    const page = await discord(`/guilds/${E.GUILD_ID}/members?limit=1000&after=${after}`);
    members = members.concat(page); if (page.length < 1000) break; after = page[page.length - 1].user.id;
  }
  let clubs = 0, linked = 0;
  for (const role of roles) {
    await d.collection('clubs').updateOne({ discordRoleId: role.id },
      { $set: { name: role.name.slice(prefix.length).trim(), discordRoleId: role.id }, $setOnInsert: { division: '', points: 0, value: 0 } }, { upsert: true });
    const club = await d.collection('clubs').findOne({ discordRoleId: role.id }), ownerIds = [], managerIds = [];
    for (const m of members.filter(m => m.roles.includes(role.id))) {
      const p = await d.collection('players').findOne({ discordId: m.user.id }); if (!p) continue;
      await d.collection('players').updateOne({ _id: p._id }, { $set: { clubId: club._id } });
      if (E.OWNER_ROLE_ID && m.roles.includes(E.OWNER_ROLE_ID)) ownerIds.push(p.robloxId);
      if (E.MANAGER_ROLE_ID && m.roles.includes(E.MANAGER_ROLE_ID)) managerIds.push(p.robloxId);
      linked++;
    }
    await d.collection('clubs').updateOne({ _id: club._id }, { $set: { ownerIds, managerIds } });
    clubs++;
  }
  return { clubs, linked };
}

module.exports = { E, db, sign, session, cookies, setCookie, isAdmin, getClub, importClubs };
