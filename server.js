// npm i express express-session mongodb discord.js   (Node 18+)
// .env: MONGO_URI, DISCORD_TOKEN, ROBLOX_ID, ROBLOX_SECRET, BASE_URL, SESSION_SECRET
const express = require('express'), session = require('express-session');
const { MongoClient, ObjectId } = require('mongodb');
const { Client, GatewayIntentBits } = require('discord.js');
const E = process.env, app = express();
app.use(session({ secret: E.SESSION_SECRET, resave: false, saveUninitialized: false }));
app.use(express.json());
app.use(express.static('public')); // put bfl-hub.html here as index.html

let db;
// Collections: players {robloxId, robloxName, discordId, clubId, matches, goals, assists, coins}
//              clubs {name, division, points, value, logo(data URL), ownerIds[], managerIds[]}
//              games {date, time, home, away, hs, as, div, cup, round}  cups {id, name, sub, stage, left, note, roundNames}
const getClub = async p => {
  const c = p.clubId && await db.collection('clubs').findOne({ _id: p.clubId });
  if (!c) return null;
  const squad = await db.collection('players').find({ clubId: c._id }).toArray();
  return { name: c.name, division: c.division, pts: c.points, pos: c.position, value: c.value,
    role: c.ownerIds?.includes(p.robloxId) ? 'Owner' : c.managerIds?.includes(p.robloxId) ? 'Manager' : 'Player',
    squad: squad.map(s => ({ n: s.robloxName, p: s.position, g: s.goals, a: s.assists })) };
};

app.get('/api/hub', async (_, res) => res.json({
  clubs: await db.collection('clubs').find({}, { projection: { ownerIds: 0, managerIds: 0, discordRoleId: 0 } }).toArray(),
  games: await db.collection('games').find({}).toArray(),
  cups: await db.collection('cups').find({}).toArray(),
  texts: (await db.collection('settings').findOne({ _id: 'texts' }))?.pairs || [] }));

app.get('/api/me', async (req, res) => {
  if (!req.session.robloxId) return res.sendStatus(401);
  const p = await db.collection('players').findOne({ robloxId: req.session.robloxId });
  if (!p) return res.sendStatus(404);
  res.json({ robloxName: p.robloxName, isAdmin: await isAdmin(req), club: await getClub(p),
    career: { matches: p.matches, goals: p.goals, assists: p.assists, coins: p.coins } });
});

// Sign in with Roblox (OAuth2 code flow)
app.get('/auth/roblox', (_, res) => res.redirect('https://apis.roblox.com/oauth/v1/authorize?' + new URLSearchParams({
  client_id: E.ROBLOX_ID, redirect_uri: E.BASE_URL + '/auth/callback', scope: 'openid profile', response_type: 'code' })));
