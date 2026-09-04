import { createServer } from "node:http";

import { DiscordSupportBot } from "./bot.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig(process.env);
const bot = new DiscordSupportBot(config);

const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  const healthy = bot.healthy();
  response.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: healthy }));
});

server.listen(config.PORT, "0.0.0.0");

async function shutdown(signal: string) {
  console.info("discord_support_stopping", { signal });
  server.close();
  await bot.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await bot.start();
