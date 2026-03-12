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
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const GUILD_IDS = process.env.DISCORD_GUILD_IDS;

if (!TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID in environment.');
  process.exit(1);
}

const STATE_PATH = path.join(__dirname, 'state.json');

const ENROLL_HOURS = 24;
const PROMPT_HOURS = 24;
const VOTE_HOURS = 24;
const FIRST_TURN_HOURS = 24;
const TURN_HOURS = 24;
const THREAD_AUTO_ARCHIVE_MINUTES = 1440;

const MAX_PROMPT_LENGTH = 300;
const MAX_TURN_LENGTH = 1500;

const VOTE_EMOJIS = [
  '1️⃣',
  '2️⃣',
  '3️⃣',
  '4️⃣',
  '5️⃣',
  '6️⃣',
  '7️⃣',
  '8️⃣',
  '9️⃣',
  '🔟',
  '🇦',
  '🇧',
  '🇨',
  '🇩',
  '🇪',
  '🇫',
  '🇬',
  '🇭',
  '🇮',
  '🇯',
  '🇰',
  '🇱',
];

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { sessions: {} };
  }
}

let STATE = loadState();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function now() {
  return Date.now();
}

function hoursFromNow(hours) {
  return now() + hours * 60 * 60 * 1000;
}

function fmtDuration(ms) {
  const safeMs = Math.max(0, ms);
  const hours = Math.round(safeMs / (60 * 60 * 1000));
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function fmtDateTime(ms) {
  return new Date(ms).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Write state atomically to reduce the chance of a corrupted file.
 */
function saveState() {
  const tempPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(STATE, null, 2), 'utf8');
  fs.renameSync(tempPath, STATE_PATH);
}

function getSession(guildId) {
  return STATE.sessions[guildId] || null;
}

function setSession(guildId, session) {
  STATE.sessions[guildId] = session;
  saveState();
}

function clearSession(guildId) {
  delete STATE.sessions[guildId];
  saveState();
}

function getLeaderId(session) {
  return session.leaderId || session.writers[0];
}

function isGuildAdmin(interaction) {
  return Boolean(
    interaction.memberPermissions?.has('Administrator') ||
      interaction.memberPermissions?.has('ManageGuild')
  );
}

function buildWriterList(writers) {
  if (!writers.length) {
    return 'No writers yet.';
  }

  return writers.map((id, index) => `${index + 1}. <@${id}>`).join('\n');
}

function buildPromptList(prompts) {
  if (!prompts.length) {
    return 'No prompts yet.';
  }

  return prompts
    .map((prompt, index) => `${index + 1}. "${prompt.text}" (by <@${prompt.userId}>)`)
    .join('\n');
}

function buildStatusMessage(session) {
  let status = `Phase: ${session.phase}`;

  if (session.phase === 'enroll') {
    status += '\nWaiting for writers to join with /joinfictioncord.';
    status += `\nEnrollment ends in ${fmtDuration(session.enrollEndsAt - now())}`;
    status += `\nEnrollment deadline: ${fmtDateTime(session.enrollEndsAt)}`;
    status += `\nWriters so far:\n${buildWriterList(session.writers)}`;
  }

  if (session.phase === 'collect_prompts') {
    status += '\nCollecting prompt ideas with /submitprompt.';
    status += `\nPrompts so far: ${session.prompts.length}/${VOTE_EMOJIS.length}`;
    status += `\nPrompt collection ends in ${fmtDuration(session.promptEndsAt - now())}`;
    status += `\nPrompt deadline: ${fmtDateTime(session.promptEndsAt)}`;
    status += `\nPrompts submitted:\n${buildPromptList(session.prompts)}`;
  }

  if (session.phase === 'vote_prompt') {
    status += '\nVoting on prompts by reacting to the poll message.';
    status += `\nVoting ends in ${fmtDuration(session.voteEndsAt - now())}`;
    status += `\nVote deadline: ${fmtDateTime(session.voteEndsAt)}`;
  }

  if (session.phase === 'writing') {
    const writerId = session.writers[session.currentWriterIndex];
    status += `\nWaiting for <@${writerId}> to submit a turn with /submitturn.`;
    status += `\nTurn ends in ${fmtDuration(session.turnEndsAt - now())}`;
    status += `\nTurn deadline: ${fmtDateTime(session.turnEndsAt)}`;

    if (session.selectedPromptText) {
      status += `\nSelected prompt: "${session.selectedPromptText}"`;
    }

    if (session.threadId) {
      status += `\nStory thread: https://discord.com/channels/${session.guildId}/${session.threadId}`;
    }
  }

  return status;
}

/**
 * Prevent bot reposts from triggering @everyone, @here or user mentions.
 */
async function safeSend(channel, content) {
  return channel.send({
    content,
    allowedMentions: { parse: [] },
  });
}

async function announce(channel, text) {
  return safeSend(channel, text);
}

async function getMainChannel(session) {
  if (!session?.channelId) {
    return null;
  }

  return client.channels.fetch(session.channelId).catch(() => null);
}

async function getStoryThread(session) {
  if (!session?.threadId) {
    return null;
  }

  const thread = await client.channels.fetch(session.threadId).catch(() => null);
  return thread || null;
}

async function getStoryChannel(session, fallbackChannel) {
  const thread = await getStoryThread(session);
  return thread || fallbackChannel;
}

async function createStoryThread(session, channel, promptText) {
  const thread = await channel.threads.create({
    name: `Fictioncord: ${promptText.slice(0, 80)}`,
    autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES,
    reason: 'Fictioncord story thread',
  });

  await safeSend(thread, `Selected prompt:\n${promptText}`);

  const guild =
    channel.guild || (await client.guilds.fetch(channel.guildId).catch(() => null));
  const everyoneRole = guild?.roles?.everyone;
  const botMember =
    guild?.members?.me || (guild ? await guild.members.fetchMe().catch(() => null) : null);

  if (thread.permissionOverwrites) {
    if (everyoneRole) {
      await thread.permissionOverwrites.edit(everyoneRole, {
        SendMessagesInThreads: false,
        AddReactions: true,
      });
    }

    if (botMember) {
      await thread.permissionOverwrites.edit(botMember, {
        SendMessagesInThreads: true,
        AddReactions: true,
      });
    }
  }

  session.threadId = thread.id;
  session.lockedStoryThread = true;

  return thread;
}

function createSession({ guildId, channelId, leaderId }) {
  return {
    guildId,
    channelId,
    leaderId,
    startedAt: now(),
    phase: 'enroll',
    enrollEndsAt: hoursFromNow(ENROLL_HOURS),
    promptEndsAt: null,
    voteEndsAt: null,
    turnEndsAt: null,
    writers: [leaderId],
    prompts: [],
    story: [],
    currentWriterIndex: 0,
    voteMessageId: null,
    selectedPromptIndex: null,
    selectedPromptText: null,
    threadId: null,
    lockedStoryThread: false,
    reminders: {
      enroll12: false,
      enroll1: false,
      prompt12: false,
      prompt1: false,
      vote12: false,
      vote1: false,
      turn12: false,
      turn1: false,
    },
  };
}

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName('startfictioncord')
      .setDescription('Start a Fictioncord session (24h enrollment).'),

    new SlashCommandBuilder()
      .setName('joinfictioncord')
      .setDescription('Join the current Fictioncord session as a writer.'),

    new SlashCommandBuilder()
      .setName('submitprompt')
      .setDescription('Submit a prompt for the story.')
      .addStringOption((opt) =>
        opt
          .setName('prompt')
          .setDescription(`Your prompt (max ${MAX_PROMPT_LENGTH} chars)`)
          .setRequired(true)
          .setMaxLength(MAX_PROMPT_LENGTH)
      ),

    new SlashCommandBuilder()
      .setName('submitturn')
      .setDescription('Submit your story turn (opens a modal).'),

    new SlashCommandBuilder()
      .setName('theend')
      .setDescription('End the session and post the story thread link.'),

    new SlashCommandBuilder()
      .setName('skipstep')
      .setDescription('Leader-only: skip the current step.'),

    new SlashCommandBuilder()
      .setName('resetfictioncord')
      .setDescription('Leader or admin: reset and clear the session.'),

    new SlashCommandBuilder()
      .setName('rulesfictioncord')
      .setDescription('Show the Fictioncord rules and flow.'),

    new SlashCommandBuilder()
      .setName('statusfictioncord')
      .setDescription('Show the current session status.'),
  ].map((command) => command.toJSON());

  const rest = new REST({ version: '10' }).setToken(TOKEN);

  if (GUILD_IDS) {
    const ids = GUILD_IDS.split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    for (const id of ids) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, id), {
        body: commands,
      });
    }

    console.log(`Registered guild commands for ${ids.length} guild(s).`);
    return;
  }

  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log('Registered guild commands.');
    return;
  }

  await rest.put(Routes.applicationCommands(CLIENT_ID), {
    body: commands,
  });
  console.log('Registered global commands (may take up to about 1 hour to appear).');
}

