/**
 * Discord Bot 実装 (discord.js v14)
 * 1. VCメンバー自動認識 ＆ チーム振り分け (`/team`)
 *    - 準備画面表示 ➔ ⭐フルパ確定枠・👀除外枠プルダウン選択 ➔ 「🎲 チーム振り分け」で抽選
 *    - 「🔊 別のVCへ移動...」確認ポップアップ＆自動VC移動
 * 2. VCテキストチャット自動読み上げBot機能 (`/join`, `/leave`, `/voice`, `/say`)
 *    - ずんだもん（ノーマル・あまあま・ツンツン・ささやき）、ゆっくりボイス（霊夢風・魔理沙風）、四国めたん、春日部つむぎ等に対応
 *    - VCのチャット欄に入力されたテキストを自動認識してボイス再生
 */

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { PRESETS, splitMembers, parseCustomSizes } = require('./splitter');
const {
  VOICE_PRESETS,
  ttsSessions,
  userVoicePrefs,
  sanitizeTextForTts,
  joinVcForTts,
} = require('./tts');

// セッション状態を保持するインメモリストア (sessionId -> state)
const sessions = new Map();

// 古いセッションの定期クリーンアップ（6時間経過分を削除）
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [key, val] of sessions.entries()) {
    if (val.createdAt && val.createdAt < cutoff) {
      sessions.delete(key);
    }
  }
}, 30 * 60 * 1000).unref();

function createBotClient(enableMessageContent = true) {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
  ];
  if (enableMessageContent) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  const client = new Client({ intents });
  client.messageContentEnabled = enableMessageContent;
  return client;
}

/**
 * 普通のDiscordアプリとしてワンクリック導入できる OAuth2 招待URLを生成する
 */
function generateBotInviteUrl(clientId) {
  if (!clientId || clientId === 'your_discord_client_id_here') return null;
  const permissions =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.SendMessages |
    PermissionFlagsBits.Connect |
    PermissionFlagsBits.Speak |
    PermissionFlagsBits.MoveMembers;

  return (
    `https://discord.com/oauth2/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&permissions=${permissions.toString()}` +
    `&scope=${encodeURIComponent('bot applications.commands')}`
  );
}

/**
 * スラッシュコマンド定義 (`/team`, `/join`, `/leave`, `/voice`, `/say`)
 */
function getSlashCommands() {
  const voiceChoices = Object.values(VOICE_PRESETS).map((v) => ({
    name: `${v.emoji} ${v.name}`,
    value: v.id,
  }));

  const teamCommand = new SlashCommandBuilder()
    .setName('team')
    .setDescription('VCに入っているメンバーを自動認識し、確定枠や除外枠を選んでチーム振り分けを行います')
    .addStringOption((opt) =>
      opt
        .setName('preset')
        .setDescription('プリセットを選択（省略時は Valorant 5人優先）')
        .setRequired(false)
        .addChoices(
          { name: '🎯 Valorant フルパ優先 (5人優先＋残り)', value: 'valo_5' },
          { name: '🔫 Valorant 1組だけ5人抽選 (5人×1＋残り全員)', value: 'valo_single_5' },
          { name: '⚔️ Valorant カスタム (5 vs 5 ＋ 観戦)', value: 'valo_custom_10' },
          { name: '🛡️ Apex / トリオ優先 (3人優先＋残り)', value: 'apex_3' },
          { name: '🍀 4人スクワッド優先 (4人優先＋残り)', value: 'quad_4' },
          { name: '👥 デュオ優先 (2人優先＋残り)', value: 'duo_2' },
          { name: '⚖️ 2グループ均等分け', value: 'equal_2' },
          { name: '📐 3グループ均等分け', value: 'equal_3' }
        )
    )
    .addIntegerOption((opt) =>
      opt
        .setName('priority_size')
        .setDescription('何人チームを優先して作るか任意指定（例: 5 と入力すると5人パ優先）')
        .setMinValue(1)
        .setMaxValue(25)
        .setRequired(false)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('group_count')
        .setDescription('何グループに均等分けするか任意指定（例: 2 と入力すると2チームに均等分け）')
        .setMinValue(2)
        .setMaxValue(15)
        .setRequired(false)
    )
    .addStringOption((opt) =>
      opt
        .setName('custom_sizes')
        .setDescription('各グループの人数をカンマ区切りで直接指定（例: 5,2 や 5,3,2）')
        .setRequired(false)
    )
    .addChannelOption((opt) =>
      opt
        .setName('vc_channel')
        .setDescription('対象のVCチャンネル（省略時はあなたが現在入っているVCを自動認識）')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('include_bots')
        .setDescription('VC内のBotも抽選対象に含めるか（テスト用・デフォルトはfalse）')
        .setRequired(false)
    );

  const joinCommand = new SlashCommandBuilder()
    .setName('join')
    .setDescription('VCに参加して、VCチャット欄に入力された文字をずんだもんやゆっくりボイスで読み上げます')
    .addStringOption((opt) =>
      opt
        .setName('voice')
        .setDescription('読み上げボイスを選択（デフォルト: ずんだもん ノーマル）')
        .setRequired(false)
        .addChoices(...voiceChoices)
    )
    .addChannelOption((opt) =>
      opt
        .setName('vc_channel')
        .setDescription('参加するVCチャンネル（省略時はあなたが現在入っているVC）')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
        .setRequired(false)
    );

  const leaveCommand = new SlashCommandBuilder()
    .setName('leave')
    .setDescription('読み上げBotをVCから退出させます');

  const voiceCommand = new SlashCommandBuilder()
    .setName('voice')
    .setDescription('読み上げの声（ずんだもん・ゆっくりボイス等）を変更します')
    .addStringOption((opt) =>
      opt
        .setName('voice')
        .setDescription('変更するボイスを選択')
        .setRequired(true)
        .addChoices(...voiceChoices)
    )
    .addStringOption((opt) =>
      opt
        .setName('target')
        .setDescription('自分の声だけ変えるか、サーバー全体のデフォルトを変えるか（省略時は自分の声）')
        .setRequired(false)
        .addChoices(
          { name: '👤 自分の発言の声だけ変更する', value: 'user' },
          { name: '🌐 サーバー全体のデフォルト声として変更する', value: 'guild' }
        )
    );

  const sayCommand = new SlashCommandBuilder()
    .setName('say')
    .setDescription('指定したテキストをVCで今すぐ読み上げます')
    .addStringOption((opt) =>
      opt.setName('text').setDescription('読み上げる文章').setRequired(true)
    )
    .addStringOption((opt) =>
      opt
        .setName('voice')
        .setDescription('声の指定（省略時は現在の設定）')
        .setRequired(false)
        .addChoices(...voiceChoices)
    );

  return [
    teamCommand.toJSON(),
    joinCommand.toJSON(),
    leaveCommand.toJSON(),
    voiceCommand.toJSON(),
    sayCommand.toJSON(),
  ];
}

