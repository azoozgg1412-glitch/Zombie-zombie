# ZOMBIES – online co-op (up to 4 players)

`game.html` is your original game with a multiplayer layer added. `server.js` is a small
WebSocket relay that creates rooms and passes messages. It also serves the game page.
Solo play is unchanged and still works if you open `game.html` directly.

## How it works
* One player is the **host**. Their browser runs the whole game (zombies, rounds, shops, damage).
* Friends join with a 4-letter room code. Their movement is local, so it feels instant. Shooting, buying and
  interacting are sent to the host, which sends back snapshots about 20 times a second.
* Zombies chase the nearest living player. Power-ups are shared. Downed players are revived by a
  teammate holding **E** for 3 seconds, or automatically at the next round (with default loadout and half points).
  When everyone is down it is game over; the host presses Enter to restart.

## Run locally
    npm install
    npm start            # http://localhost:8080
Open the page, click **MULTIPLAYER**, host a game, and have friends join with the code.
Friends on the same Wi-Fi use `http://<your-LAN-IP>:8080`.

## Deploy (public URL)
**Render** (easiest): push this folder to a GitHub repo, then New > Blueprint (it reads `render.yaml`) or
New > Web Service with build `npm install` and start `npm start`. Free instances sleep when idle, so the
first load can take about 30 seconds.
**Railway**: New project from the repo. It detects Node and runs `npm start`.
**Fly.io**: `fly launch` (it uses the included `Dockerfile`), then `fly deploy`.
Any host works as long as it supports WebSockets and sets the `PORT` environment variable. HTTPS pages
automatically use `wss://`.

## Notes
* The host must keep their game tab visible. Browsers throttle hidden tabs, which pauses the game for everyone.
* Late joining is not supported: the room locks once the game starts.
* Multiplayer maps exclude the Expedition (quest) mode.
* If you open `game.html` from disk instead of from the server, the Multiplayer panel asks for the server address.
