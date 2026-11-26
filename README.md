# Cloud Mail MCP edge-c5f1b7e — Node.js bundle

Ready to run on any host with **Node.js 22.15+** and a **PostgreSQL 13+** database.
No `npm install` or build step is needed.

1. Put this folder on the server (or deploy the `dist` branch of the repository).
2. Start it with `node server.mjs` (or `npm start`). It listens on port 8787 (set `PORT` to change it).
3. Open the site. The first screen asks for your PostgreSQL connection and a setup code
   (in `~/cloud-mail-mcp-data/setup-code.txt` or the app log), then the setup wizard runs.

Your data, encryption key and saved database connection live in `~/cloud-mail-mcp-data`,
outside this folder, so replacing this folder with a new version keeps everything.
**Back up `~/cloud-mail-mcp-data/master.key`.**

Guides: https://github.com/Cloud-Mail-Mcp/cloud-mail-mcp/tree/main/docs/install
