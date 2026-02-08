# Fictioncord

A Discord bot that runs collaborative, turn-based story sessions in a server.

## What It Does
A Fictioncord session follows this flow:
1. `/startfictioncord` opens enrollment for 24 hours.
2. Writers join with `/joinfictioncord`.
3. After enrollment, the bot announces the writers in join order.
4. Prompt collection opens for 24 hours via `/submitprompt`.
5. The bot posts all prompts and starts a 24-hour reaction vote.
6. The top-voted prompt is selected.
7. Writer 1 gets 24 hours to submit the first turn with `/submitturn`.
8. Every 24 hours, the bot advances to the next writer.
9. The leader (starter) can end the session at any time with `/theend`, and the bot publishes the story.

## Requirements
- Node.js 18+ recommended
- A Discord application + bot token

## Install
```bash
npm init -y
npm install discord.js dotenv
```

## Environment Variables
Create a `.env` file in the project root with:
```
DISCORD_TOKEN=your-bot-token
DISCORD_CLIENT_ID=your-app-client-id
DISCORD_GUILD_ID=your-test-guild-id
```

## Run
```bash
node index.js
```

## Slash Commands
- `/startfictioncord` Start a session and open enrollment.
- `/joinfictioncord` Join as a writer during enrollment.
- `/submitprompt prompt:"..."` Submit a story prompt (max 300 chars).
- `/submitturn` Submit a story turn via a modal (max 1500 chars, only the current writer).
- `/theend` End the session and post the compiled story (leader or current writer).
- `/skipstep` Leader-only: skip the current step.
- `/resetfictioncord` Leader or server admin: reset and clear the session.
- `/rulesfictioncord` Show the Fictioncord rules and flow.
- `/statusfictioncord` Show current phase and remaining time.

## Permissions Needed
- Send Messages
- Use Slash Commands
- Add Reactions
- Read Message History

## Persistence
Session state is stored in `state.json` in the project root. If the bot restarts, it resumes from this file and continues time-based transitions.

## Limits & Notes
- Prompt voting uses reaction emojis (numbers + symbols), so prompts are capped at 22.
- Anyone can submit prompts. Everyone can submit multiple prompts until the list is full.
- Only the current writer can submit a turn.
- The leader (user who started the session) can end the story at any time.
- The current writer can also end the story with `/theend`.
- The leader or a server admin can reset the session with `/resetfictioncord`.
- When a prompt is selected, the bot creates a story thread and posts all turns there.
- The story thread is locked for messages (read-only), but reactions are allowed.
- Time-based transitions are checked every 60 seconds.

## Files
- `index.js` Bot implementation.
- `state.json` Session state (auto-created).
