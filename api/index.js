// One Express app that Vercel runs as a function for /api/* and /auth/* (see vercel.json).
const express = require('express');
const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const { E, db, sign, session, cookies, setCookie, isAdmin, getClub, importClubs, importTeams } = require('../lib/shared');

const app = express();
app.use(express.json({ limit: '1mb' })); // logos are small data URLs
const h = f => (q, s, n) => Promise.resolve(f(q, s, n)).catch(e => { console.error(e); s.status(500).json({ error: 'server error' }); });
const admin = h(async (req, res, next) => (await isAdmin(session(req)?.rid)) ? next() : res.sendStatus(403));
const COLS = ['clubs', 'games', 'cups'];
const okCol = (req, res, next) => COLS.includes(req.params.col) ? next() : res.sendStatus(404);
const body = req => { const d = { ...req.body }; delete d._id; return d; };

// Public data
app.get('/api/hub', h(async (_, res) => {
  const d = await db();
  res.setHeader('Cache-Control', 'public, s-maxage=5, stale-while-revalidate=30');
  res.json({
    clubs: await d.collection('clubs').find({}, { projection: { ownerIds: 0, managerIds: 0, discordRoleId: 0 } }).toArray(),
    games: await d.collection('games').find({}).toArray(),
    cups: await d.collection('cups').find({}).toArray(),
    texts: (await d.collection('settings').findOne({ _id: 'texts' }))?.pairs || [] });
}));

// The signed-in player
app.get('/api/me', h(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const rid = session(req)?.rid; if (!rid) return res.sendStatus(401);
  const p = await (await db()).collection('players').findOne({ robloxId: rid }); if (!p) return res.sendStatus(404);
  res.json({ robloxName: p.robloxName, isAdmin: await isAdmin(rid), club: await getClub(p),
    career: { matches: p.matches, goals: p.goals, assists: p.assists, coins: p.coins } });
}));

// Sign in with Roblox
app.get('/auth/roblox', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex'); setCookie(res, 'bfl_state', state, 600);
  res.redirect('https://apis.roblox.com/oauth/v1/authorize?' + new URLSearchParams({ client_id: E.ROBLOX_ID,
    redirect_uri: E.BASE_URL + '/auth/callback', scope: 'openid profile', response_type: 'code', state }));
});
app.get('/auth/callback', h(async (req, res) => {
  if (!req.query.state || req.query.state !== cookies(req).bfl_state) return res.status(400).send('Sign-in expired. Try again.');
  const t = await (await fetch('https://apis.roblox.com/oauth/v1/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, client_id: E.ROBLOX_ID, client_secret: E.ROBLOX_SECRET }) })).json();
  if (!t.access_token) return res.status(400).send('Roblox sign-in failed.');
  const u = await (await fetch('https://apis.roblox.com/oauth/v1/userinfo', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
  const rid = Number(u.sub), name = u.preferred_username || u.name || String(rid);
  // First sign-in creates the player record, so My career and My club open right away
  await (await db()).collection('players').updateOne({ robloxId: rid },
    { $set: { robloxName: name }, $setOnInsert: { matches: 0, goals: 0, assists: 0, coins: 0 } }, { upsert: true });
  setCookie(res, 'bfl', sign({ rid, exp: Date.now() + 7 * 864e5 }), 7 * 86400);
  res.redirect('/#club');
}));
app.get('/auth/logout', (_, res) => { setCookie(res, 'bfl', '', 0); res.redirect('/'); });

// Admin editing: clubs (with logo), games, cups, texts
app.post('/api/admin/import-teams', admin, h(async (_, res) => res.json(await importTeams())));
app.post('/api/admin/import', admin, h(async (_, res) => res.json(await importClubs())));
app.put('/api/admin/texts', admin, h(async (req, res) => {
  await (await db()).collection('settings').updateOne({ _id: 'texts' }, { $set: { pairs: req.body.pairs || [] } }, { upsert: true }); res.sendStatus(204);
}));
app.post('/api/admin/:col', admin, okCol, h(async (req, res) => {
  const d = body(req), r = await (await db()).collection(req.params.col).insertOne(d); res.json({ ...d, _id: r.insertedId });
}));
app.patch('/api/admin/:col/:id', admin, okCol, h(async (req, res) => {
  await (await db()).collection(req.params.col).updateOne({ _id: new ObjectId(req.params.id) }, { $set: body(req) }); res.sendStatus(204);
}));
app.delete('/api/admin/:col/:id', admin, okCol, h(async (req, res) => {
  await (await db()).collection(req.params.col).deleteOne({ _id: new ObjectId(req.params.id) }); res.sendStatus(204);
}));

module.exports = app;