async function openEnrollment(guildId, channelId, userId, channel) {
  const existing = getSession(guildId);

  if (existing) {
    return false;
  }

  const session = createSession({
    guildId,
    channelId,
    leaderId: userId,
  });

  setSession(guildId, session);

  await announce(
    channel,
    `Hello everyone.\n` +
      `We are about to start a Fictioncord session.\n` +
      `Who wants to join in as a writer? You have ${ENROLL_HOURS} hours.\n` +
      `Participate with /joinfictioncord.`
  );

  return true;
}

async function joinEnrollment(guildId, userId, channel) {
  const session = getSession(guildId);

  if (!session || session.phase !== 'enroll') {
    return 'not_open';
  }

  if (session.writers.includes(userId)) {
    return 'already';
  }

  session.writers.push(userId);
  setSession(guildId, session);

  await announce(channel, `<@${userId}> is now a writer for this session.`);
  return 'joined';
}

async function submitPrompt(guildId, userId, promptText, channel) {
  const session = getSession(guildId);

  if (!session || session.phase !== 'collect_prompts') {
    await announce(channel, 'Prompt collection is not open.');
    return;
  }

  if (!session.writers.includes(userId)) {
    await announce(channel, 'Only enrolled writers can submit prompts.');
    return;
  }

  if (session.prompts.length >= VOTE_EMOJIS.length) {
    await announce(channel, `Prompt list is full (max ${VOTE_EMOJIS.length}).`);
    return;
  }

  session.prompts.push({
    userId,
    text: promptText,
  });

  setSession(guildId, session);

  await announce(channel, `Prompt received from <@${userId}>: "${promptText}"`);
}

