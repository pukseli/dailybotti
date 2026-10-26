# Daily games bot

A Telegram bot for a group that plays [Eraly](https://eraly.io/), [Krillion](https://krillion.io/) and [Size It Up](https://magnitudle.com/size-it-up) every day.

- Players **paste their results in the group**, or **send them to the bot privately** if they'd rather keep their score to themselves until the podium.
- Group pastes get a 👍 reaction instead of a reply, so the bot doesn't fill the chat with its own messages.
- The group gets one **board** per day, edited in place, showing who has played (✅). The board shows no scores.
- When the day closes (midnight by default), the bot posts the **podiums**: one per game plus an overall one.
- `/leaderboard` shows all-time medals and averages. `/me` shows your own stats.

It runs on Cloudflare Workers with a D1 database, which fits well within the free plan.

## Deploy (about 15 minutes)

You need [Node.js](https://nodejs.org/) 20 or newer and a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

### 1. Create the Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Pick a name and a username (must end in `bot`).
3. Copy the **token** it gives you (looks like `123456789:AA...`). Keep it secret.

### 2. Set up the project

In a terminal, inside this folder:

```sh
npm install
npx wrangler login
```

`wrangler login` opens a browser window to connect to your Cloudflare account.

**Timezone:** the group's timezone is set in `wrangler.jsonc` as `"TIMEZONE": "Europe/Helsinki"`. Change it if your group is elsewhere, e.g. `"Europe/Stockholm"` or `"America/New_York"`. `CLOSE_TIME` is when results close and podiums are posted. `"00:00"` means midnight; `"22:00"` would close at 10 pm.

### 3. Create the database

```sh
npx wrangler d1 create daily-games-bot
```

It prints a `database_id`. Open `wrangler.jsonc` and replace `REPLACE_WITH_YOUR_DATABASE_ID` with it. Then create the tables (answer **yes** when asked):

```sh
npx wrangler d1 migrations apply daily-games-bot --remote
```

### 4. Deploy

```sh
npx wrangler deploy
```

If this is your first Worker, Wrangler asks you to choose a `workers.dev` subdomain. At the end it prints your bot's address, like `https://daily-games-bot.<your-subdomain>.workers.dev`.

### 5. Add the secrets

Make a random webhook secret:

```sh
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Then store both secrets (each command asks you to paste the value):

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
```

### 6. Connect the bot to Telegram

Open this in a browser, using your address and your webhook secret:

```
https://daily-games-bot.<your-subdomain>.workers.dev/init?secret=<your webhook secret>
```

Every line should start with ✅. If one starts with ❌, it says what to fix.

You only need this page once, when setting up a new bot. After later deploys, the bot updates Telegram's command menus by itself within a minute.

### 7. Add the bot to the group

1. Add the bot to your Telegram group.
2. Make it an **admin**. It doesn't need any special rights, so you can untick them all. Telegram only lets a bot see ordinary group messages, like pasted results, when it's an admin.
3. In the group, send `/setup`. It must be sent by a group admin. If the bot still can't see group messages, its reply says so.

### 8. Tell everyone

At the end of each game, tap **Share**, then either:

- **paste it in the group.** The bot reacts with 👍 when it's saved, and replies only if something couldn't be counted, or
- **send it to the bot privately.** Open the bot once and press **Start** first. The bot replies with what it saved and which games you still have left.

On a phone, Share opens the share menu, so you can pick Telegram and then the group or the bot. On a computer, Share copies the result for you to paste. All three results can go in one message.

## Rules the bot follows

- Only the **daily** puzzles count. Unlimited, archive, themed, Pop Culture and Geography modes are refused.
- Only the **first** result for each game and day counts.
- Eraly and Krillion results are filed by their puzzle number. Size It Up's share text has no number, so it counts for the day the bot receives it. Send it before the day closes.
- Krillion's new puzzle appears at midnight New York time (7 am in Finland, 6 am in most of Europe). Before that, the playable Krillion is still the previous day's, which has already closed.
- **Overall score:** each game is converted to a percentage of its maximum (Eraly 700, Krillion 700, Size It Up 500) and the three are added up, out of 300. On a day with an imitation contest it counts as a fourth event, out of 400. A game you skip counts as 0.
- Ties share a place: two 🥇 and then a 🥉.
- Results must come from members of the linked group.

## Imitation contest

1. **The draw:** at 09:00 the bot draws a character or person from the group's suggestions (`/ehdota Mikki Hiiri`) and announces it in the group. A suggestion is only ever drawn once. If the list has run out, the bot says so once and there's no contest that day.
2. **Recordings:** players post their imitation in the group as a voice message (an audio file or round video works too) by 21:00. The bot reacts 👏. If someone posts again, the latest recording counts.
3. **The vote:** as soon as every player has sent one, or at 21:00 at the latest, each player gets a private ballot from the bot. They pick the best (3 points) and the runner-up (1 point), and can't pick themselves. Players who didn't record can still vote. A progress message in the group shows who has voted. The vote needs at least two recordings, otherwise the contest is called off for the day.
4. **Results:** when everyone has voted, the bot posts the imitation results. Otherwise the vote ends when the day closes. The imitation then counts in the day's overall score as **points received ÷ the most possible × 100**. The most possible is 3 points from every ballot cast by someone else, so a player who didn't vote doesn't lower anyone's maximum.

The early podium (posted when everyone has played everything) waits for the vote. The times are `CHALLENGE_TIME` and `VOTE_DEADLINE` in `src/imitation.ts`.

## Commands

| Command | Where | What it does |
|---|---|---|
| `/start`, `/help` | both | How to take part, the rules, the commands and the group setup steps (in Finnish). Works in a group before `/setup` too |
| `/today` | both | Today's board. In the group it moves the board to the bottom of the chat |
| `/me` | both | Your medals, averages and bests |
| `/leaderboard` | both | All-time standings |
| `/name New name` (or `/nimi`) | both | Changes your name on the board, podiums, leaderboard and stats. `/name reset` goes back to your Telegram name. Available after your first result |
| `/haaste` | both | Today's imitation character, who has sent a recording, and how the vote is going |
| `/ehdota Nimi` | both | Adds a character or person to the imitation draw |
| `/ehdotukset` | both | Lists the suggestions still in the draw |
| `/aanesta` | private | Sends you a new imitation ballot, e.g. if the first one couldn't be delivered |
| `/setup` | group | Links the bot to the group (admins only) |

## Maintenance

- **Deploys are automatic:** every push to `main` runs `.github/workflows/deploy.yml`. It type-checks, runs the tests, applies any new database migrations, then deploys. It uses the repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. To redeploy without a push, open Actions → Deploy to Cloudflare Workers → Run workflow.
- **Command menus:** the commands Telegram suggests when you type `/` are listed in `src/commands.ts`. After a deploy that changes them, the bot sends the new menus to Telegram within a minute.
- **Logs:** `npx wrangler tail` streams live logs. Logs are also in the Cloudflare dashboard under Workers → daily-games-bot → Logs.
- **Change settings:** edit `wrangler.jsonc`, then run `npx wrangler deploy`.
- **Move the bot to another group:**
  `npx wrangler d1 execute daily-games-bot --remote --command "DELETE FROM settings WHERE key IN ('group_chat_id', 'group_thread_id')"`, then `/setup` in the new group.
- **Tests:** `npm test` runs the test suite locally.

## Costs

Everything here fits in Cloudflare's free plan: about 1,500 requests a day (one per minute for the scheduler plus the group's messages) against a limit of 100,000, and a tiny database. If the free plan ever changes, the paid plan is $5/month.
