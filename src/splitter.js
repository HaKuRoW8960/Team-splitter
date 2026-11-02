/**
 * Discord VC Team Splitter - コア抽選・チーム分けエンジン
 *
 * 対応モード:
 * 1. priority (優先人数指定モード)
 *    - 例: 7人中 5人チームを優先作成 → [チーム1 (5人), 余り/チーム2 (2人)]
 *    - priorityIds に指定されたメンバーは確定でフルパ（優先チーム）側に入る
 * 2. groups (グループ数均等割りモード)
 *    - 例: 7人を 2グループに均等分け → [チーム1 (4人), チーム2 (3人)]
 * 3. custom (カスタム人数リスト指定モード)
 *    - 例: "5, 2" や "5, 5, 2" のように各チームの定員を直接指定
 */

const crypto = require('crypto');

const PRESETS = {
  valo_5: {
    id: 'valo_5',
    name: 'Valorant フルパ優先 (5人)',
    description: '5人フルパを優先して作成し、残りのメンバーを別グループに分けます',
    mode: 'priority',
    prioritySize: 5,
    maxPriorityTeams: null,
    icon: '🎯',
  },
  valo_single_5: {
    id: 'valo_single_5',
    name: 'Valorant 1組だけ5人抽選',
    description: '5人フルパを1組だけ抽選し、残りの全員を別枠にまとめます',
    mode: 'priority',
    prioritySize: 5,
    maxPriorityTeams: 1,
    icon: '🔫',
  },
  valo_custom_10: {
    id: 'valo_custom_10',
    name: 'Valorant カスタム (5 vs 5 + 観戦)',
    description: 'アタッカー5人・ディフェンダー5人を抽選し、11人目以降を観戦枠にします',
    mode: 'custom',
    customSizes: [5, 5],
    teamNames: ['アタッカー (5人)', 'ディフェンダー (5人)'],
    icon: '⚔️',
  },
  apex_3: {
    id: 'apex_3',
    name: 'Apex / トリオ優先 (3人)',
    description: '3人フルパを優先して作成し、残りを別グループに分けます',
    mode: 'priority',
    prioritySize: 3,
    maxPriorityTeams: null,
    icon: '🛡️',
  },
  quad_4: {
    id: 'quad_4',
    name: '4人スクワッド優先 (4人)',
    description: '4人パーティを優先して作成し、残りを別グループに分けます',
    mode: 'priority',
    prioritySize: 4,
    maxPriorityTeams: null,
    icon: '🍀',
  },
  duo_2: {
    id: 'duo_2',
    name: 'デュオ優先 (2人)',
    description: '2人組ペアを優先して作成し、奇数時は1人余り枠を作ります',
    mode: 'priority',
    prioritySize: 2,
    maxPriorityTeams: null,
    icon: '👥',
  },
  equal_2: {
    id: 'equal_2',
    name: '2グループ均等分け',
    description: '参加メンバーを人数が均等になるよう2つのチームに分けます',
    mode: 'groups',
    groupCount: 2,
    icon: '⚖️',
  },
  equal_3: {
    id: 'equal_3',
    name: '3グループ均等分け',
    description: '参加メンバーを人数が均等になるよう3つのチームに分けます',
    mode: 'groups',
    groupCount: 3,
    icon: '📐',
  },
};

/**
 * 暗号論的乱数を用いた偏りのない Fisher-Yates シャッフル
 * @param {Array} array
 * @returns {Array} 新しいシャッフル済み配列
 */
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * カンマ区切りの人数指定文字列（例: "5,2" または "5, 3, 2"）を数値配列に変換
 * @param {string|number[]} input
 * @returns {number[]}
 */
