require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  Events,
  MessageFlags,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const GUILD_IDS = process.env.DISCORD_GUILD_IDS;
const BACKUP_CHANNEL_ID = process.env.DISCORD_BACKUP_CHANNEL_ID;
const PORT = process.env.PORT || 10000;

console.log('[startup] Environment check', {
  hasToken: Boolean(TOKEN),
  tokenLength: TOKEN ? TOKEN.length : 0,
  hasClientId: Boolean(CLIENT_ID),
  clientIdLength: CLIENT_ID ? CLIENT_ID.length : 0,
  hasGuildId: Boolean(GUILD_ID),
  guildIdLength: GUILD_ID ? GUILD_ID.length : 0,
  hasGuildIds: Boolean(GUILD_IDS),
  guildIdsCount: GUILD_IDS ? GUILD_IDS.split(',').map(s => s.trim()).filter(Boolean).length : 0,
  hasBackupChannelId: Boolean(BACKUP_CHANNEL_ID),
  backupChannelIdLength: BACKUP_CHANNEL_ID ? BACKUP_CHANNEL_ID.length : 0,
  port: PORT,
  nodeEnv: process.env.NODE_ENV || null,
});

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.');
  process.exit(1);
}

const STATE_PATH = path.join(__dirname, 'state.json');

let lastDiscordReadyAt = null;
let lastDiscordDisconnectAt = null;
let lastInteractionAt = null;

function now() {
  return Date.now();
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { sessions: {} };
  }
}

let STATE = loadState();

function buildHealthPayload() {
  const ready = client.isReady();
  const wsStatus = client.ws?.status ?? null;

  return {
    ok: ready,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    nodeEnv: process.env.NODE_ENV || 'development',
    discord: {
      ready,
      wsStatus,
      wsStatusName: getWsStatusName(wsStatus),
      userTag: client.user?.tag || null,
      lastReadyAt: lastDiscordReadyAt ? new Date(lastDiscordReadyAt).toISOString() : null,
      lastDisconnectAt: lastDiscordDisconnectAt ? new Date(lastDiscordDisconnectAt).toISOString() : null,
      lastInteractionAt: lastInteractionAt ? new Date(lastInteractionAt).toISOString() : null,
      guildCount: client.guilds?.cache?.size ?? 0,
    },
    state: {
      activeSessions: Object.keys(STATE.sessions || {}).length,
    },
    timestamp: new Date().toISOString(),
  };
}

function getWsStatusName(status) {
  const mapping = {
    0: 'READY',
    1: 'CONNECTING',
    2: 'RECONNECTING',
    3: 'IDLE',
    4: 'NEARLY',
    5: 'DISCONNECTED',
  };
  return mapping[status] ?? `UNKNOWN_${status}`;
}

function logWithTime(level, message, extra) {
  const prefix = `[${new Date().toISOString()}] ${message}`;
  if (extra) console[level](prefix, extra);
  else console[level](prefix);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (readyClient) => {
  lastDiscordReadyAt = now();
  logWithTime('log', `Discord ready as ${readyClient.user.tag}`);

  try {
    await registerCommands();
  } catch (error) {
    logWithTime('error', 'Command registration failed.', error);
  }
});

setTimeout(() => {
  if (!client.isReady()) {
    logWithTime('warn', 'Client still not ready 30s after startup.', buildHealthPayload());
  }
}, 30000);

client.on('shardDisconnect', () => {
  lastDiscordDisconnectAt = now();
});

client.on(Events.InteractionCreate, async (interaction) => {
  lastInteractionAt = now();

  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'statusfictioncord') {
    const health = buildHealthPayload();

    await interaction.reply({
      content:
        `Bot health:\n` +
        `- Discord ready: ${health.discord.ready}\n` +
        `- WS status: ${health.discord.wsStatusName}`,
      flags: MessageFlags.Ephemeral,
    });
  }
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('statusfictioncord')
      .setDescription('Check bot status'),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (GUILD_IDS) {
    const ids = GUILD_IDS.split(',').map(id => id.trim());
    for (const id of ids) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, id), { body: commands });
    }
    return;
  }

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
    return;
  }

  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
}

process.on('SIGTERM', () => {
  logWithTime('warn', 'Received SIGTERM. Shutting down.');
  process.exit(0);
});

process.on('SIGINT', () => {
  logWithTime('warn', 'Received SIGINT. Shutting down.');
  process.exit(0);
});

http
  .createServer((req, res) => {
    const payload = buildHealthPayload();
    const body = JSON.stringify(payload, null, 2);
    const statusCode = payload.ok ? 200 : 503;

    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  })
  .listen(PORT, '0.0.0.0', () => {
    logWithTime('log', `HTTP server listening on port ${PORT}`);
  });

(async () => {
  logWithTime('log', 'About to call client.login()', {
    hasToken: Boolean(TOKEN),
    tokenLength: TOKEN ? TOKEN.length : 0,
  });

  client.login(TOKEN)
    .then(() => {
      logWithTime('log', 'client.login() resolved.');
    })
    .catch((error) => {
      logWithTime('error', 'client.login() failed.', error);
      process.exit(1);
    });
})();
