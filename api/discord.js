// Discord bot as an HTTP interactions endpoint (Vercel can't keep a gateway bot running).
// Set "Interactions Endpoint URL" in the Discord developer portal to https://YOUR-SITE/api/discord
const nacl = require('tweetnacl');
const { E, db, getClub, importClubs } = require('../lib/shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  const raw = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
  let ok = false;
  try { ok = nacl.sign.detached.verify(Buffer.from(req.headers['x-signature-timestamp'] + raw),
    Buffer.from(req.headers['x-signature-ed25519'], 'hex'), Buffer.from(E.DISCORD_PUBLIC_KEY, 'hex')); } catch {}
  if (!ok) return res.status(401).send('invalid request signature');

  const i = JSON.parse(raw);
  if (i.type === 1) return res.json({ type: 1 }); // ping
  const say = (content, ephemeral) => res.json({ type: 4, data: { content, flags: ephemeral ? 64 : 0 } });
  const d = await db(), name = i.data.name, userId = i.member?.user.id || i.user?.id;
  try {
    if (name === 'player') {
      const q = i.data.options[0].value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const p = await d.collection('players').findOne({ robloxName: new RegExp('^' + q + '$', 'i') });
      return say(p ? `**${p.robloxName}** · ${p.matches} matches · ${p.goals} goals · ${p.assists} assists` : 'Player not found.');
    }
    if (name === 'club') {
      const p = await d.collection('players').findOne({ discordId: userId }), c = p && await getClub(p);
      return say(c ? `**${c.name}** · ${c.division} · ${c.pts} pts` : 'No club linked to your Discord account.');
    }
    if (name === 'sync') {
      if (!(BigInt(i.member?.permissions || 0) & 8n)) return say('Admins only.', true);
      const r = await importClubs();
      return say(`Imported ${r.clubs} clubs, linked ${r.linked} players.`, true);
    }
    return say('Unknown command.', true);
  } catch (e) { console.error(e); return say('Something went wrong. Try again.', true); }
};
