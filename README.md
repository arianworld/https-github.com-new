# Open World Motorcycle Simulator — Multiplayer starter

## Included
- `public/index.html`: original Three.js game preserved, with an additive multiplayer overlay and remote-bike rendering bridge.
- `server.js`: Node.js + Socket.IO server, SQLite accounts/friends, public/private rooms, room chat, invites, room ownership handoff and LAN binding.
- `package.json`: dependencies and run scripts.
- `data.sqlite`: created automatically on first server start.

## Run on a computer
1. Install Node.js 18 or newer.
2. Extract this folder.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:3000` in the browser.

The original game is served at `/` from `public/index.html`.

## Run on a Wi-Fi LAN
1. Connect host and player devices to the same Wi-Fi network.
2. Start the server on the host computer with `npm start`.
3. Read the LAN address printed in the terminal, e.g. `http://192.168.1.20:3000`.
4. Open that address on every phone/computer. The multiplayer panel uses the same origin by default.
5. If a firewall asks, allow Node.js on the private network.

A browser-only HTML file cannot host a LAN server. At least one device must run Node.js. Android can host Node.js through a suitable terminal environment, but computer hosting is easier and more reliable.

## Publish online
Deploy this Node.js folder to a host that supports persistent Node processes and WebSockets. Set:
- `PORT` (usually supplied by the platform)
- `TOKEN_SECRET` to a long random secret
- `CORS_ORIGIN` to your game's trusted origin

Use HTTPS/WSS in production. Keep `data.sqlite` on persistent storage; ephemeral deployment filesystems can erase accounts. For multiple server instances, replace in-memory rooms/presence with Redis or a shared adapter and shared database.

## Use
1. Open the Multiplayer panel.
2. Enter a username and password (password must be at least 8 characters), then create an account or log in.
3. Create a public room, or create a private room with a password of at least 4 characters.
4. Join using the room ID and password if required.
5. Other players in the same room appear as remote motorcycles in the 3D world.

## Important current limitations (honest status)
This is a functional first multiplayer layer, not yet a complete commercial-grade multiplayer game:
- Real-time remote bike positions, room membership, account registration/login, public/private room access, room chat, friends list/add, and host handoff are implemented.
- Friend invitations are sent to online users, but the current panel does not yet expose a full friend search/invite workflow.
- Race countdown exists; authoritative finish-line timing, spectator camera, moderation UI, private-message UI, and full profanity moderation are not complete.
- Movement validation is basic server-side sanity checking, not authoritative server physics or a robust anti-cheat system. Client-side physics remains authoritative for the local bike.
- The game still uses localStorage for existing single-player money/garage progress; this starter does not sync purchases or currency to the server.
- LAN operation is implemented through the same Node.js server listening on `0.0.0.0`; no server can be provided by a standalone HTML file.
- Reconnection restores the account session when the client reconnects, but automatic rejoining the previous room is not yet implemented.
- This environment cannot run two real networked browser clients or deploy a public server, so live multiplayer/LAN behavior has not been end-to-end certified.

## Security
Use a unique strong password and set `TOKEN_SECRET` before public deployment. The default token secret is only for local testing. Do not expose the SQLite database publicly. Add HTTPS, rate limiting, stronger session storage, input moderation, and server-authoritative simulation before opening a public competitive server.
