# Court Piece Online

Play **Court Piece** (also called Rang or Coat Pees, and Hokm in Iran) with friends in the browser, with live camera and microphone.

## The game

| | Court Piece (this app) | Call Break (different game) |
|---|---|---|
| Players | 4, in **2 fixed teams** (partners sit opposite) | 4, everyone plays alone |
| Trump | **Chosen** by the caller after seeing 5 cards | Always spades |
| Deal | 5 → caller picks trump → 4 → 4 (13 each) | 13 each at once |
| Bidding | None | Everyone bids a trick count |
| Win a hand | First team to 7 tricks | Score vs. your bid |

Rules implemented (`server/game.js`):
1. The player after the dealer is the **trump caller**. They get 5 cards and pick trump.
2. The rest of the deck is dealt so everyone ends with 13 cards.
3. The caller leads first. You must follow the led suit if you can; if not, play any card, including a trump.
4. The highest trump wins the trick, otherwise the highest card of the led suit (A high). The winner leads next.
5. The first team to **7 tricks** wins the hand: **1 point**. If the other team took 0 tricks (7 in a row), it's a **Court**: **3 points**.
6. If the caller's team loses, the deal moves one seat on, so the other team calls next.
7. The game is played to a target score (default 7).

House rules differ between families and cities (e.g. playing on for all 13 tricks, "double court", the caller's partner picking trump). The constants at the top of `game.js` make these easy to change.

## Run it

```bash
npm install
npm start          # http://localhost:3000
npm test           # rules, 300 simulated games, socket end-to-end
```

Create a table, share the 5-letter code or invite link, and pick seats (your partner sits opposite you). The host can fill empty seats with **bots** to practise. If someone disconnects, their seat is held; after 30 seconds on their turn, a bot plays for them. If they leave, a bot takes over and a new friend can take that seat.

**Camera and mic need HTTPS** (localhost is exempt). To play with friends right away:

```bash
npx cloudflared tunnel --url http://localhost:3000   # gives you a public https URL
```

## Architecture

```
browser (public/)                      server (server/)
 ├─ app.js  UI, renders server state ─┐   index.js  Express + Socket.IO, input validation
 └─ rtc.js  WebRTC mesh ──────────────┼─▶ rooms.js  seats, host, bots, timers, per-player views
        ▲   audio/video peer-to-peer  │   game.js   pure rules engine (unit tested)
        └─────────────────────────────┘   bot.js    heuristic AI
```

- **The server is authoritative.** Clients send intents (`game:play {card}`). The server validates them, and each player only receives **their own hand**, so cheating by reading network traffic isn't possible.
- **Video/voice is a peer-to-peer mesh.** With at most 4 people that's 3 connections per browser, so media costs the server nothing. The server only relays signalling messages.

## Scaling roadmap

| Stage | What to add |
|---|---|
| Friends (now) | One Node process, any host (Render, Fly.io, Railway, a VPS). Easily handles hundreds of tables. |
| Reliable video | A **TURN server** (coturn, or Cloudflare/Twilio TURN). About 10–20% of users on mobile data or strict NATs can't connect without one. Set `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL`. |
| Many servers | Move room state to **Redis**, use the `@socket.io/redis-adapter`, and route sticky sessions by room code. |
| Accounts & stats | Login (OAuth), a Postgres database for users, match history, leaderboards and friends lists. |
| Spectators / 4+ video | Switch from mesh to an **SFU** (LiveKit or mediasoup). |
| Mobile apps | Wrap the same web app (Capacitor) or reuse the server with React Native. |

Known gaps for a public launch: `playerId` is an unauthenticated browser token, so it needs real auth; there's no turn timer for connected players; there's no rate limiting; there's no text chat.
