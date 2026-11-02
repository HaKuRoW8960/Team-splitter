/**
 * Discord Bot 実装 (discord.js v14) - クラウド＆マルチサーバー導入対応版
 * - `/team` 実行時はまず設定・準備パネルを表示し、「🎲 チーム振り分け」ボタンを押して初めて抽選を実行
 * - 「⭐ フルパ確定メンバー選択」と「👀 観戦・除外メンバー選択」の2つの複数選択プルダウンを搭載
 * - 不要なルール・人数説明文を省いたスッキリ見やすいEmbed表示
 * - 「🔊 別のVCへ移動...」ボタンで「別のチャンネルへ移動しますか？」の確認ダイアログを表示し、合意後に自動移動
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

function createBotClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ],
  });

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
    PermissionFlagsBits.MoveMembers;

  return (
    `https://discord.com/oauth2/authorize` +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&permissions=${permissions.toString()}` +
    `&scope=${encodeURIComponent('bot applications.commands')}`
  );
}

/**
 * スラッシュコマンド定義
 */
function getSlashCommands() {
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

  return [teamCommand.toJSON()];
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
 * 準備中 または 抽選結果の Discord Embed を生成する
 * （不要な「ルール: ...」「VC在室: ...」のヘッダー説明文は表示しないスッキリ仕様）
 */
function buildResultEmbed(session) {
  const { vcName, isDrawn, allMembers, options, result } = session;
  const excludedSet = new Set(options.excludedIds || []);
  const prioritySet = new Set(options.priorityIds || []);

  // A. まだ「🎲 チーム振り分け」ボタンを押す前の準備画面
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

  // B. 「🎲 チーム振り分け」ボタンを押した後の抽選結果画面
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
 * 1行目: プリセット・ルール選択
 * 2行目: ⭐ 確定でフルパ側に入るメンバー選択（複数選択可）
 * 3行目: 👀 観戦・抽選から除外するメンバー選択（複数選択可）
 * 4行目: 🎲 チーム振り分け / 📡 VCメンバー再認識 / 🔊 別のVCへ移動... / 🌐 Web UIで開く
 */
function buildControlComponents(session, publicUrl) {
  const rows = [];

  // 1. プリセット・ルール切り替えメニュー
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

    // 2. ⭐ 確定でフルパ側に入るメンバー選択メニュー（複数選択可）
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

    // 3. 👀 除外（観戦・離席）メンバー選択メニュー（複数選択可）
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

  // 4. アクションボタン行
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
      .setDisabled(!canMoveVc)
  );

  if (publicUrl && publicUrl.startsWith('http')) {
    try {
      const url = new URL(publicUrl);
      if (session.guildId) url.searchParams.set('guildId', session.guildId);
      if (session.vcId) url.searchParams.set('vcId', session.vcId);
      btnRow.addComponents(
        new ButtonBuilder()
          .setLabel('Web UIで開く')
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

    console.log(`✅ Discord Bot ログイン完了: ${client.user.tag}`);
    if (inviteUrl) {
      console.log(`🔗 サーバー招待URL (ここから導入するだけ): ${inviteUrl}`);
    }

    if (token && resolvedClientId) {
      try {
        const rest = new REST({ version: '10' }).setToken(token);
        const commands = getSlashCommands();

        await rest.put(Routes.applicationCommands(resolvedClientId), {
          body: commands,
        });
        console.log(`🌐 グローバルスラッシュコマンド [/team] を登録しました`);

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
      console.log(`🎉 新規サーバー「${guild.name}」に導入され、[/team] コマンドを即時有効化しました！`);
    } catch (err) {
      console.warn(`⚠️ 新規サーバー (${guild.name}) へのコマンド即時登録失敗:`, err.message);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      // 1. スラッシュコマンド `/team`
      if (interaction.isChatInputCommand() && interaction.commandName === 'team') {
        const guild = interaction.guild;
        if (!guild) {
          return interaction.reply({
            content: '⚠️ このコマンドはDiscordサーバー内でのみ使用できます。',
            ephemeral: true,
          });
        }

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

        // 初期状態は isDrawn: false（まだチーム振り分けを実行せず、確定枠・除外枠を選べる準備画面）
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

      // 2. セレクトメニュー＆ボタン操作
      if (interaction.isStringSelectMenu() || interaction.isButton()) {
        const parts = interaction.customId.split('_');
        const act = parts[0];

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

        // プリセット変更（設定を更新し、「🎲 チーム振り分け」ボタンを押すまで待機状態にする）
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

        // ⭐ フルパ確定メンバー選択変更（選んだ人が除外枠にいた場合は除外から外す）
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

        // 👀 除外メンバー選択変更（選んだ人がフルパ確定枠にいた場合は確定枠から外す）
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

        // 🎲 チーム振り分けボタン（ここで初めて抽選・振り分けを実行！2回目以降は再抽選として機能）
        if (act === 'reroll' && interaction.isButton()) {
          session.result = splitMembers(session.allMembers, session.options);
          session.isDrawn = true;
          session.moveTargets = {};
          return interaction.update({
            embeds: [buildResultEmbed(session)],
            components: buildControlComponents(session, publicUrl),
          });
        }

        // 📡 VCメンバー再認識ボタン
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

        // 🔊 別のVCへ移動...ボタン
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
