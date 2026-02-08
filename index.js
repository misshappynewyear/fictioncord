require('dotenv').config();
const fs = require('fs');
const path = require('path');
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
  MessageFlags,
  Events,
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // optional, but recommended for faster command updates
const GUILD_IDS = process.env.DISCORD_GUILD_IDS; // optional, comma-separated list

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
  '🅰️',
  '🅱️',
  '🆎',
  '🆑',
  '🆒',
  '🆓',
  '🆔',
  '🆕',
  '🆖',
  '🆗',
  '🆙',
  '🆚',
];

const THREAD_AUTO_ARCHIVE_MINUTES = 1440; // 24 hours

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { sessions: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function now() {
  return Date.now();
}

function hoursFromNow(h) {
  return now() + h * 60 * 60 * 1000;
}

function hoursLeft(endAt) {
  return (endAt - now()) / (60 * 60 * 1000);
}

function fmtDuration(ms) {
  const hours = Math.round(ms / (60 * 60 * 1000));
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

function getSession(state, guildId) {
  return state.sessions[guildId] || null;
}

function setSession(state, guildId, session) {
  state.sessions[guildId] = session;
  saveState(state);
}

function clearSession(state, guildId) {
  delete state.sessions[guildId];
  saveState(state);
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
          .setDescription('Your prompt (max 300 chars)')
          .setRequired(true)
          .setMaxLength(300)
      ),
    new SlashCommandBuilder()
      .setName('submitturn')
      .setDescription('Submit your story turn (opens a modal).'),
    new SlashCommandBuilder()
      .setName('theend')
      .setDescription('End the session and publish the story.'),
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
  ].map((c) => c.toJSON());

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
  } else if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: commands,
    });
    console.log('Registered guild commands.');
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log('Registered global commands (may take ~1h to appear).');
  }
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

async function announce(channel, text) {
  await channel.send({ content: text });
}

function buildWriterList(writers) {
  return writers.map((id, i) => `${i + 1}. <@${id}>`).join('\n');
}

function buildPromptList(prompts) {
  if (!prompts.length) return 'No prompts yet.';
  return prompts.map((p, i) => `${i + 1}. "${p.text}" (by <@${p.userId}>)`).join('\n');
}

function buildStory(story) {
  if (!story.length) return 'No turns were submitted.';
  return story
    .map((turn, i) => `${i + 1}. <@${turn.userId}>\n${turn.text}`)
    .join('\n\n');
}

function buildStatusMessage(session) {
  let status = `Phase: ${session.phase}`;
  if (session.phase === 'enroll') {
    status += `\nWaiting for writers to join with /joinfictioncord.`;
    status += `\nEnrollment ends in ${fmtDuration(session.enrollEndsAt - now())}`;
    status += `\nWriters so far:\n${buildWriterList(session.writers) || 'No writers yet.'}`;
  }
  if (session.phase === 'collect_prompts') {
    status += `\nCollecting prompt ideas with /submitprompt.`;
    status += `\nPrompts so far: ${session.prompts.length}/${VOTE_EMOJIS.length}`;
    status += `\nPrompt collection ends in ${fmtDuration(session.promptEndsAt - now())}`;
    status += `\nPrompts submitted:\n${buildPromptList(session.prompts)}`;
  }
  if (session.phase === 'vote_prompt') {
    status += `\nVoting on prompts (react to the poll message).`;
    status += `\nVoting ends in ${fmtDuration(session.voteEndsAt - now())}`;
  }
  if (session.phase === 'writing') {
    const writerId = session.writers[session.currentWriterIndex];
    status += `\nWaiting for <@${writerId}> to submit their turn with /submitturn.`;
    status += `\nTurn ends in ${fmtDuration(session.turnEndsAt - now())}`;
  }
  return status;
}

function getLeaderId(session) {
  return session.leaderId || session.writers[0];
}

function isGuildAdmin(interaction) {
  return Boolean(interaction.memberPermissions?.has('Administrator') || interaction.memberPermissions?.has('ManageGuild'));
}

async function getStoryChannel(session, fallbackChannel) {
  if (!session.threadId) return fallbackChannel;
  const thread = await client.channels.fetch(session.threadId).catch(() => null);
  return thread || fallbackChannel;
}