function parseCustomSizes(input) {
  if (Array.isArray(input)) {
    return input.map((n) => parseInt(n, 10)).filter((n) => Number.isInteger(n) && n > 0);
  }
  if (typeof input !== 'string') return [];
  return input
    .split(/[,\s、/＋+]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * メンバーを条件に従ってチーム分けする
 *
 * @param {Array<{id: string, displayName: string, username?: string, avatarUrl?: string}>} allMembers VC内の全メンバー
 * @param {Object} options
 * @param {string[]} [options.excludedIds=[]] 抽選から除外（観戦・離席）するメンバーID配列
 * @param {string[]} [options.priorityIds=[]] 確定でフルパ（優先チーム）側に入るメンバーID配列
 * @param {'priority'|'groups'|'custom'} [options.mode='priority'] 分割モード
 * @param {number} [options.prioritySize=5] 優先チームの人数 (mode === 'priority' 時)
 * @param {number|null} [options.maxPriorityTeams=null] 優先チームの最大作成数 (null なら作れるだけ作成)
 * @param {number} [options.groupCount=2] 均等分けのグループ数 (mode === 'groups' 時)
 * @param {number[]|string} [options.customSizes=[]] カスタム人数配列 (mode === 'custom' 時)
 * @param {string[]} [options.teamNames=[]] カスタムチーム名リスト
 */
function splitMembers(allMembers, options = {}) {
  const excludedSet = new Set(options.excludedIds || []);
  const prioritySet = new Set(options.priorityIds || []);

  const fixedMembers = [];
  const normalMembers = [];
  const excludedMembers = [];

  for (const member of allMembers) {
    if (excludedSet.has(member.id)) {
      excludedMembers.push({ ...member, isPriority: false });
    } else if (prioritySet.has(member.id)) {
      fixedMembers.push({ ...member, isPriority: true });
    } else {
      normalMembers.push({ ...member, isPriority: false });
    }
  }

  // 確定メンバーを先頭に配置し、残りの枠を通常メンバーのシャッフルで埋める
  const shuffledFixed = shuffleArray(fixedMembers);
  const shuffledNormal = shuffleArray(normalMembers);
  const shuffled = [...shuffledFixed, ...shuffledNormal];

  const mode = options.mode || 'priority';
  const teams = [];
  let summary = '';

  if (mode === 'custom') {
    const sizes = parseCustomSizes(options.customSizes);
    if (sizes.length === 0) {
      sizes.push(5);
    }
    let cursor = 0;
    sizes.forEach((size, idx) => {
      if (cursor >= shuffled.length) return;
      const slice = shuffled.slice(cursor, cursor + size);
      cursor += size;
      const customName =
        options.teamNames && options.teamNames[idx]
          ? options.teamNames[idx]
          : `グループ ${idx + 1} (${slice.length}人)`;
      teams.push({
        index: idx + 1,
        name: customName,
        isRemainder: false,
        targetSize: size,
        members: slice,
      });
    });

    if (cursor < shuffled.length) {
      const remainder = shuffled.slice(cursor);
      teams.push({
        index: teams.length + 1,
        name: `余り・別枠グループ (${remainder.length}人)`,
        isRemainder: true,
        targetSize: null,
        members: remainder,
      });
    }
    summary = `カスタム配分 [${sizes.join(' + ')}人]`;
  } else if (mode === 'groups') {
    const groupCount = Math.max(1, Math.min(20, parseInt(options.groupCount, 10) || 2));
    const actualGroups = Math.min(groupCount, Math.max(1, shuffled.length));
    const baseSize = Math.floor(shuffled.length / actualGroups);
    const extra = shuffled.length % actualGroups;

    let cursor = 0;
    for (let i = 0; i < actualGroups; i++) {
      const size = baseSize + (i < extra ? 1 : 0);
      const slice = shuffled.slice(cursor, cursor + size);
      cursor += size;
      teams.push({
        index: i + 1,
        name: `チーム ${String.fromCharCode(65 + i)} (${slice.length}人)`,
        isRemainder: false,
        targetSize: size,
        members: slice,
      });
    }
    summary = `${groupCount}グループ均等分け`;
  } else {
    // Default: 'priority' mode (例: 5人優先で7人なら [5人フルパ, 残り2人])
    const prioritySize = Math.max(1, parseInt(options.prioritySize, 10) || 5);
    const maxTeams =
      options.maxPriorityTeams && options.maxPriorityTeams > 0
        ? parseInt(options.maxPriorityTeams, 10)
        : Infinity;

    let cursor = 0;
    let priorityTeamIndex = 0;

    while (
      cursor + prioritySize <= shuffled.length &&
      priorityTeamIndex < maxTeams
    ) {
      const slice = shuffled.slice(cursor, cursor + prioritySize);
      cursor += prioritySize;
      priorityTeamIndex++;
      teams.push({
        index: teams.length + 1,
        name:
          priorityTeamIndex === 1 && maxTeams === 1
            ? `メインチーム (${prioritySize}人優先枠)`
            : `チーム ${priorityTeamIndex} (${prioritySize}人フルパ)`,
        isRemainder: false,
        targetSize: prioritySize,
        members: slice,
      });
    }

    // 残りメンバーがいる場合（または全体の人数が prioritySize 未満の場合）
    if (cursor < shuffled.length) {
      const remainder = shuffled.slice(cursor);
      const isUnderflow = teams.length === 0;
      teams.push({
        index: teams.length + 1,
        name: isUnderflow
          ? `チーム 1 (${remainder.length}人 / 定員${prioritySize}人未満)`
          : `残りメンバー枠 (${remainder.length}人)`,
        isRemainder: !isUnderflow,
        targetSize: isUnderflow ? prioritySize : null,
        members: remainder,
      });
    }

    summary =
      maxTeams === 1
        ? `${prioritySize}人チーム×1組優先 ＋ 残り枠`
        : `${prioritySize}人チーム優先 ＋ 残り枠`;
  }

  return {
    mode,
    summary,
    totalVcMembers: allMembers.length,
    activeCount: shuffled.length,
    priorityMembers: shuffledFixed,
    teams,
    excludedMembers,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  PRESETS,
  shuffleArray,
  parseCustomSizes,
  splitMembers,
};
