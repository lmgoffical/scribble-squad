# 🖍️ Scribble Squad

A multiplayer draw-and-guess party game that runs in the browser, with nothing to download. One person draws and everyone else races to guess the word in chat. Faster guesses earn more points, and a podium leaderboard shows at the end.

## Features
- **Join codes:** 4-letter room codes like `UVMK`
- **QR codes:** scan to join from a phone
- **Share links:** `…/?room=UVMK` fills in the code for you, so you can paste it in Discord
- **Points:** up to ~500 for a fast guess and a bonus for guessing early; the drawer earns points for every correct guess
- **Hints:** letters reveal over time, and you get a "so close!" message when you're one letter off
- **Spoiler-proof chat:** once you guess right, your messages only go to others who already got it
- **Drawing tools:** 20 colors, 4 brush sizes, fill bucket, eraser, undo (Ctrl+Z) and clear
- **End-of-game leaderboard:** podium for the top 3 plus everyone else's rank, with confetti 🎉
- **Host controls:** the host can kick anyone (they can't rejoin that game) or hand the host role to another player with 👑
- **Live drawer cursor:** guessers see the drawer's mouse moving over the board, with their avatar
- **Accounts (optional):** sign up with email and draw your own little avatar; guests get an emoji
- Works on phones, and refreshing the page drops you back into your game

## How it works
- It's a **static site** (`public/`), hosted on **Cloudflare Pages**.
- Multiplayer runs on **Supabase Realtime** channels (broadcast + presence).
- Accounts use **Supabase Auth**. Drawn avatars live in the `player_profiles` table (everyone can read them, and only you can change yours).
- The **host's browser runs the game** (`public/engine.js`): word picking, timers, scoring. If the host leaves, the next player takes over automatically.

Because players' browsers send messages straight to each other, a determined player could peek at the word using dev tools. It's built for playing with friends, not for prize money 😄

## Run it locally
Serve the `public/` folder with any static server, for example:
```bash
npx serve public
```
Open the link it prints. Each browser tab counts as its own player, so you can test with two tabs.

## Deploy
Cloudflare Pages settings:
- Build command: *(none)*
- Build output directory: `public`

## Customize
- **Words:** edit `public/words.js` and add your own inside jokes
- **Supabase project:** `public/config.js` (the publishable key is safe to be public)
- **Max players:** 16 (in `public/engine.js`)
