/**
 * Web UI 用 Express サーバー & REST API
 * - `/healthz`: Render / Koyeb 等のクラウドヘルスチェック＆スリープ防止用エンドポイント
 * - `/invite`: 普通のDiscordアプリと同様にサーバーへワンクリック導入できる OAuth2 リダイレクト
 * - Discord Bot とリアルタイム連携し、サーバー一覧・VC一覧・VC内メンバーを自動取得
 * - Web UI からの読み上げBot操作・テキスト読み上げ送信にも対応
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const { ChannelType, EmbedBuilder } = require('discord.js');
const { PRESETS, splitMembers } = require('./splitter');
const { extractVcMembers, executeTeamMove, generateBotInviteUrl } = require('./bot');
const { VOICE_PRESETS, ttsSessions, joinVcForTts, sanitizeTextForTts } = require('./tts');

function resolveClient(botClientOrHolder) {
  if (!botClientOrHolder) return null;
  return botClientOrHolder.client ? botClientOrHolder.client : botClientOrHolder;
}

function createWebServer(botClientOrHolder, config = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/healthz', (req, res) => {
    const botClient = resolveClient(botClientOrHolder);
    res.status(200).json({
      ok: true,
      botReady: Boolean(botClient && botClient.isReady()),
      messageContentEnabled: Boolean(botClient && botClient.messageContentEnabled),
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/invite', (req, res) => {
    const botClient = resolveClient(botClientOrHolder);
    const clientId =
      req.query.clientId ||
      config.clientId ||
      (botClient && botClient.user ? botClient.user.id : null);
    const inviteUrl = generateBotInviteUrl(clientId);

    if (!inviteUrl) {
      return res.redirect('/?openInviteModal=1');
    }
    return res.redirect(inviteUrl);
  });

  app.get('/api/status', (req, res) => {
    const botClient = resolveClient(botClientOrHolder);
    const isReady = Boolean(botClient && botClient.isReady());
    const resolvedClientId =
      config.clientId || (isReady && botClient.user ? botClient.user.id : null);
    const inviteUrl = generateBotInviteUrl(resolvedClientId);

    const guilds = isReady
      ? botClient.guilds.cache.map((g) => ({
          id: g.id,
          name: g.name,
          iconUrl: g.iconURL({ extension: 'png', size: 64 }),
          memberCount: g.memberCount,
        }))
      : [];

    res.json({
      botReady: isReady,
      botTag: isReady ? botClient.user.tag : null,
      messageContentEnabled: Boolean(botClient && botClient.messageContentEnabled),
      clientId: resolvedClientId,
      inviteUrl,
      guilds,
      presets: PRESETS,
      voices: VOICE_PRESETS,
    });
  });

  app.get('/api/guilds/:guildId/vcs', async (req, res) => {
    try {
      const botClient = resolveClient(botClientOrHolder);
      if (!botClient || !botClient.isReady()) {
        return res.status(503).json({
          error: 'Discord Bot が未接続です（デモモードで動作中）',
        });
      }

      const guild = botClient.guilds.cache.get(req.params.guildId);
      if (!guild) {
        return res.status(404).json({ error: '指定されたサーバーが見つかりません' });
      }

      const includeBots = req.query.includeBots === 'true';
      const voiceChannels = guild.channels.cache
        .filter(
          (c) =>
            c.type === ChannelType.GuildVoice ||
            c.type === ChannelType.GuildStageVoice
        )
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((vc) => {
          const members = extractVcMembers(vc, includeBots);
          return {
            id: vc.id,
            name: vc.name,
            parentName: vc.parent ? vc.parent.name : null,
            memberCount: members.length,
            members,
          };
        });

      const textChannels = guild.channels.cache
        .filter((c) => c.type === ChannelType.GuildText)
        .sort((a, b) => a.rawPosition - b.rawPosition)
        .map((tc) => ({
          id: tc.id,
          name: tc.name,
        }));

      const activeTts = ttsSessions.get(guild.id);

      res.json({
        guildId: guild.id,
        guildName: guild.name,
        voiceChannels,
        textChannels,
        ttsStatus: activeTts
          ? {
              connected: true,
              vcId: activeTts.vcId,
              vcName: activeTts.vcName,
              defaultVoice: activeTts.defaultVoice,
            }
          : { connected: false },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/split', (req, res) => {
    try {
      const { members = [], options = {} } = req.body;
      const result = splitMembers(members, options);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/guilds/:guildId/move', async (req, res) => {
    try {
      const botClient = resolveClient(botClientOrHolder);
      if (!botClient || !botClient.isReady()) {
        return res.status(503).json({
          error: 'Discord Bot が未接続のため、実際のVC移動はBot起動時に利用可能です。',
        });
      }

      const guild = botClient.guilds.cache.get(req.params.guildId);
      if (!guild) {
        return res.status(404).json({ error: '指定されたサーバーが見つかりません' });
      }

      const { teams = [], moveTargets = {} } = req.body;
      const { movedReport, errors } = await executeTeamMove(
        guild,
        teams,
        moveTargets
      );

      res.json({
        success: true,
        movedReport,
        errors,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Web UI から読み上げBotの参加・退出・発話を操作するエンドポイント
  app.post('/api/guilds/:guildId/tts', async (req, res) => {
    try {
      const botClient = resolveClient(botClientOrHolder);
      if (!botClient || !botClient.isReady()) {
        return res.status(503).json({ error: 'Discord Bot が未接続です' });
      }
      const guild = botClient.guilds.cache.get(req.params.guildId);
      if (!guild) {
        return res.status(404).json({ error: 'サーバーが見つかりません' });
      }

      const { action, vcId, voiceId = 'zunda_normal', text } = req.body;

      if (action === 'leave') {
        const existing = ttsSessions.get(guild.id);
        if (existing) existing.destroy();
        return res.json({ success: true, connected: false });
      }

      let session = ttsSessions.get(guild.id);
      if (action === 'join' || (!session && vcId)) {
        const vc = guild.channels.cache.get(vcId);
        if (!vc) return res.status(400).json({ error: 'VCチャンネルが見つかりません' });
        session = joinVcForTts(guild, vc, vc.id, voiceId);
      }

      if (session && voiceId && VOICE_PRESETS[voiceId]) {
        session.defaultVoice = voiceId;
      }

      if (session && text) {
        session.enqueue(sanitizeTextForTts(text, guild), voiceId || session.defaultVoice);
      }

      return res.json({
        success: true,
        connected: Boolean(session),
        vcId: session?.vcId,
        vcName: session?.vcName,
        defaultVoice: session?.defaultVoice,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/guilds/:guildId/announce', async (req, res) => {
    try {
      const botClient = resolveClient(botClientOrHolder);
      if (!botClient || !botClient.isReady()) {
        return res.status(503).json({
          error: 'Discord Bot が未接続です。',
        });
      }

      const guild = botClient.guilds.cache.get(req.params.guildId);
      if (!guild) {
        return res.status(404).json({ error: 'サーバーが見つかりません' });
      }

      const { channelId, vcName, result } = req.body;
      const targetChannel = guild.channels.cache.get(channelId);
      if (!targetChannel || !targetChannel.isTextBased()) {
        return res.status(400).json({ error: '送信先チャンネルが見つかりません' });
      }

      const embed = new EmbedBuilder()
        .setColor(0xff4655)
        .setTitle(`🎲 VCチーム抽選結果 (Web UI) — 🔊 ${vcName || 'VC'}`)
        .setTimestamp(new Date());

      (result.teams || []).forEach((team, idx) => {
        const badge = team.isRemainder ? '🔸' : idx === 0 ? '🏆' : '🔹';
        const lines =
          team.members.length > 0
            ? team.members
                .map((m, i) => {
                  const star = m.isPriority ? ' ⭐' : '';
                  return m.id && !String(m.id).startsWith('demo_')
                    ? `\`${i + 1}.\` <@${m.id}> (${m.displayName})${star}`
                    : `\`${i + 1}.\` ${m.displayName}${star}`;
                })
                .join('\n')
            : '*(なし)*';
        embed.addFields({
          name: `${badge} ${team.name}`,
          value: lines,
          inline: true,
        });
      });

      if (result.excludedMembers && result.excludedMembers.length > 0) {
        embed.addFields({
          name: `👀 観戦・抽選除外枠 (${result.excludedMembers.length}人)`,
          value: result.excludedMembers.map((m) => m.displayName).join(' / '),
          inline: false,
        });
      }

      await targetChannel.send({ embeds: [embed] });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

module.exports = { createWebServer };