/**
 * VCチャンネルからメンバー一覧を取得する
 */
function extractVcMembers(vcChannel, includeBots = false) {
  if (!vcChannel || !vcChannel.members) return [];
  const list = [];
  vcChannel.members.forEach((member) => {
    if (!includeBots && member.user.bot) return;
    list.push({
      id: member.id,
      displayName: member.displayName || member.user.username,
      username: member.user.username,
      avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 128 }),
      isBot: member.user.bot,
    });
  });
  return list;
}

/**
 * 読み上げBotコントロールパネルの Embed & Components を構築する
 */
function buildTtsControlPayload(ttsSession, messageContentEnabled = true, clientId = '') {
  const voicePreset = VOICE_PRESETS[ttsSession.defaultVoice] || VOICE_PRESETS.zunda_normal;

  let desc =
    `**接続中のVC:** 🔊 **${ttsSession.vcName}**\n` +
    `**現在のデフォルト声:** ${voicePreset.emoji} **${voicePreset.name}**\n` +
    `**発言者名の読み上げ:** ${ttsSession.readSpeakerName ? '⭕ ON' : '✖ OFF'}\n\n` +
    `💬 **🔊 ${ttsSession.vcName} のVCチャット欄**（またはこのチャンネル）に文字を入力すると自動で読み上げます！\n` +
    `💡 \`/voice\` コマンドで人ごとに別々の声（ずんだもん・ゆっくり等）を設定することも可能です。`;

  if (!messageContentEnabled) {
    const portalUrl = clientId
      ? `https://discord.com/developers/applications/${clientId}/bot`
      : 'https://discord.com/developers/applications';
    desc +=
      `\n\n⚠️ **【重要】通常のチャット入力を自動認識するための設定**\n` +
      `[Discord Developer Portal の Bot 設定画面](${portalUrl}) を開き、**「MESSAGE CONTENT INTENT」** を **ON** にして保存してください（ONにする前でも \`/say 文章\` で読み上げ可能です）。`;
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🗣️ ずんだもん＆ゆっくり 読み上げBot 稼働中！`)
    .setDescription(desc);

  const voiceSelect = new StringSelectMenuBuilder()
    .setCustomId(`ttsvoice_${ttsSession.guildId}`)
    .setPlaceholder('🎙️ 読み上げボイス（ずんだもん・ゆっくり等）を切り替え...')
    .addOptions(
      Object.values(VOICE_PRESETS).map((v) => ({
        label: v.name,
        description: v.description.slice(0, 95),
        value: v.id,
        emoji: v.emoji,
        default: ttsSession.defaultVoice === v.id,
      }))
    );

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ttsskip_${ttsSession.guildId}`)
      .setLabel('読み上げスキップ')
      .setEmoji('🔇')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ttsname_${ttsSession.guildId}`)
      .setLabel(ttsSession.readSpeakerName ? '名前読み上げ: ON' : '名前読み上げ: OFF')
      .setEmoji('👤')
      .setStyle(ttsSession.readSpeakerName ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ttsleave_${ttsSession.guildId}`)
      .setLabel('VCから退出')
      .setEmoji('👋')
      .setStyle(ButtonStyle.Danger)
  );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(voiceSelect), btnRow],
  };
}

/**
 * 準備中 または 抽選結果の Discord Embed を生成する
 */