async function submitTurn(guildId, userId, text, channel) {
  const session = getSession(guildId);

  if (!session || session.phase !== 'writing') {
    await announce(channel, 'There is no active writing turn right now.');
    return;
  }

  const currentWriterId = session.writers[session.currentWriterIndex];

  if (currentWriterId !== userId) {
    await announce(channel, `It is not your turn. Current writer: <@${currentWriterId}>.`);
    return;
  }

  session.story.push({
    userId,
    text,
    timestamp: now(),
  });

  const storyChannel = await getStoryChannel(session, channel);

  await safeSend(storyChannel, `Turn ${session.story.length} by <@${userId}>:\n${text}`);

  session.currentWriterIndex = (session.currentWriterIndex + 1) % session.writers.length;
  session.turnEndsAt = hoursFromNow(TURN_HOURS);
  session.reminders.turn12 = false;
  session.reminders.turn1 = false;

  setSession(guildId, session);

  const nextWriterId = session.writers[session.currentWriterIndex];

  await announce(
    channel,
    `Turn received. Next writer is <@${nextWriterId}>.\n` +
      `You have ${TURN_HOURS} hours to submit with /submitturn.`
  );
}

async function announceWriters(session, channel) {
  await announce(
    channel,
    `Enrollment closed.\nWriters in order:\n${buildWriterList(session.writers)}`
  );
}

async function startPromptCollection(session, channel) {
  session.phase = 'collect_prompts';
  session.promptEndsAt = hoursFromNow(PROMPT_HOURS);
  session.reminders.prompt12 = false;
  session.reminders.prompt1 = false;

  setSession(session.guildId, session);

  await announce(
    channel,
    `Now we are collecting prompts. You have ${PROMPT_HOURS} hours to submit with /submitprompt.\n` +
      `There is a limit of ${VOTE_EMOJIS.length} prompts total.`
  );
}

