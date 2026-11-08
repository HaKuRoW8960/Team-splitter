/**
 * エントリーポイント: クラウド完全対応 (Render / Koyeb / Railway / Fly.io 無料枠対応)
 * Discord Bot (VCチーム抽選 ＋ ずんだもん・ゆっくりボイス読み上げ) + Web UI サーバーの同時起動
 */

require('dotenv').config();
const { createBotClient, setupBot, generateBotInviteUrl } = require('./bot');
const { createWebServer } = require('./server');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const detectedCloudUrl =
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.KOYEB_PUBLIC_DOMAIN ? `https://${process.env.KOYEB_PUBLIC_DOMAIN}` : null) ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
  `http://localhost:${PORT}`;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;

async function main() {
  let botClient = createBotClient(true);
  const botHolder = {
    get client() {
      return botClient;
    },
  };

  await setupBot(botClient, {
    token: DISCORD_TOKEN,
    clientId: DISCORD_CLIENT_ID,
    guildId: DISCORD_GUILD_ID,
    publicUrl: detectedCloudUrl,
  });

  const app = createWebServer(botHolder, {
    publicUrl: detectedCloudUrl,
    clientId: DISCORD_CLIENT_ID,
  });

  app.listen(PORT, HOST, () => {
    console.log('====================================================');
    console.log(`🌐 クラウド Web UI サーバー起動: ${detectedCloudUrl}`);
    console.log(`❤️ ヘルスチェックURL: ${detectedCloudUrl}/healthz`);
    const inviteUrl = generateBotInviteUrl(DISCORD_CLIENT_ID);
    if (inviteUrl) {
      console.log(`➕ Discordサーバー導入URL: ${detectedCloudUrl}/invite`);
    }
    console.log('====================================================');
  });

  const keepAliveTarget = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (keepAliveTarget && keepAliveTarget.startsWith('http')) {
    setInterval(() => {
      fetch(`${keepAliveTarget.replace(/\/$/, '')}/healthz`).catch(() => {});
    }, 14 * 60 * 1000).unref();
  }

  if (DISCORD_TOKEN && DISCORD_TOKEN !== 'your_discord_bot_token_here') {
    try {
      await botClient.login(DISCORD_TOKEN);
    } catch (err) {
      // もし Discord Developer Portal で MESSAGE CONTENT INTENT がまだ ON になっていない場合は自動でフォールバックして起動を維持
      if (String(err.message || '').includes('DisallowedIntents')) {
        console.warn(
          '⚠️ MESSAGE CONTENT INTENT が Developer Portal で未有効のため、フォールバックモードでログインします。'
        );
        try {
          botClient.destroy();
        } catch (_) {}
        botClient = createBotClient(false);
        await setupBot(botClient, {
          token: DISCORD_TOKEN,
          clientId: DISCORD_CLIENT_ID,
          guildId: DISCORD_GUILD_ID,
          publicUrl: detectedCloudUrl,
        });
        await botClient.login(DISCORD_TOKEN);
      } else {
        console.error('❌ Discord Bot ログイン失敗:', err.message);
      }
    }
  } else {
    console.log(
      'ℹ️ 環境変数 DISCORD_TOKEN が未設定のため、Web UI のみ（デモ＆手動モード）で起動しています。'
    );
  }
}

main();