function buildResultEmbed(session) {
  const { vcName, isDrawn, allMembers, options, result } = session;
  const excludedSet = new Set(options.excludedIds || []);
  const prioritySet = new Set(options.priorityIds || []);

  if (!isDrawn) {
    const activeMembers = allMembers.filter((m) => !excludedSet.has(m.id));
    const priorityMembers = activeMembers.filter((m) => prioritySet.has(m.id));
    const excludedMembers = allMembers.filter((m) => excludedSet.has(m.id));

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`🎲 VCチーム振り分け準備 — 🔊 ${vcName}`);

    if (activeMembers.length === 0) {
      embed.addFields({
        name: '⚠️ 振り分け対象メンバーがいません',
        value: '下のプルダウンから除外設定を解除するか、VCにメンバーが入った状態で「📡 VCメンバー再認識」を押してください。',
      });
    } else {
      embed.addFields({
        name: `🎯 参加メンバー (${activeMembers.length}人)`,
        value: activeMembers
          .map((m) =>
            prioritySet.has(m.id)
              ? `⭐ <@${m.id}> (${m.displayName}) **[フルパ確定]**`
              : `• <@${m.id}> (${m.displayName})`
          )
          .join('\n'),
        inline: false,
      });
    }

    if (priorityMembers.length > 0) {
      embed.addFields({
        name: `⭐ フルパ確定枠 (${priorityMembers.length}人)`,
        value: priorityMembers.map((m) => `<@${m.id}> (${m.displayName})`).join(' / '),
        inline: false,
      });
    }

    if (excludedMembers.length > 0) {
      embed.addFields({
        name: `👀 観戦・抽選除外枠 (${excludedMembers.length}人)`,
        value: excludedMembers.map((m) => `<@${m.id}> (${m.displayName})`).join(' / '),
        inline: false,
      });
    }

    embed.setFooter({
      text: 'プルダウンで確定枠・除外メンバーを選択し、「🎲 チーム振り分け」ボタンを押してください',
    });

    return embed;
  }

  const embed = new EmbedBuilder()
    .setColor(0xff4655)
    .setTitle(`🎲 VCチーム抽選結果 — 🔊 ${vcName}`)
    .setTimestamp(new Date(result.timestamp));

  if (result.teams.length === 0) {
    embed.addFields({
      name: '⚠️ 抽選対象メンバーがいません',
      value: '除外設定を解除するか、VCにメンバーが入った状態で「🎲 チーム振り分け」を押してください。',
    });
  } else {
    result.teams.forEach((team, idx) => {
      const badge = team.isRemainder ? '🔸' : idx === 0 ? '🏆' : '🔹';
      const memberLines =
        team.members.length > 0
          ? team.members
              .map((m, i) => {
                const star = m.isPriority ? ' ⭐' : '';
                return `\`${i + 1}.\` <@${m.id}> (${m.displayName})${star}`;
              })
              .join('\n')
          : '*(なし)*';
      embed.addFields({
        name: `${badge} ${team.name}`,
        value: memberLines,
        inline: true,
      });
    });
  }

  if (result.excludedMembers.length > 0) {
    embed.addFields({
      name: `👀 観戦・抽選除外枠 (${result.excludedMembers.length}人)`,
      value: result.excludedMembers.map((m) => `<@${m.id}> (${m.displayName})`).join(' / '),
      inline: false,
    });
  }

  embed.setFooter({
    text: 'もう一度「🎲 チーム振り分け」を押すと再抽選できます',
  });

  return embed;
}

/**
 * インタラクティブ操作用のコンポーネント行を生成する（最大4行）
 */
function buildControlComponents(session, publicUrl) {
  const rows = [];

  const presetSelect = new StringSelectMenuBuilder()
    .setCustomId(`preset_${session.id}`)
    .setPlaceholder('⚙️ 抽選ルール・優先人数を変更...')
    .addOptions(
      Object.values(PRESETS).map((p) => ({
        label: p.name,
        description: p.description.slice(0, 95),
        value: p.id,
        emoji: p.icon,
        default: session.presetId === p.id,
      }))
    );
  rows.push(new ActionRowBuilder().addComponents(presetSelect));

  if (session.allMembers.length > 0) {
    const slicedMembers = session.allMembers.slice(0, 25);

    const priorityOptions = slicedMembers.map((m) => {
      const isPriority = (session.options.priorityIds || []).includes(m.id);
      return {
        label: `${m.displayName}`,
        description: isPriority
          ? '現在: ⭐ フルパ確定枠に設定中'
          : '選択すると確定でフルパ（メインチーム）側に入ります',
        value: m.id,
        emoji: isPriority ? '⭐' : '👤',
        default: isPriority,
      };
    });

    const prioritySelect = new StringSelectMenuBuilder()
      .setCustomId(`priority_${session.id}`)
      .setPlaceholder('⭐ 確定でフルパ側に入るメンバーを選択（複数選択可）...')
      .setMinValues(0)
      .setMaxValues(priorityOptions.length)
      .addOptions(priorityOptions);

    rows.push(new ActionRowBuilder().addComponents(prioritySelect));

    const excludeOptions = slicedMembers.map((m) => {
      const isExcluded = (session.options.excludedIds || []).includes(m.id);
      return {
        label: `${m.displayName}`,
        description: isExcluded ? '現在: 👀 観戦・抽選から除外中' : '現在: 🎯 抽選に参加',
        value: m.id,
        emoji: isExcluded ? '👀' : '🎯',
        default: isExcluded,
      };
    });

    const excludeSelect = new StringSelectMenuBuilder()
      .setCustomId(`exclude_${session.id}`)
      .setPlaceholder('👀 抽選から除外（観戦・離席）するメンバーを選択...')
      .setMinValues(0)
      .setMaxValues(excludeOptions.length)
      .addOptions(excludeOptions);

    rows.push(new ActionRowBuilder().addComponents(excludeSelect));
  }

  const canMoveVc =
    session.isDrawn && session.result && session.result.teams && session.result.teams.length > 0;

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`reroll_${session.id}`)
      .setLabel('チーム振り分け')
      .setEmoji('🎲')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`refresh_${session.id}`)
      .setLabel('VCメンバー再認識')
      .setEmoji('📡')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`askmove_${session.id}`)
      .setLabel('別のVCへ移動...')
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canMoveVc),
    new ButtonBuilder()
      .setCustomId(`ttsjoin_${session.id}`)
      .setLabel('読み上げBotを呼ぶ')
      .setEmoji('🗣️')
      .setStyle(ButtonStyle.Secondary)
  );

  if (publicUrl && publicUrl.startsWith('http')) {
    try {
      const url = new URL(publicUrl);
      if (session.guildId) url.searchParams.set('guildId', session.guildId);
      if (session.vcId) url.searchParams.set('vcId', session.vcId);
      btnRow.addComponents(
        new ButtonBuilder()
          .setLabel('Web UI')
          .setEmoji('🌐')
          .setStyle(ButtonStyle.Link)
          .setURL(url.toString())
      );
    } catch (_) {}
  }

  rows.push(btnRow);
  return rows;
}