async function startVoting(session, channel) {
  session.phase = 'vote_prompt';
  session.voteEndsAt = hoursFromNow(VOTE_HOURS);
  session.reminders.vote12 = false;
  session.reminders.vote1 = false;

  setSession(session.guildId, session);

  const promptLines = session.prompts.map(
    (prompt, index) => `${VOTE_EMOJIS[index]} ${prompt.text} (by <@${prompt.userId}>)`
  );

  const message = await channel.send({
    content:
      `Vote for your favorite prompt by reacting.\n` +
      `You have ${VOTE_HOURS} hours.\n\n` +
      promptLines.join('\n'),
    allowedMentions: { parse: [] },
  });

  for (let index = 0; index < session.prompts.length; index += 1) {
    await message.react(VOTE_EMOJIS[index]);
  }

  session.voteMessageId = message.id;
  setSession(session.guildId, session);
}

async function selectPrompt(session, channel) {
  let selectedIndex = 0;

  try {
    const message = await channel.messages.fetch(session.voteMessageId);
    await message.fetch();

    let bestCount = -1;

    for (let index = 0; index < session.prompts.length; index += 1) {
      const emoji = VOTE_EMOJIS[index];
      const reaction = message.reactions.cache.get(emoji);

      if (!reaction) {
        continue;
      }

      const users = await reaction.users.fetch();
      const count = users.filter((user) => !user.bot).size;

      if (count > bestCount) {
        bestCount = count;
        selectedIndex = index;
      }
    }
  } catch {
    selectedIndex = 0;
  }

  session.selectedPromptIndex = selectedIndex;
  session.selectedPromptText = session.prompts[selectedIndex]?.text || null;
  session.phase = 'writing';
  session.currentWriterIndex = 0;
  session.turnEndsAt = hoursFromNow(FIRST_TURN_HOURS);
  session.reminders.turn12 = false;
  session.reminders.turn1 = false;
  session.threadId = null;
  session.lockedStoryThread = false;

  const prompt = session.prompts[selectedIndex];
  const thread = await createStoryThread(session, channel, prompt.text);

  setSession(session.guildId, session);

  const firstWriterId = session.writers[0];

  await announce(
    channel,
    `Prompt selected: "${prompt.text}".\n` +
      `A story thread has been created: ${thread.url}\n` +
      `Writer 1 is <@${firstWriterId}>.\n` +
      `You have ${FIRST_TURN_HOURS} hours to submit with /submitturn.\n` +
      `_Tip: write your piece first, then use /submitturn to paste it in._`
  );
}

async function advanceTurn(session, channel) {
  session.currentWriterIndex = (session.currentWriterIndex + 1) % session.writers.length;
  session.turnEndsAt = hoursFromNow(TURN_HOURS);
  session.reminders.turn12 = false;
  session.reminders.turn1 = false;

  setSession(session.guildId, session);

  const nextWriterId = session.writers[session.currentWriterIndex];

  await announce(
    channel,
    `Time is up.\n` +
      `Next writer is <@${nextWriterId}>. You have ${TURN_HOURS} hours to submit with /submitturn.`
  );
}

async function endSession(guildId, userId, channel) {
  const session = getSession(guildId);

  if (!session) {
    await announce(channel, 'No active Fictioncord session.');
    return;
  }

  const currentWriterId =
    session.phase === 'writing' ? session.writers[session.currentWriterIndex] : null;

  const leaderId = getLeaderId(session);
  const isLeader = leaderId === userId;
  const isCurrentWriter = session.phase === 'writing' && currentWriterId === userId;

  if (!isLeader && !isCurrentWriter) {
    await announce(
      channel,
      `Only the leader or current writer can end the story.\nLeader is <@${leaderId}>.`
    );
    return;
  }

  const thread = await getStoryThread(session);

  await announce(channel, 'The story has ended.');

  if (session.selectedPromptText) {
    await announce(channel, `Selected prompt: "${session.selectedPromptText}"`);
  }

  if (thread) {
    await announce(channel, `Read the full story in the thread:\n${thread.url}`);
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  } else {
    await announce(channel, 'The story thread could not be found.');
  }

  clearSession(guildId);
}

