// Run once after deploying: node --env-file=.env scripts/register-commands.js
const E = process.env;
const commands = [
  { name: 'player', description: 'Look up a player', options: [{ name: 'name', description: 'Roblox name', type: 3, required: true }] },
  { name: 'club', description: 'Show your club' },
  { name: 'sync', description: 'Admin: import clubs from Discord roles' }];
fetch(`https://discord.com/api/v10/applications/${E.DISCORD_APP_ID}/guilds/${E.GUILD_ID}/commands`,
  { method: 'PUT', headers: { Authorization: 'Bot ' + E.DISCORD_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(commands) })
  .then(r => r.json()).then(r => console.log(Array.isArray(r) ? 'Registered ' + r.length + ' commands' : r));