/**
 * 「別のチャンネルへ移動しますか？」の確認ポップアップ（エフェメラル）を生成する
 */
function buildMoveConfirmationPayload(session, guild) {
  const voiceChannels = guild.channels.cache
    .filter(
      (c) =>
        c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice
    )
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .first(25);

  if (!session.moveTargets || Object.keys(session.moveTargets).length === 0) {
    session.moveTargets = {};
    session.result.teams.forEach((team, idx) => {
      if (idx === 0) {
        session.moveTargets[team.index] = session.vcId;
      } else {
        const otherVcs = voiceChannels.filter((c) => c.id !== session.vcId);
        const candidate = otherVcs[(idx - 1) % Math.max(1, otherVcs.length)];
        session.moveTargets[team.index] = candidate ? candidate.id : session.vcId;
      }
    });
  }

  const assignmentLines = session.result.teams.map((team) => {
    const targetVcId = session.moveTargets[team.index];
    const targetVc = guild.channels.cache.get(targetVcId);
    const vcLabel = targetVc ? `🔊 **${targetVc.name}**` : '*(未選択)*';
    const memberNames = team.members.map((m) => m.displayName).join(', ') || 'なし';
    return `• **${team.name}** (${memberNames})\n  ➔ 移動先: ${vcLabel}`;
  });

  const confirmEmbed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('🔊 別のVCチャンネルへ移動しますか？')
    .setDescription(
      '分かれたチームごとにメンバーを別々のVCチャンネルへ自動移動できます。\n' +
        '下のメニューで各チームの移動先VCを確認・変更し、**「✅ 移動を実行する」**を押してください。\n\n' +
        assignmentLines.join('\n\n')
    )
    .setFooter({ text: '※Botに「メンバーを移動 (Move Members)」権限が必要です' });

  const rows = [];

  session.result.teams.slice(0, 4).forEach((team) => {
    if (voiceChannels.length === 0) return;
    const select = new StringSelectMenuBuilder()
      .setCustomId(`movetarget_${session.id}_${team.index}`)
      .setPlaceholder(`${team.name} の移動先VCを選択...`)
      .addOptions(
        voiceChannels.map((vc) => ({
          label: `${vc.name} (現在 ${vc.members.size}人)`,
          description: vc.id === session.vcId ? '現在のVCチャンネル' : '別のVCチャンネルへ移動',
          value: vc.id,
          emoji: '🔊',
          default: session.moveTargets[team.index] === vc.id,
        }))
      );
    rows.push(new ActionRowBuilder().addComponents(select));
  });

  const confirmRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`execmove_${session.id}`)
      .setLabel('移動を実行する')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`gather_${session.id}`)
      .setLabel('全員を元のVCに集める')
      .setEmoji('🔙')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`cancelmove_${session.id}`)
      .setLabel('キャンセル')
      .setEmoji('✖️')
      .setStyle(ButtonStyle.Danger)
  );
  rows.push(confirmRow);

  return {
    embeds: [confirmEmbed],
    components: rows,
    ephemeral: true,
  };
}

/**
 * チームごとのVC移動を実行する共通関数
 */
async function executeTeamMove(guild, teams, moveTargets) {
  const movedReport = [];
  const errors = [];

  for (const team of teams) {
    const targetVcId = moveTargets[team.index] || moveTargets[String(team.index)];
    if (!targetVcId) continue;

    const targetChannel = guild.channels.cache.get(targetVcId);
    if (!targetChannel) continue;

    let movedCount = 0;
    for (const m of team.members) {
      try {
        const guildMember = await guild.members.fetch(m.id);
        if (guildMember && guildMember.voice && guildMember.voice.channelId) {
          if (guildMember.voice.channelId !== targetVcId) {
            await guildMember.voice.setChannel(targetChannel, 'VC Team Splitter によるチーム移動');
          }
          movedCount++;
        }
      } catch (err) {
        errors.push(`${m.displayName}: ${err.message}`);
      }
    }
    movedReport.push(`**${team.name}** ➔ 🔊 **${targetChannel.name}** (${movedCount}人)`);
  }

  return { movedReport, errors };
}