app.get('/auth/callback', async (req, res) => {
  const t = await (await fetch('https://apis.roblox.com/oauth/v1/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code,
      client_id: E.ROBLOX_ID, client_secret: E.ROBLOX_SECRET }) })).json();
  const u = await (await fetch('https://apis.roblox.com/oauth/v1/userinfo', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
  req.session.robloxId = Number(u.sub); res.redirect('/#club');
});
app.get('/auth/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// ---- Admin: import clubs from Discord roles, then edit them on the site ----
// Discord: one role per club named "Club | <name>" (prefix via CLUB_ROLE_PREFIX).
// Optional OWNER_ROLE_ID / MANAGER_ROLE_ID mark who owns or manages a club. Needs the Server Members intent.
// Admins: players with isAdmin:true in Mongo, or a Discord ID listed in ADMIN_DISCORD_IDS (comma separated).
const isAdmin = async req => {
  if (!req.session.robloxId) return false;
  const p = await db.collection('players').findOne({ robloxId: req.session.robloxId });
  return !!p && (p.isAdmin === true || (E.ADMIN_DISCORD_IDS || '').split(',').includes(p.discordId));
};
const admin = async (req, res, next) => (await isAdmin(req)) ? next() : res.sendStatus(403);

async function importClubs() {
  const guild = await bot.guilds.fetch(E.GUILD_ID);
  await guild.members.fetch();
  const prefix = E.CLUB_ROLE_PREFIX || 'Club | ';
  let clubs = 0, linked = 0;
  for (const role of guild.roles.cache.filter(r => r.name.startsWith(prefix)).values()) {
    await db.collection('clubs').updateOne({ discordRoleId: role.id },
      { $set: { name: role.name.slice(prefix.length).trim(), discordRoleId: role.id },
        $setOnInsert: { division: '', points: 0, value: 0 } }, { upsert: true });
    const club = await db.collection('clubs').findOne({ discordRoleId: role.id });
    const ownerIds = [], managerIds = [];
    for (const m of role.members.values()) {
      const p = await db.collection('players').findOne({ discordId: m.id });
      if (!p) continue;
      await db.collection('players').updateOne({ _id: p._id }, { $set: { clubId: club._id } });
      if (E.OWNER_ROLE_ID && m.roles.cache.has(E.OWNER_ROLE_ID)) ownerIds.push(p.robloxId);
      if (E.MANAGER_ROLE_ID && m.roles.cache.has(E.MANAGER_ROLE_ID)) managerIds.push(p.robloxId);
      linked++;
    }
    await db.collection('clubs').updateOne({ _id: club._id }, { $set: { ownerIds, managerIds } });
    clubs++;
  }
  return { clubs, linked };
}

// Generic editing for the admin page: clubs (with logo), games, cups
const COLS = ['clubs', 'games', 'cups'];
const okCol = (req, res, next) => COLS.includes(req.params.col) ? next() : res.sendStatus(404);
const body = req => { const d = { ...req.body }; delete d._id; return d; };
app.post('/api/admin/:col', admin, okCol, async (req, res) => {
  const d = body(req); const r = await db.collection(req.params.col).insertOne(d); res.json({ ...d, _id: r.insertedId });
});
app.patch('/api/admin/:col/:id', admin, okCol, async (req, res) => {
  await db.collection(req.params.col).updateOne({ _id: new ObjectId(req.params.id) }, { $set: body(req) }); res.sendStatus(204);
});
app.delete('/api/admin/:col/:id', admin, okCol, async (req, res) => {
  await db.collection(req.params.col).deleteOne({ _id: new ObjectId(req.params.id) }); res.sendStatus(204);
});
// Website texts: list of [original, replacement] pairs
app.put('/api/admin/texts', admin, async (req, res) => {
  await db.collection('settings').updateOne({ _id: 'texts' }, { $set: { pairs: req.body.pairs || [] } }, { upsert: true }); res.sendStatus(204);
});
app.post('/api/admin/import', admin, async (_, res) => res.json(await importClubs()));

// Discord bot: reads the same MongoDB
const bot = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
bot.on('interactionCreate', async i => {
  if (!i.isChatInputCommand()) return;
  if (i.commandName === 'player') {
    const name = i.options.getString('name');
    const p = await db.collection('players').findOne({ robloxName: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
    return i.reply(p ? `**${p.robloxName}** · ${p.matches} matches · ${p.goals} goals · ${p.assists} assists` : 'Player not found.');
  }
  if (i.commandName === 'sync') {
    if (!i.memberPermissions.has('Administrator')) return i.reply({ content: 'Admins only.', ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const r = await importClubs();
    return i.editReply(`Imported ${r.clubs} clubs, linked ${r.linked} players.`);
  }
  if (i.commandName === 'club') {
    const p = await db.collection('players').findOne({ discordId: i.user.id });
    const c = p && await getClub(p);
    i.reply(c ? `**${c.name}** · ${c.division} · ${c.pts} pts` : 'No club linked to your Discord account.');
  }
});

MongoClient.connect(E.MONGO_URI).then(async m => {
  db = m.db(); await bot.login(E.DISCORD_TOKEN);
  await bot.application.commands.set([
    { name: 'player', description: 'Look up a player', options: [{ name: 'name', description: 'Roblox name', type: 3, required: true }] },
    { name: 'club', description: 'Show your club' },
    { name: 'sync', description: 'Admin: import clubs from Discord roles' }]);
  app.listen(3000, () => console.log('BFL Hub on :3000'));
});