async function createStoryThread(session, channel, promptText) {
  const thread = await channel.threads.create({
    name: `Fictioncord: ${promptText.slice(0, 80)}`,
    autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES,
    reason: 'Fictioncord story thread',
  });

  await thread.send({ content: `Selected prompt:\n${promptText}` });

  // Lock writes for everyone; allow reactions so the community can react.
  const guild = channel.guild || (await client.guilds.fetch(channel.guildId).catch(() => null));
  const everyoneRole = guild?.roles?.everyone;
  const botMember = guild?.members?.me || (guild ? await guild.members.fetchMe().catch(() => null) : null);

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
}

async function openEnrollment(guildId, channelId, userId, channel) {
  const state = loadState();
  const existing = getSession(state, guildId);
  if (existing) {
    return false;
  }

  const session = {
    guildId,
    channelId,
    leaderId: userId,
    startedAt: now(),
    phase: 'enroll',
    enrollEndsAt: hoursFromNow(ENROLL_HOURS),
    writers: [userId],
    prompts: [],
    story: [],
    currentWriterIndex: 0,
    voteMessageId: null,
    selectedPromptIndex: null,
    threadId: null,
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
    turnEndsAt: null,
  };

  setSession(state, guildId, session);

  await announce(
    channel,
    `Hello everyone. We are about to start a Fictioncord session. Who wants to join in as a writer? You have ${ENROLL_HOURS} hours.\nParticipate with /joinfictioncord.`
  );

  return true;
}

async function joinEnrollment(guildId, userId, channel) {
  const state = loadState();
  const session = getSession(state, guildId);
  if (!session || session.phase !== 'enroll') {
    await announce(channel, 'There is no enrollment open right now.');
    return;
  }
  if (session.writers.includes(userId)) {
    await announce(channel, 'You are already enrolled.');
    return;
  }
  session.writers.push(userId);
  setSession(state, guildId, session);
  await announce(channel, `<@${userId}> is now a writer for this session.`);
}

async function submitPrompt(guildId, userId, prompt, channel) {
  const state = loadState();
  const session = getSession(state, guildId);
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
  session.prompts.push({ userId, text: prompt });
  setSession(state, guildId, session);
  await announce(channel, `Prompt received from <@${userId}>: "${prompt}"`);
}

async function submitTurn(guildId, userId, text, channel) {
  const state = loadState();
  const session = getSession(state, guildId);
  const currentWriterId = session.writers[session.currentWriterIndex];
  session.story.push({ userId, text, timestamp: now() });

  const storyChannel = await getStoryChannel(session, channel);
  await storyChannel.send({
    content: `Turn ${session.story.length} by <@${userId}>:\n${text}`,
  });

  // Move to the next writer immediately.
  session.currentWriterIndex = (session.currentWriterIndex + 1) % session.writers.length;
  session.turnEndsAt = hoursFromNow(TURN_HOURS);
  setSession(state, guildId, session);

  const nextWriterId = session.writers[session.currentWriterIndex];
  await announce(
    channel,
    `Turn received. Next writer is <@${nextWriterId}>. You have ${TURN_HOURS} hours to submit with /submitturn.`
  );
}

async function endSession(guildId, userId, channel) {
  const state = loadState();
  const session = getSession(state, guildId);
  if (!session) {
    await announce(channel, 'No active Fictioncord session.');
    return;
  }

  const currentWriterId = session.writers[session.currentWriterIndex];
  const leaderId = getLeaderId(session);
  const isLeader = leaderId === userId;
  const isCurrentWriter = session.phase === 'writing' && currentWriterId === userId;
  if (!isLeader && !isCurrentWriter) {
    await announce(
      channel,
      `Only the leader or current writer can end the story. Leader is <@${leaderId}>.`
    );
    return;
  }

  const storyText = buildStory(session.story);
  await announce(channel, 'The story has ended.');
  await announce(channel, `Final story:\n\n${storyText}`);

  if (session.threadId) {
    const thread = await client.channels.fetch(session.threadId).catch(() => null);
    if (thread && thread.isThread()) {
      await thread.setLocked(true).catch(() => {});
      await thread.setArchived(true).catch(() => {});
    }
  }

  clearSession(state, guildId);
}

async function announceWriters(session, channel) {
  const list = buildWriterList(session.writers);
  await announce(channel, `Enrollment closed. Writers in order:\n${list}`);
}