async function skipStep(guildId, userId, channel) {
  const session = getSession(guildId);

  if (!session) {
    await announce(channel, 'No active Fictioncord session.');
    return;
  }

  const leaderId = getLeaderId(session);

  if (leaderId !== userId) {
    await announce(channel, `Only the leader can skip steps.\nLeader is <@${leaderId}>.`);
    return;
  }

  if (session.phase === 'enroll') {
    if (!session.writers.length) {
      await announce(channel, 'Enrollment closed. No writers joined. Session ended.');
      clearSession(session.guildId);
      return;
    }

    await announceWriters(session, channel);
    await startPromptCollection(session, channel);
    return;
  }

  if (session.phase === 'collect_prompts') {
    if (!session.prompts.length) {
      await announce(channel, 'Prompt collection ended with no prompts. Session ended.');
      clearSession(session.guildId);
      return;
    }

    await startVoting(session, channel);
    return;
  }

  if (session.phase === 'vote_prompt') {
    await selectPrompt(session, channel);
    return;
  }

  if (session.phase === 'writing') {
    await advanceTurn(session, channel);
    return;
  }

  await announce(channel, 'Nothing to skip right now.');
}

async function resetSession(guildId, userId, isAdmin, channel) {
  const session = getSession(guildId);

  if (!session) {
    await announce(channel, 'No active Fictioncord session.');
    return;
  }

  const leaderId = getLeaderId(session);

  if (!isAdmin && leaderId !== userId) {
    await announce(
      channel,
      `Only the leader or a server admin can reset.\nLeader is <@${leaderId}>.`
    );
    return;
  }

  const thread = await getStoryThread(session);

  if (thread) {
    await thread.setLocked(true).catch(() => {});
    await thread.setArchived(true).catch(() => {});
  }

  clearSession(guildId);
  await announce(channel, 'Fictioncord session reset.');
}

async function maybeSendReminder(session, channel) {
  if (!session) {
    return;
  }

  if (session.phase === 'enroll') {
    const hoursLeft = (session.enrollEndsAt - now()) / (60 * 60 * 1000);

    if (hoursLeft <= 12 && !session.reminders.enroll12) {
      session.reminders.enroll12 = true;
      await announce(channel, 'Reminder: 12 hours left to join the Fictioncord session.');
      return true;
    }

    if (hoursLeft <= 1 && !session.reminders.enroll1) {
      session.reminders.enroll1 = true;
      await announce(channel, 'Reminder: 1 hour left to join the Fictioncord session.');
      return true;
    }
  }

  if (session.phase === 'collect_prompts') {
    const hoursLeft = (session.promptEndsAt - now()) / (60 * 60 * 1000);

    if (hoursLeft <= 12 && !session.reminders.prompt12) {
      session.reminders.prompt12 = true;
      await announce(channel, 'Reminder: 12 hours left to submit prompts.');
      return true;
    }

    if (hoursLeft <= 1 && !session.reminders.prompt1) {
      session.reminders.prompt1 = true;
      await announce(channel, 'Reminder: 1 hour left to submit prompts.');
      return true;
    }
  }

  if (session.phase === 'vote_prompt') {
    const hoursLeft = (session.voteEndsAt - now()) / (60 * 60 * 1000);

    if (hoursLeft <= 12 && !session.reminders.vote12) {
      session.reminders.vote12 = true;
      await announce(channel, 'Reminder: 12 hours left to vote on prompts.');
      return true;
    }

    if (hoursLeft <= 1 && !session.reminders.vote1) {
      session.reminders.vote1 = true;
      await announce(channel, 'Reminder: 1 hour left to vote on prompts.');
      return true;
    }
  }

  if (session.phase === 'writing') {
    const hoursLeft = (session.turnEndsAt - now()) / (60 * 60 * 1000);
    const currentWriterId = session.writers[session.currentWriterIndex];

    if (hoursLeft <= 12 && !session.reminders.turn12) {
      session.reminders.turn12 = true;
      await announce(
        channel,
        `Reminder: 12 hours left for <@${currentWriterId}> to submit their turn.`
      );
      return true;
    }

    if (hoursLeft <= 1 && !session.reminders.turn1) {
      session.reminders.turn1 = true;
      await announce(
        channel,
        `Reminder: 1 hour left for <@${currentWriterId}> to submit their turn.`
      );
      return true;
    }
  }

  return false;
}