/**
 * Botのイベントハンドラとコマンド自動登録をセットアップする
 */
async function setupBot(client, config = {}) {
  const { token, guildId, publicUrl } = config;

  client.once('ready', async () => {
    const resolvedClientId = config.clientId || client.user.id;
    const inviteUrl = generateBotInviteUrl(resolvedClientId);

    console.log(`✅ Discord Bot ログイン完了: ${client.user.tag} (MessageContent: ${client.messageContentEnabled})`);
    if (inviteUrl) {
      console.log(`🔗 サーバー招待URL: ${inviteUrl}`);
    }

    if (token && resolvedClientId) {
      try {
        const rest = new REST({ version: '10' }).setToken(token);
        const commands = getSlashCommands();

        await rest.put(Routes.applicationCommands(resolvedClientId), {
          body: commands,
        });
        console.log(`🌐 スラッシュコマンド [/team, /join, /leave, /voice, /say] を登録しました`);

        for (const [gId] of client.guilds.cache) {
          await rest
            .put(Routes.applicationGuildCommands(resolvedClientId, gId), {
              body: commands,
            })
            .catch(() => {});
        }
        if (guildId && !client.guilds.cache.has(guildId)) {
          await rest
            .put(Routes.applicationGuildCommands(resolvedClientId, guildId), {
              body: commands,
            })
            .catch(() => {});
        }
      } catch (err) {
        console.error('⚠️ スラッシュコマンド登録エラー:', err.message);
      }
    }
  });

  client.on('guildCreate', async (guild) => {
    try {
      const resolvedClientId = config.clientId || client.user?.id;
      if (!token || !resolvedClientId) return;
      const rest = new REST({ version: '10' }).setToken(token);
      await rest.put(Routes.applicationGuildCommands(resolvedClientId, guild.id), {
        body: getSlashCommands(),
      });
    } catch (err) {
      console.warn(`⚠️ 新規サーバー (${guild.name}) へのコマンド即時登録失敗:`, err.message);
    }
  });

  // 🗣️ VC内テキストチャット（および紐付けチャンネル）のメッセージ自動読み上げ
  client.on('messageCreate', async (message) => {
    try {
      if (!message.guild || message.author.bot) return;
      const ttsSession = ttsSessions.get(message.guild.id);
      if (!ttsSession) return;

      // 読み上げ対象チャンネル（VC自体のチャット欄 または /join を実行したチャンネル）かチェック
      if (!ttsSession.boundChannelIds.has(message.channel.id)) return;

      const raw = (message.content || '').trim();
      if (!raw) return;

      // 's' または 'skip' だけ入力された場合は読み上げスキップ
      if (raw === 's' || raw === 'skip' || raw === 'ｓ') {
        ttsSession.skip();
        return;
      }

      const cleaned = sanitizeTextForTts(raw, message.guild);
      if (!cleaned) return;

      const speakerName = message.member?.displayName || message.author.username;
      const finalText = ttsSession.readSpeakerName
        ? `${speakerName}さん、${cleaned}`
        : cleaned;

      // 発言者個人のボイス設定があればそれを優先し、なければサーバーのデフォルトボイスを使用
      const voiceId = userVoicePrefs.get(message.author.id) || ttsSession.defaultVoice;
      ttsSession.enqueue(finalText, voiceId);
    } catch (err) {
      console.error('TTS messageCreate error:', err.message);
    }
  });

  // VCから人間が全員いなくなったら読み上げBotを自動退出させる
  client.on('voiceStateUpdate', (oldState, newState) => {
    try {
      const guild = oldState.guild || newState.guild;
      if (!guild) return;
      const ttsSession = ttsSessions.get(guild.id);
      if (!ttsSession) return;

      const vc = guild.channels.cache.get(ttsSession.vcId);
      if (!vc) {
        ttsSession.destroy();
        return;
      }

      const humanMembers = vc.members.filter((m) => !m.user.bot);
      if (humanMembers.size === 0) {
        setTimeout(() => {
          const currentSession = ttsSessions.get(guild.id);
          const currentVc = guild.channels.cache.get(ttsSession.vcId);
          if (
            currentSession &&
            currentVc &&
            currentVc.members.filter((m) => !m.user.bot).size === 0
          ) {
            currentSession.destroy();
          }
        }, 5000);
      }
    } catch (_) {}
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      // ==========================================
      // A. スラッシュコマンド処理
      // ==========================================
      if (interaction.isChatInputCommand()) {
        const { commandName, guild } = interaction;
        if (!guild) {
          return interaction.reply({
            content: '⚠️ このコマンドはDiscordサーバー内でのみ使用できます。',
            ephemeral: true,
          });
        }

        // 1. `/join` — 読み上げBotをVCに呼ぶ
        if (commandName === 'join') {
          let targetVc = interaction.options.getChannel('vc_channel');
          if (!targetVc) {
            const member = await guild.members.fetch(interaction.user.id);
            targetVc = member.voice?.channel;
          }

          if (!targetVc) {
            return interaction.reply({
              content:
                '⚠️ **参加先のVCが見つかりません。**\nボイスチャンネルに入ってから `/join` を実行するか、`vc_channel` オプションでVCを指定してください！',
              ephemeral: true,
            });
          }

          const voiceId = interaction.options.getString('voice') || 'zunda_normal';
          const ttsSession = joinVcForTts(
            guild,
            targetVc,
            interaction.channelId,
            voiceId
          );

          const resolvedClientId = config.clientId || client.user?.id;
          return interaction.reply(
            buildTtsControlPayload(
              ttsSession,
              client.messageContentEnabled,
              resolvedClientId
            )
          );
        }

        // 2. `/leave` — 読み上げBotをVCから退出させる
        if (commandName === 'leave') {
          const existing = ttsSessions.get(guild.id);
          if (!existing) {
            return interaction.reply({
              content: 'ℹ️ 現在このサーバーのVCには参加していません。',
              ephemeral: true,
            });
          }
          const vcName = existing.vcName;
          existing.destroy();
          return interaction.reply({
            content: `👋 **🔊 ${vcName}** から退出しました！`,
          });
        }

        // 3. `/voice` — 読み上げボイスの変更（個人 または サーバー全体）
        if (commandName === 'voice') {
          const voiceId = interaction.options.getString('voice', true);
          const target = interaction.options.getString('target') || 'user';
          const preset = VOICE_PRESETS[voiceId] || VOICE_PRESETS.zunda_normal;

          if (target === 'guild') {
            const existing = ttsSessions.get(guild.id);
            if (existing) {
              existing.defaultVoice = voiceId;
            }
            return interaction.reply({
              content: `🌐 サーバー全体のデフォルト読み上げボイスを **${preset.emoji} ${preset.name}** に変更しました！`,
            });
          } else {
            userVoicePrefs.set(interaction.user.id, voiceId);
            return interaction.reply({
              content: `👤 <@${interaction.user.id}> さんの読み上げボイスを **${preset.emoji} ${preset.name}** に設定しました！`,
              ephemeral: true,
            });
          }
        }

        // 4. `/say` — 指定したテキストをVCで直接読み上げる
        if (commandName === 'say') {
          const text = interaction.options.getString('text', true);
          const voiceOpt = interaction.options.getString('voice');
          let ttsSession = ttsSessions.get(guild.id);

          if (!ttsSession) {
            const member = await guild.members.fetch(interaction.user.id);
            const userVc = member.voice?.channel;
            if (!userVc) {
              return interaction.reply({
                content: '⚠️ ボイスチャンネルに入ってから `/say` を実行するか、先に `/join` でBotをVCに呼んでください。',
                ephemeral: true,
              });
            }
            ttsSession = joinVcForTts(
              guild,
              userVc,
              interaction.channelId,
              voiceOpt || 'zunda_normal'
            );
          }

          const voiceId =
            voiceOpt ||
            userVoicePrefs.get(interaction.user.id) ||
            ttsSession.defaultVoice;
          const cleaned = sanitizeTextForTts(text, guild);
          ttsSession.enqueue(cleaned, voiceId);

          const preset = VOICE_PRESETS[voiceId] || VOICE_PRESETS.zunda_normal;
          return interaction.reply({
            content: `🗣️ **${preset.emoji} ${preset.name}**: 「${cleaned}」`,
          });
        }

        // 5. `/team` — VCメンバー自動認識＆チーム振り分けパネル表示
        if (commandName === 'team') {
          let targetVc = interaction.options.getChannel('vc_channel');
          if (!targetVc) {
            const member = await guild.members.fetch(interaction.user.id);
            targetVc = member.voice?.channel;
          }

          if (!targetVc) {
            return interaction.reply({
              content:
                '⚠️ **VCチャンネルが認識できませんでした。**\nボイスチャンネルに入ってから `/team` を実行するか、`vc_channel` オプションで対象のVCを指定してください！',
              ephemeral: true,
            });
          }

          const includeBots = interaction.options.getBoolean('include_bots') || false;
          const allMembers = extractVcMembers(targetVc, includeBots);

          if (allMembers.length === 0) {
            return interaction.reply({
              content: `⚠️ **🔊 ${targetVc.name}** には現在メンバーがいません。（Botを含めてテストする場合は \`include_bots: True\` を指定してください）`,
              ephemeral: true,
            });
          }

          const presetKey = interaction.options.getString('preset');
          const prioritySizeOpt = interaction.options.getInteger('priority_size');
          const groupCountOpt = interaction.options.getInteger('group_count');
          const customSizesOpt = interaction.options.getString('custom_sizes');

          let splitOptions = {
            excludedIds: [],
            priorityIds: [],
            mode: 'priority',
            prioritySize: 5,
            maxPriorityTeams: null,
            groupCount: 2,
            customSizes: [],
          };
          let activePresetId = 'valo_5';

          if (customSizesOpt) {
            splitOptions.mode = 'custom';
            splitOptions.customSizes = parseCustomSizes(customSizesOpt);
            activePresetId = 'custom';
          } else if (groupCountOpt) {
            splitOptions.mode = 'groups';
            splitOptions.groupCount = groupCountOpt;
            activePresetId = `equal_${groupCountOpt}`;
          } else if (prioritySizeOpt) {
            splitOptions.mode = 'priority';
            splitOptions.prioritySize = prioritySizeOpt;
            activePresetId = 'custom_priority';
          } else if (presetKey && PRESETS[presetKey]) {
            const p = PRESETS[presetKey];
            splitOptions = { ...splitOptions, ...p };
            activePresetId = presetKey;
          } else {
            splitOptions = { ...splitOptions, ...PRESETS.valo_5 };
            activePresetId = 'valo_5';
          }

          const sessionId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

          const session = {
            id: sessionId,
            createdAt: Date.now(),
            guildId: guild.id,
            vcId: targetVc.id,
            vcName: targetVc.name,
            includeBots,
            presetId: activePresetId,
            allMembers,
            options: splitOptions,
            isDrawn: false,
            result: null,
            moveTargets: {},
          };
          sessions.set(sessionId, session);

          return interaction.reply({
            embeds: [buildResultEmbed(session)],
            components: buildControlComponents(session, publicUrl),
          });
        }
      }

      // ==========================================
      // B. セレクトメニュー＆ボタン操作
      // ==========================================
      if (interaction.isStringSelectMenu() || interaction.isButton()) {
        const parts = interaction.customId.split('_');
        const act = parts[0];

        // --- 読み上げBot (TTS) パネルのボタン・プルダウン操作 ---
        if (act === 'ttsvoice' && interaction.isStringSelectMenu()) {
          const gId = parts.slice(1).join('_');
          const ttsSession = ttsSessions.get(gId);
          if (!ttsSession) {
            return interaction.reply({
              content: '⚠️ 読み上げBotは現在VCに参加していません。`/join` で呼び出してください。',
              ephemeral: true,
            });
          }
          const chosenVoice = interaction.values[0];
          ttsSession.defaultVoice = chosenVoice;
          const preset = VOICE_PRESETS[chosenVoice] || VOICE_PRESETS.zunda_normal;
          ttsSession.enqueue(`${preset.name}に変更したのだ`, chosenVoice);

          const resolvedClientId = config.clientId || client.user?.id;
          return interaction.update(
            buildTtsControlPayload(
              ttsSession,
              client.messageContentEnabled,
              resolvedClientId
            )
          );
        }

        if (act === 'ttsskip' && interaction.isButton()) {
          const gId = parts.slice(1).join('_');
          const ttsSession = ttsSessions.get(gId);
          if (ttsSession) ttsSession.skip();
          return interaction.deferUpdate();
        }

        if (act === 'ttsname' && interaction.isButton()) {
          const gId = parts.slice(1).join('_');
          const ttsSession = ttsSessions.get(gId);
          if (!ttsSession) {
            return interaction.reply({
              content: '⚠️ 読み上げBotは現在VCに参加していません。',
              ephemeral: true,
            });
          }
          ttsSession.readSpeakerName = !ttsSession.readSpeakerName;
          const resolvedClientId = config.clientId || client.user?.id;
          return interaction.update(
            buildTtsControlPayload(
              ttsSession,
              client.messageContentEnabled,
              resolvedClientId
            )
          );
        }

        if (act === 'ttsleave' && interaction.isButton()) {
          const gId = parts.slice(1).join('_');
          const ttsSession = ttsSessions.get(gId);
          if (ttsSession) {
            ttsSession.destroy();
          }
          return interaction.update({
            content: '👋 読み上げBotがVCから退出しました。再度呼ぶときは `/join` を実行してください！',
            embeds: [],
            components: [],
          });
        }

        // --- チーム分け (`/team`) パネルの操作 ---
        if (act === 'movetarget') {
          const teamIdx = parts.pop();
          const sId = parts.slice(1).join('_');
          const session = sessions.get(sId);
          if (!session) {
            return interaction.reply({
              content: '⚠️ この抽選セッションの有効期限が切れました。再度 `/team` を実行してください。',
              ephemeral: true,
            });
          }
          session.moveTargets[teamIdx] = interaction.values[0];
          const payload = buildMoveConfirmationPayload(session, interaction.guild);
          return interaction.update(payload);
        }

        const sId = parts.slice(1).join('_');
        const session = sessions.get(sId);
        if (!session) {
          return interaction.reply({
            content: '⚠️ この抽選セッションの有効期限が切れました。新しく `/team` を実行してください。',
            ephemeral: true,
          });
        }

        // `/team` パネルの「🗣️ 読み上げBotを呼ぶ」ボタン
        if (act === 'ttsjoin' && interaction.isButton()) {
          const vc = interaction.guild.channels.cache.get(session.vcId);
          if (!vc) {
            return interaction.reply({
              content: '⚠️ 対象のVCチャンネルが見つかりません。',
              ephemeral: true,
            });
          }
          const ttsSession = joinVcForTts(
            interaction.guild,
            vc,
            interaction.channelId,
            'zunda_normal'
          );
          const resolvedClientId = config.clientId || client.user?.id;
          return interaction.reply(
            buildTtsControlPayload(
              ttsSession,
              client.messageContentEnabled,
              resolvedClientId
            )
          );
        }

        if (act === 'preset' && interaction.isStringSelectMenu()) {
          const chosenKey = interaction.values[0];
          const preset = PRESETS[chosenKey];
          if (preset) {
            session.presetId = chosenKey;
            session.options = {
              ...session.options,
              mode: preset.mode,
              prioritySize: preset.prioritySize || 5,
              maxPriorityTeams: preset.maxPriorityTeams ?? null,
              groupCount: preset.groupCount || 2,
              customSizes: preset.customSizes || [],
              teamNames: preset.teamNames || [],
            };
            session.isDrawn = false;
            session.moveTargets = {};
          }
          return interaction.update({
            embeds: [buildResultEmbed(session)],
            components: buildControlComponents(session, publicUrl),
          });
        }

        if (act === 'priority' && interaction.isStringSelectMenu()) {
          session.options.priorityIds = interaction.values;
          const prioSet = new Set(interaction.values);
          session.options.excludedIds = (session.options.excludedIds || []).filter(
            (id) => !prioSet.has(id)
          );
          session.isDrawn = false;
          session.moveTargets = {};
          return interaction.update({
            embeds: [buildResultEmbed(session)],
            components: buildControlComponents(session, publicUrl),
          });
        }

        if (act === 'exclude' && interaction.isStringSelectMenu()) {
          session.options.excludedIds = interaction.values;
          const exclSet = new Set(interaction.values);
          session.options.priorityIds = (session.options.priorityIds || []).filter(
            (id) => !exclSet.has(id)
          );
          session.isDrawn = false;
          session.moveTargets = {};
          return interaction.update({
            embeds: [buildResultEmbed(session)],
            components: buildControlComponents(session, publicUrl),
          });
        }

        if (act === 'reroll' && interaction.isButton()) {
          session.result = splitMembers(session.allMembers, session.options);
          session.isDrawn = true;
          session.moveTargets = {};

          // もし読み上げBotがそのVCに参加していれば、抽選完了をずんだもん/ゆっくりボイスでアナウンス！
          const ttsSession = ttsSessions.get(interaction.guild.id);
          if (ttsSession && ttsSession.vcId === session.vcId) {
            const announceText = ttsSession.defaultVoice.startsWith('zunda')
              ? 'チーム振り分けが完了したのだ！結果を確認してほしいのだ！'
              : 'チーム振り分けが完了しました。結果を確認してください。';
            ttsSession.enqueue(announceText, ttsSession.defaultVoice);
          }

          return interaction.update({
            embeds: [buildResultEmbed(session)],
            components: buildControlComponents(session, publicUrl),
          });
        }

        if (act === 'refresh' && interaction.isButton()) {
          const vc = interaction.guild.channels.cache.get(session.vcId);
          if (vc) {
            session.allMembers = extractVcMembers(vc, session.includeBots);
            session.isDrawn = false;
            session.moveTargets = {};
          }
          return interaction.update({
            embeds: [buildResultEmbed(session)],
            components: buildControlComponents(session, publicUrl),
          });
        }

        if (act === 'askmove' && interaction.isButton()) {
          if (!session.isDrawn || !session.result) {
            return interaction.reply({
              content: '⚠️ 先に「🎲 チーム振り分け」ボタンを押してチームを決定してください。',
              ephemeral: true,
            });
          }
          const payload = buildMoveConfirmationPayload(session, interaction.guild);
          return interaction.reply(payload);
        }

        if (act === 'execmove' && interaction.isButton()) {
          await interaction.deferUpdate();
          const { movedReport, errors } = await executeTeamMove(
            interaction.guild,
            session.result.teams,
            session.moveTargets
          );

          const doneEmbed = new EmbedBuilder()
            .setColor(0x00b894)
            .setTitle('✅ VCチャンネルへの移動が完了しました！')
            .setDescription(
              movedReport.join('\n') +
                (errors.length > 0
                  ? `\n\n⚠️ **一部移動できなかったメンバー:**\n${errors.join('\n')}`
                  : '')
            );

          return interaction.editReply({
            embeds: [doneEmbed],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                  .setCustomId(`gather_${session.id}`)
                  .setLabel(`全員を元のVC (${session.vcName}) に戻す`)
                  .setEmoji('🔙')
                  .setStyle(ButtonStyle.Secondary)
              ),
            ],
          });
        }

        if (act === 'gather' && interaction.isButton()) {
          await interaction.deferUpdate();
          const gatherTargets = {};
          session.result.teams.forEach((t) => {
            gatherTargets[t.index] = session.vcId;
          });
          await executeTeamMove(interaction.guild, session.result.teams, gatherTargets);

          const gatherEmbed = new EmbedBuilder()
            .setColor(0x0984e3)
            .setTitle(`🔙 全員を 🔊 ${session.vcName} に戻しました！`);

          return interaction.editReply({
            embeds: [gatherEmbed],
            components: [],
          });
        }

        if (act === 'cancelmove' && interaction.isButton()) {
          return interaction.update({
            content: '✖️ VC移動をキャンセルしました。',
            embeds: [],
            components: [],
          });
        }
      }
    } catch (error) {
      console.error('Interaction handling error:', error);
      if (!interaction.replied && !interaction.deferred) {
        await interaction
          .reply({
            content: `⚠️ エラーが発生しました: ${error.message}`,
            ephemeral: true,
          })
          .catch(() => {});
      }
    }
  });

  return {
    sessions,
    extractVcMembers,
    buildResultEmbed,
    buildControlComponents,
    executeTeamMove,
  };
}

module.exports = {
  createBotClient,
  setupBot,
  generateBotInviteUrl,
  extractVcMembers,
  executeTeamMove,
  sessions,
};
