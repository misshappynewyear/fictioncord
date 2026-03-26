# Fictioncord

A Discord bot that runs collaborative, turn-based story sessions in a server.

## What It Does
A Fictioncord session follows this flow:

1. `/startfictioncord` opens writer enrollment for 24 hours.
2. Writers join with `/joinfictioncord`.
3. After enrollment closes, the bot announces the writers in join order.
4. Prompt collection opens for 24 hours via `/submitprompt`.
5. **Anyone in the server can submit prompts.**
6. The bot posts all prompts and starts a 24-hour reaction vote.
7. The top-voted prompt is selected.
8. The bot creates a story thread for the selected prompt.
9. Writer 1 gets 24 hours to submit the first turn with `/submitturn`.
10. Each next writer gets 24 hours for their turn.
11. The current writer can skip their own turn with `/skipmyturn`.
12. The leader can skip the current phase with `/skipstep`.
13. The leader or the current writer can end the session with `/theend`.
14. When the session ends, the bot posts the story thread link in the main channel.

## Requirements
- Node.js 18+ recommended
- A Discord application + bot token

## Install
```bash
npm init -y
npm install discord.js dotenv
```

## Environment Variables
Create a `.env` file in the project root:

```env
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-app-client-id
DISCORD_GUILD_ID=your-test-guild-id
```

Optional variables:

```env
DISCORD_GUILD_IDS=guild_id_1,guild_id_2
DISCORD_BACKUP_CHANNEL_ID=channel-id-for-state-backups
PORT=10000
```

## Run
```bash
node index.js
```

## Slash Commands
- `/startfictioncord`
- `/joinfictioncord`
- `/submitprompt`
- `/submitturn`
- `/skipmyturn`
- `/theend`
- `/skipstep`
- `/resetfictioncord`
- `/rulesfictioncord`
- `/statusfictioncord`

## Notes
- Prompt limit: 11
- Anyone can submit prompts
- Only current writer can submit turns
- Thread is read-only for users