async function processSession(session) {
  const freshSession = getSession(session.guildId);

  if (!freshSession) {
    return;
  }

  const channel = await getMainChannel(freshSession);

  if (!channel) {
    return;
  }

  const reminderSent = await maybeSendReminder(freshSession, channel);

  if (reminderSent) {
    setSession(freshSession.guildId, freshSession);
  }

  if (freshSession.phase === 'enroll' && now() >= freshSession.enrollEndsAt) {
    if (!freshSession.writers.length) {
      await announce(channel, 'Enrollment closed. No writers joined. Session ended.');
      clearSession(freshSession.guildId);
      return;
    }

    await announceWriters(freshSession, channel);
    await startPromptCollection(freshSession, channel);
    return;
  }

  if (freshSession.phase === 'collect_prompts' && now() >= freshSession.promptEndsAt) {
    if (!freshSession.prompts.length) {
      await announce(channel, 'Prompt collection ended with no prompts. Session ended.');
      clearSession(freshSession.guildId);
      return;
    }

    await startVoting(freshSession, channel);
    return;
  }

  if (freshSession.phase === 'vote_prompt' && now() >= freshSession.voteEndsAt) {
    await selectPrompt(freshSession, channel);
    return;
  }

  if (freshSession.phase === 'writing' && now() >= freshSession.turnEndsAt) {
    await advanceTurn(freshSession, channel);
  }
}