async function startPromptCollection(session, channel, state) {
  session.phase = 'collect_prompts';
  session.promptEndsAt = hoursFromNow(PROMPT_HOURS);
  session.reminders.prompt12 = false;
  session.reminders.prompt1 = false;
  setSession(state, session.guildId, session);

  await announce(
    channel,
    `Now we are collecting prompts. You have ${PROMPT_HOURS} hours to submit with /submitprompt. ` +
      `There is a limit of ${VOTE_EMOJIS.length} prompts total.`
  );
}

async function startVoting(session, channel, state) {
  session.phase = 'vote_prompt';
  session.voteEndsAt = hoursFromNow(VOTE_HOURS);
  session.reminders.vote12 = false;
  session.reminders.vote1 = false;
  setSession(state, session.guildId, session);

  const promptLines = session.prompts.map(
    (p, i) => `${VOTE_EMOJIS[i]} ${p.text} (by <@${p.userId}>)`
  );
  const message = await channel.send({
    content: `Vote for your favorite prompt by reacting. You have ${VOTE_HOURS} hours.\n\n${promptLines.join('\n')}`,
  });

  for (let i = 0; i < session.prompts.length; i++) {
    await message.react(VOTE_EMOJIS[i]);
  }

  session.voteMessageId = message.id;
  setSession(state, session.guildId, session);
}

async function selectPrompt(session, channel, state) {
  let selectedIndex = 0;

  try {
    const msg = await channel.messages.fetch(session.voteMessageId);
    await msg.fetch();

    let bestCount = -1;
    for (let i = 0; i < session.prompts.length; i++) {
      const emoji = VOTE_EMOJIS[i];
      const reaction = msg.reactions.cache.get(emoji);
      if (!reaction) continue;
      const users = await reaction.users.fetch();
      const count = users.filter((u) => !u.bot).size;
      if (count > bestCount) {
        bestCount = count;
        selectedIndex = i;
      }
    }
  } catch {
    // Fallback to first prompt if anything fails.
    selectedIndex = 0;
  }

  session.selectedPromptIndex = selectedIndex;
  session.phase = 'writing';
  session.currentWriterIndex = 0;
  session.turnEndsAt = hoursFromNow(FIRST_TURN_HOURS);
  session.threadId = null;
  session.reminders.turn12 = false;
  session.reminders.turn1 = false;
  const prompt = session.prompts[selectedIndex];
  await createStoryThread(session, channel, prompt.text);
  setSession(state, session.guildId, session);

  const firstWriterId = session.writers[0];
  await announce(
    channel,
    `Prompt selected: "${prompt.text}". A story thread has been created.\nWriter 1 is <@${firstWriterId}>. You have ${FIRST_TURN_HOURS} hours to submit with /submitturn.\n_Tip: write your piece first, then use /submitturn to paste it in._`
  );
}

async function advanceTurn(session, channel, state) {
  session.currentWriterIndex = (session.currentWriterIndex + 1) % session.writers.length;
  session.turnEndsAt = hoursFromNow(TURN_HOURS);
  session.reminders.turn12 = false;
  session.reminders.turn1 = false;
  setSession(state, session.guildId, session);

  const nextWriterId = session.writers[session.currentWriterIndex];
  await announce(
    channel,
    `Time is up. Next writer is <@${nextWriterId}>. You have ${TURN_HOURS} hours to submit with /submitturn.`
  );
}

async function skipStep(guildId, userId, channel) {
  const state = loadState();
  const session = getSession(state, guildId);
  if (!session) {
    await announce(channel, 'No active Fictioncord session.');
    return;
  }

  const leaderId = getLeaderId(session);
  if (leaderId !== userId) {
    await announce(channel, `Only the leader can skip steps. Leader is <@${leaderId}>.`);
    return;
  }

  if (session.phase === 'enroll') {
    if (!session.writers.length) {
      await announce(channel, 'Enrollment closed. No writers joined. Session ended.');
      clearSession(state, session.guildId);
      return;
    }
    await announceWriters(session, channel);
    await startPromptCollection(session, channel, state);
    return;
  }

  if (session.phase === 'collect_prompts') {
    if (!session.prompts.length) {
      await announce(channel, 'Prompt collection ended with no prompts. Session ended.');
      clearSession(state, session.guildId);
      return;
    }
    await startVoting(session, channel, state);
    return;
  }

  if (session.phase === 'vote_prompt') {
    await selectPrompt(session, channel, state);
    return;
  }

  if (session.phase === 'writing') {
    await advanceTurn(session, channel, state);
    return;
  }

  await announce(channel, 'Nothing to skip right now.');
}

