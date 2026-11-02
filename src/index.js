/**
 * エントリーポイント: クラウド完全対応 (Render / Koyeb / Railway / Fly.io 無料枠対応)
 * Discord Bot + Web UI サーバーの同時起動
 */

require('dotenv').config();
const { createBotClient, setupBot, generateBotInviteUrl } = require('./bot');
const { createWebServer } = require('./server');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// クラウド環境変数 (Render / Koyeb / Railway) から自動的に公開URLを検出
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
  const botClient = createBotClient();

  await setupBot(botClient, {
    token: DISCORD_TOKEN,
    clientId: DISCORD_CLIENT_ID,
    guildId: DISCORD_GUILD_ID,
    publicUrl: detectedCloudUrl,
  });

  const app = createWebServer(botClient, {
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

  // クラウド環境で稼働中かつ KEEP_ALIVE_URL または RENDER_EXTERNAL_URL がある場合、14分おきにヘルスチェックを実行
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
      console.error('❌ Discord Bot ログイン失敗 (環境変数 DISCORD_TOKEN を確認してください):', err.message);
      console.log('💡 Web UI はデモモードとして引き続き利用可能です。');
    }
  } else {
    console.log(
      'ℹ️ 環境変数 DISCORD_TOKEN が未設定のため、Web UI のみ（デモ＆手動モード）で起動しています。'
    );
  }
}

main();