function createRulesMessage() {
  return (
    `Fictioncord rules and flow:\n\n` +
    `1. /startfictioncord opens writer enrollment for 24 hours.\n` +
    `2. Writers join with /joinfictioncord.\n` +
    `3. After enrollment closes, the bot announces the writing order.\n` +
    `4. Prompt collection opens for 24 hours.\n` +
    `5. Only enrolled writers can submit prompts with /submitprompt.\n` +
    `6. The bot posts the prompts and opens a reaction vote for 24 hours.\n` +
    `7. The winning prompt is selected.\n` +
    `8. The bot creates a story thread.\n` +
    `9. Writers take turns in order using /submitturn.\n` +
    `10. The leader or current writer can end the session with /theend.\n` +
    `11. When the session ends, the bot posts the thread link in the main channel.\n\n` +
    `Notes:\n` +
    `- Only the current writer can submit a turn.\n` +
    `- Prompt voting supports up to ${VOTE_EMOJIS.length} prompts.\n` +
    `- The story thread is bot-only. User messages there are deleted.\n` +
    `- The leader can skip steps with /skipstep.\n` +
    `- The leader or a server admin can reset the session with /resetfictioncord.`
  );
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'startfictioncord') {
        const created = await openEnrollment(
          interaction.guildId,
          interaction.channelId,
          interaction.user.id,
          interaction.channel
        );

        if (!created) {
          await interaction.reply({
            content: 'There is already an active Fictioncord session in this server.',
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content: 'Fictioncord session started.',
          ephemeral: true,
        });
        return;
      }

      if (commandName === 'joinfictioncord') {
        const result = await joinEnrollment(
          interaction.guildId,
          interaction.user.id,
          interaction.channel
        );

        if (result === 'not_open') {
          await interaction.reply({
            content: 'Enrollment is not open.',
            ephemeral: true,
          });
          return;
        }

        if (result === 'already') {
          await interaction.reply({
            content: 'You are already enrolled as a writer.',
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content: 'You joined the Fictioncord session as a writer.',
          ephemeral: true,
        });
        return;
      }

      if (commandName === 'submitprompt') {
        const promptText = interaction.options.getString('prompt', true);

        await submitPrompt(
          interaction.guildId,
          interaction.user.id,
          promptText,
          interaction.channel
        );

        await interaction.reply({
          content: 'Prompt submission processed.',
          ephemeral: true,
        });
        return;
      }

      if (commandName === 'submitturn') {
        const session = getSession(interaction.guildId);

        if (!session || session.phase !== 'writing') {
          await interaction.reply({
            content: 'There is no active writing turn right now.',
            ephemeral: true,
          });
          return;
        }

        const currentWriterId = session.writers[session.currentWriterIndex];

        if (currentWriterId !== interaction.user.id) {
          await interaction.reply({
            content: `It is not your turn. Current writer: <@${currentWriterId}>.`,
            ephemeral: true,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId('fictioncord_submitturn_modal')
          .setTitle('Submit your story turn');

        const textInput = new TextInputBuilder()
          .setCustomId('turn_text')
          .setLabel(`Your turn (max ${MAX_TURN_LENGTH} chars)`)
          .setStyle(TextInputStyle.Paragraph)
          .setMaxLength(MAX_TURN_LENGTH)
          .setRequired(true);

        const row = new ActionRowBuilder().addComponents(textInput);

        modal.addComponents(row);

        await interaction.showModal(modal);
        return;
      }

      if (commandName === 'theend') {
        await endSession(interaction.guildId, interaction.user.id, interaction.channel);

        await interaction.reply({
          content: 'End session request processed.',
          ephemeral: true,
        });
        return;
      }

      if (commandName === 'skipstep') {
        await skipStep(interaction.guildId, interaction.user.id, interaction.channel);

        await interaction.reply({
          content: 'Skip request processed.',
          ephemeral: true,
        });
        return;
      }

      if (commandName === 'resetfictioncord') {
        await resetSession(
          interaction.guildId,
          interaction.user.id,
          isGuildAdmin(interaction),
          interaction.channel
        );

        await interaction.reply({
          content: 'Reset request processed.',
          ephemeral: true,
        });
        return;
      }

      if (commandName === 'rulesfictioncord') {
        await interaction.reply({
          content: createRulesMessage(),
          ephemeral: true,
        });
        return;
      }

      if (commandName === 'statusfictioncord') {
        const session = getSession(interaction.guildId);

        if (!session) {
          await interaction.reply({
            content: 'No active Fictioncord session.',
            ephemeral: true,
          });
          return;
        }

        await interaction.reply({
          content: buildStatusMessage(session),
          ephemeral: true,
        });
      }

      return;
    }

    if (interaction.isModalSubmit()) {
      if (interaction.customId !== 'fictioncord_submitturn_modal') {
        return;
      }

      const turnText = interaction.fields.getTextInputValue('turn_text');

      await submitTurn(interaction.guildId, interaction.user.id, turnText, interaction.channel);

      await interaction.reply({
        content: 'Turn submission processed.',
        ephemeral: true,
      });
    }
  } catch (error) {
    console.error('Interaction error:', error);

    if (interaction.deferred || interaction.replied) {
      await interaction
        .followUp({
          content: 'Something went wrong while processing that action.',
          ephemeral: true,
        })
        .catch(() => {});
      return;
    }

    await interaction
      .reply({
        content: 'Something went wrong while processing that action.',
        ephemeral: true,
      })
      .catch(() => {});
  }
});

/**
 * Delete any user message posted directly in the active Fictioncord story thread.
 * No warning is sent back to avoid polluting the thread.
 */
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild) {
      return;
    }

    if (message.author.bot) {
      return;
    }

    const session = getSession(message.guild.id);

    if (!session) {
      return;
    }

    if (!session.threadId || !session.lockedStoryThread) {
      return;
    }

    if (message.channel.id !== session.threadId) {
      return;
    }

    await message.delete().catch(() => {});
  } catch (error) {
    console.error('Thread moderation error:', error);
  }
});

setInterval(async () => {
  try {
    const sessions = Object.values(STATE.sessions);

    for (const session of sessions) {
      await processSession(session);
    }
  } catch (error) {
    console.error('Timer loop error:', error);
  }
}, 60 * 1000);

setInterval(() => {
  try {
    saveState();
  } catch (error) {
    console.error('Autosave error:', error);
  }
}, 60 * 1000);

(async () => {
  try {
    STATE = loadState();
    await registerCommands();
    await client.login(TOKEN);
  } catch (error) {
    console.error('Startup error:', error);
    process.exit(1);
  }
})();

const PORT = process.env.PORT || 10000;

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Fictioncord bot is running.');
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP server listening on port ${PORT}`);
  });