async function resetSession(guildId, userId, isAdmin, channel) {
  const state = loadState();
  const session = getSession(state, guildId);
  if (!session) {
    await announce(channel, 'No active Fictioncord session.');
    return;
  }

  const leaderId = getLeaderId(session);
  if (!isAdmin && leaderId !== userId) {
    await announce(channel, `Only the leader or a server admin can reset. Leader is <@${leaderId}>.`);
    return;
  }

  if (session.threadId) {
    const thread = await client.channels.fetch(session.threadId).catch(() => null);
    if (thread && thread.isThread()) {
      await thread.setLocked(true).catch(() => {});
      await thread.setArchived(true).catch(() => {});
    }
  }

  clearSession(state, guildId);
  await announce(channel, 'Session reset. You can start a new one with /startfictioncord.');
}

async function tickSessions() {
  const state = loadState();
  const sessions = Object.values(state.sessions);
  if (!sessions.length) return;

  for (const session of sessions) {
    const channel = await client.channels.fetch(session.channelId).catch(() => null);
    if (!channel) continue;

    if (session.phase === 'enroll') {
      const hrsLeft = hoursLeft(session.enrollEndsAt);
      if (hrsLeft <= 12 && !session.reminders.enroll12 && hrsLeft > 1) {
        session.reminders.enroll12 = true;
        setSession(state, session.guildId, session);
        await announce(channel, 'Reminder: enrollment is still open. We are waiting for writers to join with /joinfictioncord.');
      } else if (hrsLeft <= 1 && !session.reminders.enroll1 && hrsLeft > 0) {
        session.reminders.enroll1 = true;
        setSession(state, session.guildId, session);
        await announce(channel, 'Reminder: enrollment closes in about 1 hour. Join with /joinfictioncord if you want to write.');
      }
    }

    if (session.phase === 'collect_prompts') {
      const hrsLeft = hoursLeft(session.promptEndsAt);
      if (hrsLeft <= 12 && !session.reminders.prompt12 && hrsLeft > 1) {
        session.reminders.prompt12 = true;
        setSession(state, session.guildId, session);
        await announce(channel, `Reminder: prompt collection is open. We are waiting for prompt ideas with /submitprompt. (${session.prompts.length}/${VOTE_EMOJIS.length})`);
      } else if (hrsLeft <= 1 && !session.reminders.prompt1 && hrsLeft > 0) {
        session.reminders.prompt1 = true;
        setSession(state, session.guildId, session);
        await announce(channel, 'Reminder: prompt collection closes in about 1 hour. Submit with /submitprompt.');
      }
    }

    if (session.phase === 'vote_prompt') {
      const hrsLeft = hoursLeft(session.voteEndsAt);
      if (hrsLeft <= 12 && !session.reminders.vote12 && hrsLeft > 1) {
        session.reminders.vote12 = true;
        setSession(state, session.guildId, session);
        await announce(channel, 'Reminder: voting is open. React to the poll message to pick your favorite prompt.');
      } else if (hrsLeft <= 1 && !session.reminders.vote1 && hrsLeft > 0) {
        session.reminders.vote1 = true;
        setSession(state, session.guildId, session);
        await announce(channel, 'Reminder: voting closes in about 1 hour. React to the poll message to vote.');
      }
    }

    if (session.phase === 'writing') {
      const hrsLeft = hoursLeft(session.turnEndsAt);
      const writerId = session.writers[session.currentWriterIndex];
      if (hrsLeft <= 12 && !session.reminders.turn12 && hrsLeft > 1) {
        session.reminders.turn12 = true;
        setSession(state, session.guildId, session);
        await announce(channel, `Reminder: we are waiting on <@${writerId}> to submit their turn with /submitturn.`);
      } else if (hrsLeft <= 1 && !session.reminders.turn1 && hrsLeft > 0) {
        session.reminders.turn1 = true;
        setSession(state, session.guildId, session);
        await announce(channel, `Reminder: <@${writerId}> has about 1 hour left to submit with /submitturn.`);
      }
    }

    if (session.phase === 'enroll' && now() >= session.enrollEndsAt) {
      if (!session.writers.length) {
        await announce(channel, 'Enrollment closed. No writers joined. Session ended.');
        clearSession(state, session.guildId);
      } else {
        await announceWriters(session, channel);
        await startPromptCollection(session, channel, state);
      }
    } else if (session.phase === 'collect_prompts' && now() >= session.promptEndsAt) {
      if (!session.prompts.length) {
        await announce(channel, 'Prompt collection ended with no prompts. Session ended.');
        clearSession(state, session.guildId);
      } else {
        await startVoting(session, channel, state);
      }
    } else if (session.phase === 'vote_prompt' && now() >= session.voteEndsAt) {
      await selectPrompt(session, channel, state);
    } else if (session.phase === 'writing' && now() >= session.turnEndsAt) {
      await advanceTurn(session, channel, state);
    }
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  setInterval(() => tickSessions().catch(() => {}), 60 * 1000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const guildId = interaction.guildId;
  const channel = interaction.channel;
  if (!guildId || !channel) return;
  if (channel.name !== 'fictioncord') {
    await interaction.reply({
      content: 'Please use the `#fictioncord` channel to run Fictioncord commands.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === 'startfictioncord') {
    const state = loadState();
    const existing = getSession(state, guildId);
    if (existing) {
      const leaderId = getLeaderId(existing);
      const currentWriterId = existing.writers[existing.currentWriterIndex];
      const canEnd =
        interaction.user.id === leaderId ||
        (existing.phase === 'writing' && interaction.user.id === currentWriterId);
      const endHint = canEnd
        ? 'You can use /theend to end the current session.'
        : 'If you are the leader or the current writer, you can use /theend to end it.';

      await interaction.reply({
        content:
          `A Fictioncord session is already running (started ${fmtDateTime(existing.startedAt || now())}). ` +
          'You cannot start a new one until it ends.\n' +
          endHint,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content:
        'Starting Fictioncord enrollment...\nYou are the leader of this session. You can use /skipstep to jump to the next step or /theend to end the session at any time.',
      flags: MessageFlags.Ephemeral,
    });
    await openEnrollment(guildId, channel.id, interaction.user.id, channel);
    return;
  }

  if (interaction.commandName === 'joinfictioncord') {
    const state = loadState();
    const session = getSession(state, guildId);
    if (!session) {
      await interaction.reply({ content: 'No active Fictioncord session.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (session.phase !== 'enroll') {
      await interaction.reply({
        content: 'You can’t join right now. Enrollment is closed.\n\n' + buildStatusMessage(session),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.reply({ content: 'Joining enrollment...', flags: MessageFlags.Ephemeral });
    await joinEnrollment(guildId, interaction.user.id, channel);
    return;
  }

  if (interaction.commandName === 'submitprompt') {
    const state = loadState();
    const session = getSession(state, guildId);
    if (!session) {
      await interaction.reply({ content: 'No active Fictioncord session.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (session.phase !== 'collect_prompts') {
      await interaction.reply({
        content: 'You can’t submit prompts right now.\n\n' + buildStatusMessage(session),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const prompt = interaction.options.getString('prompt', true);
    await interaction.reply({ content: 'Submitting prompt...', flags: MessageFlags.Ephemeral });
    await submitPrompt(guildId, interaction.user.id, prompt, channel);
    return;
  }

  if (interaction.commandName === 'submitturn') {
    const state = loadState();
    const session = getSession(state, guildId);
    if (!session) {
      await interaction.reply({ content: 'No active Fictioncord session.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (session.phase !== 'writing') {
      await interaction.reply({
        content: 'You can’t submit a turn right now.\n\n' + buildStatusMessage(session),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const modal = new ModalBuilder()
      .setCustomId('submitturn_modal')
      .setTitle('Submit Your Turn');

    const textInput = new TextInputBuilder()
      .setCustomId('submitturn_text')
      .setLabel('Your story turn')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(1500)
      .setRequired(true);

    const row = new ActionRowBuilder().addComponents(textInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
    return;
  }

  if (interaction.commandName === 'theend') {
    const state = loadState();
    const session = getSession(state, guildId);
    if (!session) {
      await interaction.reply({ content: 'No active Fictioncord session.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: 'Ending session...', flags: MessageFlags.Ephemeral });
    await endSession(guildId, interaction.user.id, channel);
    return;
  }

  if (interaction.commandName === 'skipstep') {
    const state = loadState();
    const session = getSession(state, guildId);
    if (!session) {
      await interaction.reply({ content: 'No active Fictioncord session.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: 'Skipping step...', flags: MessageFlags.Ephemeral });
    await skipStep(guildId, interaction.user.id, channel);
    return;
  }

  if (interaction.commandName === 'resetfictioncord') {
    const state = loadState();
    const session = getSession(state, guildId);
    if (!session) {
      await interaction.reply({ content: 'No active Fictioncord session.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: 'Resetting session...', flags: MessageFlags.Ephemeral });
    await resetSession(guildId, interaction.user.id, isGuildAdmin(interaction), channel);
    return;
  }

  if (interaction.commandName === 'rulesfictioncord') {
    const rules = [
      '**Fictioncord Rules & Flow**',
      '1) **Start (leader)**: /startfictioncord starts the session and makes the user who ran it the leader.',
      '2) **Enrollment (24h)**: Writers join with /joinfictioncord.',
      '3) **Prompts (24h)**: Anyone can submit prompt ideas with /submitprompt. Multiple prompts allowed until the cap.',
      '4) **Voting (24h)**: React on the poll message to vote for the best prompt.',
      '5) **Writing (24h per turn)**: The current writer submits their turn with /submitturn (modal).',
      '',
      '**Leader Role**',
      '- The user who starts the session is the leader.',
      '- Leader can use /skipstep to advance the current step.',
      '- Leader can use /theend to end the session at any time.',
      '',
      '**Ending a Session**',
      '- /theend by the leader or current writer ends the story and posts it in the main channel.',
      '- /resetfictioncord (leader or admin) clears the session if it gets stuck.',
      '',
      '**Threads & Chat**',
      '- The story thread is read-only for users (react only).',
      '- Everyone can comment freely in the main channel.',
      '',
      '**Status**',
      '- Use /statusfictioncord anytime to see the current step and time remaining.',
      '',
      '**Commands**',
      '- /startfictioncord: Start a session and become the leader.',
      '- /joinfictioncord: Join as a writer during enrollment.',
      '- /submitprompt: Submit a prompt idea (during prompt collection).',
      '- /submitturn: Submit your story turn (current writer only).',
      '- /skipstep: Leader-only, skip the current step.',
      '- /theend: End the session (leader or current writer).',
      '- /resetfictioncord: Leader or admin, clear the session.',
      '- /statusfictioncord: Show the current step and time remaining.',
      '- /rulesfictioncord: Show these rules.',
    ].join('\n');

    await interaction.reply({ content: rules, flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === 'statusfictioncord') {
    const state = loadState();
    const session = getSession(state, guildId);
    if (!session) {
      await interaction.reply({ content: 'No active Fictioncord session.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: buildStatusMessage(session), flags: MessageFlags.Ephemeral });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (interaction.customId !== 'submitturn_modal') return;

  const guildId = interaction.guildId;
  const channel = interaction.channel;
  if (!guildId || !channel) return;
  if (channel.name !== 'fictioncord') {
    await interaction.reply({
      content: 'Please use the `#fictioncord` channel to submit your turn.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const state = loadState();
  const session = getSession(state, guildId);
  if (!session || session.phase !== 'writing') {
    await interaction.reply({
      content: 'You can’t submit a turn right now.\n\n' + (session ? buildStatusMessage(session) : ''),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const currentWriterId = session.writers[session.currentWriterIndex];
  if (currentWriterId !== interaction.user.id) {
    await interaction.reply({
      content: `It is not your turn. Current writer is <@${currentWriterId}>.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const text = interaction.fields.getTextInputValue('submitturn_text');
  await interaction.reply({ content: 'Submitting turn...', flags: MessageFlags.Ephemeral });
  await submitTurn(guildId, interaction.user.id, text, channel);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guildId || !message.channel?.isThread?.()) return;

  const state = loadState();
  const session = getSession(state, message.guildId);
  if (!session || !session.threadId) return;
  if (message.channel.id !== session.threadId) return;

  try {
    const original = message.content?.trim() || '(no text)';
    await message.delete();
    const preview = original.length > 800 ? `${original.slice(0, 800)}…` : original;
    await message.author.send(
      'You can’t write in the story thread. Only writers on their turn can add to the story using /submitturn.\n\n' +
        'Your message (copy it):\n' +
        '```\n' +
        preview +
        '\n```'
    );
  } catch {
    // Ignore failures (e.g., missing permissions).
  }
});

client.login(TOKEN);


