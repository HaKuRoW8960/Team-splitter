/**
 * VC Team Splitter - 本格 Web UI フロントエンドロジック
 * - メンバーをクリックして「🎯 抽選参加 ➔ ⭐ フルパ確定 ➔ 👀 観戦・除外」を切り替え可能
 * - 「🎲 チーム振り分けを実行する！」ボタンを押して初めて振り分け結果を表示
 */

const PRESET_DEFINITIONS = {
  valo_5: {
    id: 'valo_5',
    name: '🎯 Valorant フルパ優先 (5人)',
    mode: 'priority',
    prioritySize: 5,
    maxPriorityTeams: null,
  },
  valo_single_5: {
    id: 'valo_single_5',
    name: '🔫 1組だけ5人フルパ抽選',
    mode: 'priority',
    prioritySize: 5,
    maxPriorityTeams: 1,
  },
  apex_3: {
    id: 'apex_3',
    name: '🛡️ Apex / トリオ優先 (3人)',
    mode: 'priority',
    prioritySize: 3,
    maxPriorityTeams: null,
  },
  quad_4: {
    id: 'quad_4',
    name: '🍀 4人スクワッド優先 (4人)',
    mode: 'priority',
    prioritySize: 4,
    maxPriorityTeams: null,
  },
  duo_2: {
    id: 'duo_2',
    name: '👥 デュオ優先 (2人)',
    mode: 'priority',
    prioritySize: 2,
    maxPriorityTeams: null,
  },
  valo_custom_10: {
    id: 'valo_custom_10',
    name: '⚔️ 5 vs 5 カスタム＋観戦',
    mode: 'custom',
    customSizes: [5, 5],
    teamNames: ['アタッカー (5人)', 'ディフェンダー (5人)'],
  },
  equal_2: {
    id: 'equal_2',
    name: '⚖️ 2グループ均等分け',
    mode: 'groups',
    groupCount: 2,
  },
  equal_3: {
    id: 'equal_3',
    name: '📐 3グループ均等分け',
    mode: 'groups',
    groupCount: 3,
  },
};

const DEMO_PLAYERS_POOL = [
  { id: 'demo_1', displayName: 'TenZ_JP', username: 'tenz_jp' },
  { id: 'demo_2', displayName: 'Laz_VCT', username: 'laz_vct' },
  { id: 'demo_3', displayName: 'Dep_Aim', username: 'dep_aim' },
  { id: 'demo_4', displayName: 'SugarZ3ro', username: 'sugarz3ro' },
  { id: 'demo_5', displayName: 'Crow_IGL', username: 'crow_igl' },
  { id: 'demo_6', displayName: 'Meiy_Ace', username: 'meiy_ace' },
  { id: 'demo_7', displayName: 'Boaster_UK', username: 'boaster_uk' },
  { id: 'demo_8', displayName: 'Aspas_BR', username: 'aspas_br' },
  { id: 'demo_9', displayName: 'Chronicle', username: 'chronicle' },
  { id: 'demo_10', displayName: 'Something_PRX', username: 'something' },
  { id: 'demo_11', displayName: 'F0rsakeN', username: 'forsaken' },
  { id: 'demo_12', displayName: 'Karon_KR', username: 'karon_kr' },
];

const DEMO_VOICE_CHANNELS = [
  { id: 'vc_main', name: 'ロビーVC #1 (集会場)' },
  { id: 'vc_team1', name: 'Valorant フルパVC #1' },
  { id: 'vc_team2', name: 'デュオ・別パVC #2' },
  { id: 'vc_team3', name: 'トリオ・カスタムVC #3' },
  { id: 'vc_spec', name: '観戦・待機VC #4' },
];

// アプリ状態
const state = {
  botReady: false,
  clientId: '',
  inviteUrl: '',
  guilds: [],
  currentGuildId: 'demo_guild',
  voiceChannels: [...DEMO_VOICE_CHANNELS],
  textChannels: [],
  currentVcId: 'vc_main',
  currentVcName: 'ロビーVC #1 (集会場)',
  members: DEMO_PLAYERS_POOL.slice(0, 7),
  priorityIds: new Set(),
  excludedIds: new Set(),

  activePreset: 'valo_5',
  mode: 'priority',
  prioritySize: 5,
  maxPriorityTeams: null,
  groupCount: 2,
  customSizes: '5, 2',
  teamNames: [],

  lastResult: null,
  moveTargets: {},
};

// 乱数シャッフル (Web Crypto API 利用)
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const randBuf = new Uint32Array(1);
    window.crypto.getRandomValues(randBuf);
    const j = randBuf[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseCustomSizes(input) {
  if (Array.isArray(input)) return input;
  return String(input || '')
    .split(/[,\s、/＋+]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

// クライアント側抽選エンジン（確定枠 priorityIds 対応）
function runLocalSplit() {
  const fixedMembers = [];
  const normalMembers = [];
  const excludedMembers = [];

  for (const m of state.members) {
    if (state.excludedIds.has(m.id)) {
      excludedMembers.push({ ...m, isPriority: false });
    } else if (state.priorityIds.has(m.id)) {
      fixedMembers.push({ ...m, isPriority: true });
    } else {
      normalMembers.push({ ...m, isPriority: false });
    }
  }

  const shuffled = [...shuffleArray(fixedMembers), ...shuffleArray(normalMembers)];
  const teams = [];
  let summary = '';

  if (state.mode === 'custom') {
    const sizes = parseCustomSizes(state.customSizes);
    if (sizes.length === 0) sizes.push(5);
    let cursor = 0;

    sizes.forEach((size, idx) => {
      if (cursor >= shuffled.length) return;
      const slice = shuffled.slice(cursor, cursor + size);
      cursor += size;
      const customName =
        state.teamNames && state.teamNames[idx]
          ? state.teamNames[idx]
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
        name: `残りメンバー・別枠 (${remainder.length}人)`,
        isRemainder: true,
        targetSize: null,
        members: remainder,
      });
    }
    summary = `カスタム配分 [${sizes.join(' + ')}人]`;
  } else if (state.mode === 'groups') {
    const groupCount = Math.max(1, Math.min(20, parseInt(state.groupCount, 10) || 2));
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
    const prioritySize = Math.max(1, parseInt(state.prioritySize, 10) || 5);
    const maxTeams =
      state.maxPriorityTeams && state.maxPriorityTeams > 0
        ? parseInt(state.maxPriorityTeams, 10)
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
        ? `${prioritySize}人チーム×1組優先 ＋ 残り抽選`
        : `${prioritySize}人フルパ優先 ＋ 残り抽選`;
  }

  return {
    mode: state.mode,
    summary,
    totalVcMembers: state.members.length,
    activeCount: shuffled.length,
    teams,
    excludedMembers,
    timestamp: new Date().toISOString(),
  };
}

function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 3500);
}

// メンバー一覧の描画（クリックで 参加 ➔ フルパ確定 ➔ 観戦除外 をサイクル）
function renderMemberList() {
  const listEl = document.getElementById('memberList');
  listEl.innerHTML = '';

  const totalCount = state.members.length;
  const excludedCount = state.members.filter((m) => state.excludedIds.has(m.id)).length;
  const priorityCount = state.members.filter((m) => state.priorityIds.has(m.id)).length;
  const activeCount = totalCount - excludedCount;

  document.getElementById('vcCountBadge').textContent = `在室 ${totalCount}人`;
  document.getElementById('activeMemberCount').textContent = activeCount;
  const prioEl = document.getElementById('priorityMemberCount');
  if (prioEl) prioEl.textContent = priorityCount;
  document.getElementById('excludedMemberCount').textContent = excludedCount;

  state.members.forEach((member) => {
    const isExcluded = state.excludedIds.has(member.id);
    const isPriority = state.priorityIds.has(member.id);
    const item = document.createElement('div');
    item.className = `member-item ${isExcluded ? 'excluded' : ''}`;

    const initials = (member.displayName || 'U').slice(0, 2).toUpperCase();
    const avatarHtml = member.avatarUrl
      ? `<img src="${member.avatarUrl}" alt="${member.displayName}" />`
      : initials;

    let tagClass = 'active';
    let tagLabel = '🎯 抽選参加';
    if (isPriority) {
      tagClass = 'priority';
      tagLabel = '⭐ フルパ確定';
    } else if (isExcluded) {
      tagClass = 'spectator';
      tagLabel = '👀 観戦・除外';
    }

    item.innerHTML = `
      <div class="member-left">
        <div class="member-avatar">${avatarHtml}</div>
        <div>
          <div class="member-name">${member.displayName}</div>
        </div>
      </div>
      <div class="member-right">
        <span class="status-tag ${tagClass}">
          ${tagLabel}
        </span>
        <button class="remove-member-btn" title="リストから削除" data-remove-id="${member.id}">✕</button>
      </div>
    `;

    // クリックで 🎯抽選参加 ➔ ⭐フルパ確定 ➔ 👀観戦・除外 ➔ 🎯抽選参加 の順に切り替え
    item.addEventListener('click', (e) => {
      if (e.target.closest('.remove-member-btn')) return;
      if (!state.priorityIds.has(member.id) && !state.excludedIds.has(member.id)) {
        state.priorityIds.add(member.id);
      } else if (state.priorityIds.has(member.id)) {
        state.priorityIds.delete(member.id);
        state.excludedIds.add(member.id);
      } else {
        state.excludedIds.delete(member.id);
      }
      renderMemberList();
      updateConfigPreviewText();
    });

    const removeBtn = item.querySelector('.remove-member-btn');
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.members = state.members.filter((m) => m.id !== member.id);
      state.priorityIds.delete(member.id);
      state.excludedIds.delete(member.id);
      renderMemberList();
      updateConfigPreviewText();
    });

    listEl.appendChild(item);
  });

  updateConfigPreviewText();
}

function updateConfigPreviewText() {
  const activeCount = state.members.filter((m) => !state.excludedIds.has(m.id)).length;
  const pSize = Math.max(1, parseInt(state.prioritySize, 10) || 5);
  const maxT = state.maxPriorityTeams ? parseInt(state.maxPriorityTeams, 10) : Infinity;

  let breakdown = [];
  let rem = activeCount;
  let count = 0;
  while (rem >= pSize && count < maxT) {
    breakdown.push(`${pSize}人`);
    rem -= pSize;
    count++;
  }
  if (rem > 0) {
    breakdown.push(`残り${rem}人`);
  }
  const breakdownText = breakdown.length > 0 ? breakdown.join(' ＋ ') : '0人';

  const previewEl = document.getElementById('priorityPreviewText');
  if (previewEl) {
    previewEl.innerHTML = `📌 現在の抽選対象 <strong>${activeCount}人</strong> ➔ <strong>${pSize}人チーム</strong>を優先作成すると <strong>【 ${breakdownText} 】</strong> に分かれます`;
  }

  const gCount = Math.max(2, parseInt(state.groupCount, 10) || 2);
  const groupsPreviewEl = document.getElementById('groupsPreviewText');
  if (groupsPreviewEl) {
    const base = Math.floor(activeCount / gCount);
    const extra = activeCount % gCount;
    const gSizes = Array.from({ length: Math.min(gCount, Math.max(1, activeCount)) }, (_, i) =>
      `${base + (i < extra ? 1 : 0)}人`
    ).join(' / ');
    groupsPreviewEl.innerHTML = `📌 現在の抽選対象 <strong>${activeCount}人</strong> を <strong>${gCount}グループ</strong> に均等分けすると <strong>【 ${gSizes} 】</strong> に分かれます`;
  }
}

// 準備中（未振り分け）状態の案内表示
function renderPendingState() {
  state.lastResult = null;
  const container = document.getElementById('teamsContainer');
  document.getElementById('resultSummarySub').textContent =
    'メンバーの確定枠・除外枠を設定し、「🎲 チーム振り分けを実行する！」を押してください';
  container.innerHTML = `
    <div class="config-preview" style="padding: 18px; text-align: center; border: 1px dashed rgba(255,255,255,0.15); border-radius: 10px;">
      ⏳ <strong>振り分け待機中</strong><br/>
      左のリストで「⭐ フルパ確定」や「👀 観戦・除外」を設定したら、上の <strong>「🎲 チーム振り分けを実行する！」</strong> ボタンを押してください。
    </div>
  `;
  document.getElementById('excludedResultBox').classList.add('hidden');
}

// 抽選結果の描画
function renderLotteryResult(result) {
  state.lastResult = result;
  const container = document.getElementById('teamsContainer');
  container.innerHTML = '';

  document.getElementById('resultSummarySub').textContent =
    `実行時刻: ${new Date(result.timestamp).toLocaleTimeString('ja-JP')}`;

  if (result.teams.length === 0) {
    container.innerHTML = `<div class="config-preview">⚠️ 抽選対象メンバーが0人です。左のリストから観戦・除外設定を解除するかメンバーを追加してください。</div>`;
  } else {
    result.teams.forEach((team, idx) => {
      const card = document.createElement('div');
      const cardClass = team.isRemainder
        ? 'team-card team-remainder'
        : idx === 0
        ? 'team-card team-priority'
        : 'team-card';
      card.className = cardClass;

      const badge = team.isRemainder ? '🔸' : idx === 0 ? '🏆' : '🔹';
      const membersHtml = team.members
        .map(
          (m, i) => `
          <li class="team-member-row">
            <span class="member-index">#${i + 1}</span>
            <strong>${m.displayName}${m.isPriority ? ' ⭐' : ''}</strong>
          </li>
        `
        )
        .join('');

      card.innerHTML = `
        <div class="team-card-header">
          <div class="team-title">${badge} ${team.name}</div>
          <span class="team-count-tag">${team.members.length}名</span>
        </div>
        <ul class="team-member-list">
          ${membersHtml}
        </ul>
      `;

      container.appendChild(card);
    });
  }

  const excludedBox = document.getElementById('excludedResultBox');
  const excludedList = document.getElementById('excludedResultList');
  if (result.excludedMembers && result.excludedMembers.length > 0) {
    excludedBox.classList.remove('hidden');
    excludedList.innerHTML = result.excludedMembers
      .map((m) => `<span class="excluded-chip">👀 ${m.displayName}</span>`)
      .join('');
  } else {
    excludedBox.classList.add('hidden');
  }
}

function openMoveConfirmationModal() {
  if (!state.lastResult || state.lastResult.teams.length === 0) {
    showToast('⚠️ 先に「🎲 チーム振り分けを実行する！」を押してください');
    return;
  }

  const listEl = document.getElementById('moveAssignmentsList');
  listEl.innerHTML = '';
  document.getElementById('moveStatusMessage').classList.add('hidden');

  state.lastResult.teams.forEach((team, idx) => {
    if (!state.moveTargets[team.index]) {
      if (idx === 0) {
        state.moveTargets[team.index] = state.currentVcId;
      } else {
        const otherVcs = state.voiceChannels.filter((v) => v.id !== state.currentVcId);
        const candidate = otherVcs[(idx - 1) % Math.max(1, otherVcs.length)];
        state.moveTargets[team.index] = candidate ? candidate.id : state.currentVcId;
      }
    }

    const row = document.createElement('div');
    row.className = 'move-team-row';

    const optionsHtml = state.voiceChannels
      .map(
        (vc) => `
        <option value="${vc.id}" ${
          state.moveTargets[team.index] === vc.id ? 'selected' : ''
        }>
          🔊 ${vc.name} ${vc.id === state.currentVcId ? '(現在のVC)' : ''}
        </option>
      `
      )
      .join('');

    const memberNames = team.members.map((m) => m.displayName).join('、');

    row.innerHTML = `
      <div class="move-team-top">
        <span class="move-team-name">${team.isRemainder ? '🔸' : '🏆'} ${team.name}</span>
      </div>
      <div class="move-team-members">対象メンバー: ${memberNames}</div>
      <select class="input-select move-vc-select" data-team-index="${team.index}">
        ${optionsHtml}
      </select>
    `;

    row.querySelector('.move-vc-select').addEventListener('change', (e) => {
      state.moveTargets[team.index] = e.target.value;
    });

    listEl.appendChild(row);
  });

  document.getElementById('moveModalBackdrop').classList.remove('hidden');
}

async function executeMoveFromModal(gatherToOriginal = false) {
  if (!state.lastResult) return;

  const targets = {};
  if (gatherToOriginal) {
    state.lastResult.teams.forEach((t) => {
      targets[t.index] = state.currentVcId;
    });
  } else {
    Object.assign(targets, state.moveTargets);
  }

  const statusBox = document.getElementById('moveStatusMessage');
  statusBox.classList.remove('hidden');

  if (state.botReady && state.currentGuildId !== 'demo_guild') {
    statusBox.textContent = '⏳ Discord サーバー上でVC移動を実行しています...';
    try {
      const res = await fetch(`/api/guilds/${state.currentGuildId}/move`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teams: state.lastResult.teams,
          moveTargets: targets,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '移動失敗');
      statusBox.innerHTML =
        `✅ <strong>VC移動が完了しました！</strong><br>` +
        (data.movedReport || []).join('<br>');
      showToast('🔊 各チームを指定のVCチャンネルへ移動しました！');
    } catch (err) {
      statusBox.textContent = `⚠️ エラー: ${err.message}`;
    }
  } else {
    const summaryLines = state.lastResult.teams.map((t) => {
      const vc = state.voiceChannels.find((v) => v.id === targets[t.index]);
      return `・<strong>${t.name}</strong> (${t.members.length}人) ➔ 🔊 <strong>${
        vc ? vc.name : 'VC'
      }</strong> へ移動完了`;
    });
    statusBox.innerHTML =
      `✅ <strong>VC移動を実行しました！（シミュレーション）</strong><br>` +
      summaryLines.join('<br>');
    showToast('🔊 チームごとのVC移動を実行しました！');
  }
}

function buildClientInviteUrl(clientId) {
  const cleanId = String(clientId || '').trim();
  if (!/^\d{15,22}$/.test(cleanId)) return '';
  return `https://discord.com/oauth2/authorize?client_id=${cleanId}&permissions=17828864&scope=bot%20applications.commands`;
}

async function syncWithDiscordBackend() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error('Backend offline');
    const data = await res.json();

    if (data.clientId) {
      state.clientId = data.clientId;
      const clientIdInput = document.getElementById('clientIdInput');
      if (clientIdInput && !clientIdInput.value) {
        clientIdInput.value = data.clientId;
      }
    }
    if (data.inviteUrl) {
      state.inviteUrl = data.inviteUrl;
      const urlInput = document.getElementById('generatedInviteUrl');
      if (urlInput) urlInput.value = data.inviteUrl;
    }

    const badge = document.getElementById('botStatusBadge');
    const text = document.getElementById('botStatusText');

    if (data.botReady && data.guilds.length > 0) {
      state.botReady = true;
      state.guilds = data.guilds;
      badge.className = 'status-pill status-connected';
      text.textContent = `Discord Bot 接続中 (${data.botTag})`;

      const guildSelect = document.getElementById('guildSelect');
      const urlParams = new URLSearchParams(window.location.search);
      const paramGuildId = urlParams.get('guildId');
      const paramVcId = urlParams.get('vcId');

      guildSelect.innerHTML = data.guilds
        .map((g) => `<option value="${g.id}">🏰 ${g.name}</option>`)
        .join('');

      state.currentGuildId =
        paramGuildId && data.guilds.some((g) => g.id === paramGuildId)
          ? paramGuildId
          : data.guilds[0].id;
      guildSelect.value = state.currentGuildId;

      await loadGuildVoiceChannels(state.currentGuildId, paramVcId);
    }
  } catch (_) {}
}

async function loadGuildVoiceChannels(guildId, preferredVcId = null) {
  try {
    const res = await fetch(`/api/guilds/${guildId}/vcs`);
    if (!res.ok) return;
    const data = await res.json();

    state.voiceChannels = data.voiceChannels || [];
    state.textChannels = data.textChannels || [];

    const vcSelect = document.getElementById('vcSelect');
    if (state.voiceChannels.length === 0) {
      vcSelect.innerHTML = `<option value="">VCチャンネルがありません</option>`;
      return;
    }

    vcSelect.innerHTML = state.voiceChannels
      .map(
        (vc) =>
          `<option value="${vc.id}">🔊 ${vc.name} (在室 ${vc.memberCount}人)</option>`
      )
      .join('');

    let chosenVc =
      state.voiceChannels.find((v) => v.id === preferredVcId) ||
      [...state.voiceChannels].sort((a, b) => b.memberCount - a.memberCount)[0];

    if (chosenVc) {
      state.currentVcId = chosenVc.id;
      state.currentVcName = chosenVc.name;
      vcSelect.value = chosenVc.id;
      if (chosenVc.members.length > 0) {
        state.members = chosenVc.members;
        state.priorityIds.clear();
        state.excludedIds.clear();
        renderMemberList();
        renderPendingState();
        showToast(`🔊 「${chosenVc.name}」の在室メンバー ${chosenVc.members.length}人を認識しました`);
      }
    }
  } catch (err) {
    console.warn('VC一覧取得失敗:', err);
  }
}

function setModeUI(mode) {
  state.mode = mode;
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });
  document
    .getElementById('configPriority')
    .classList.toggle('active', mode === 'priority');
  document
    .getElementById('configGroups')
    .classList.toggle('active', mode === 'groups');
  document
    .getElementById('configCustom')
    .classList.toggle('active', mode === 'custom');

  updateConfigPreviewText();
}

function applyPreset(presetId) {
  const preset = PRESET_DEFINITIONS[presetId];
  if (!preset) return;

  state.activePreset = presetId;
  document.querySelectorAll('.preset-card').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === presetId);
  });

  document.getElementById('currentRuleBadge').textContent = preset.name;
  state.teamNames = preset.teamNames || [];

  if (preset.mode === 'priority') {
    state.prioritySize = preset.prioritySize;
    state.maxPriorityTeams = preset.maxPriorityTeams;
    document.getElementById('prioritySizeInput').value = preset.prioritySize;
    document.getElementById('maxPriorityTeamsSelect').value =
      preset.maxPriorityTeams ? String(preset.maxPriorityTeams) : '';
    setModeUI('priority');
  } else if (preset.mode === 'groups') {
    state.groupCount = preset.groupCount;
    document.getElementById('groupCountInput').value = preset.groupCount;
    setModeUI('groups');
  } else if (preset.mode === 'custom') {
    state.customSizes = preset.customSizes.join(', ');
    document.getElementById('customSizesInput').value = state.customSizes;
    setModeUI('custom');
  }
}

function executeLottery() {
  state.moveTargets = {};
  const result = runLocalSplit();
  renderLotteryResult(result);
}

window.addEventListener('DOMContentLoaded', () => {
  renderMemberList();
  renderPendingState();
  syncWithDiscordBackend();

  document.querySelectorAll('[data-demo-count]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document
        .querySelectorAll('[data-demo-count]')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const count = parseInt(btn.dataset.demoCount, 10) || 7;
      state.members = DEMO_PLAYERS_POOL.slice(0, count);
      state.priorityIds.clear();
      state.excludedIds.clear();
      renderMemberList();
      renderPendingState();
      showToast(`🧪 VC在室メンバーを ${count}人 に設定しました`);
    });
  });

  document.getElementById('addMemberForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('newMemberInput');
    const name = input.value.trim();
    if (!name) return;
    state.members.push({
      id: `custom_${Date.now()}`,
      displayName: name,
    });
    input.value = '';
    renderMemberList();
  });

  document.getElementById('btnIncludeAll').addEventListener('click', () => {
    state.priorityIds.clear();
    state.excludedIds.clear();
    renderMemberList();
  });

  document.getElementById('btnClearExcluded').addEventListener('click', () => {
    state.excludedIds.clear();
    renderMemberList();
  });

  document.querySelectorAll('.preset-card').forEach((card) => {
    card.addEventListener('click', () => {
      applyPreset(card.dataset.preset);
    });
  });

  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      setModeUI(tab.dataset.mode);
    });
  });

  document.querySelectorAll('.stepper-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      const step = parseInt(btn.dataset.step, 10);
      const inputEl = document.getElementById(targetId);
      const min = parseInt(inputEl.min, 10) || 1;
      const max = parseInt(inputEl.max, 10) || 25;
      const nextVal = Math.max(min, Math.min(max, (parseInt(inputEl.value, 10) || min) + step));
      inputEl.value = nextVal;
      inputEl.dispatchEvent(new Event('input'));
    });
  });

  document.getElementById('prioritySizeInput').addEventListener('input', (e) => {
    state.prioritySize = parseInt(e.target.value, 10) || 5;
    document.getElementById('currentRuleBadge').textContent = `🔢 ${state.prioritySize}人チーム優先`;
    updateConfigPreviewText();
  });

  document.getElementById('maxPriorityTeamsSelect').addEventListener('change', (e) => {
    state.maxPriorityTeams = e.target.value ? parseInt(e.target.value, 10) : null;
    updateConfigPreviewText();
  });

  document.getElementById('groupCountInput').addEventListener('input', (e) => {
    state.groupCount = parseInt(e.target.value, 10) || 2;
    document.getElementById('currentRuleBadge').textContent = `🗂️ ${state.groupCount}グループ均等分け`;
    updateConfigPreviewText();
  });

  document.getElementById('customSizesInput').addEventListener('input', (e) => {
    state.customSizes = e.target.value;
    state.teamNames = [];
    document.getElementById('currentRuleBadge').textContent = `✏️ カスタム [${state.customSizes}]`;
  });

  // 🎲 チーム振り分けボタン ＆ 再振り分けボタン
  document.getElementById('btnDraw').addEventListener('click', () => {
    executeLottery();
    showToast('🎲 チーム振り分けを実行しました！');
  });

  document.getElementById('btnReroll').addEventListener('click', () => {
    executeLottery();
    showToast('🔄 メンバーを再振り分けしました！');
  });

  document.getElementById('btnCopyResult').addEventListener('click', () => {
    if (!state.lastResult) return;
    const lines = [`🎲 【VCチーム抽選結果】`];
    state.lastResult.teams.forEach((t) => {
      lines.push(`\n■ ${t.name}`);
      lines.push(
        t.members
          .map((m, i) => `  ${i + 1}. ${m.displayName}${m.isPriority ? ' ⭐' : ''}`)
          .join('\n')
      );
    });
    if (state.lastResult.excludedMembers?.length > 0) {
      lines.push(
        `\n👀 観戦・除外: ${state.lastResult.excludedMembers
          .map((m) => m.displayName)
          .join(', ')}`
      );
    }
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      showToast('📋 抽選結果をクリップボードにコピーしました！');
    });
  });

  document.getElementById('btnSendDiscord').addEventListener('click', async () => {
    if (!state.lastResult) {
      showToast('⚠️ 先に「🎲 チーム振り分けを実行する！」を押してください');
      return;
    }
    if (!state.botReady || state.currentGuildId === 'demo_guild') {
      showToast('💡 Discord未接続のため、代わりに結果をクリップボードにコピーしました');
      document.getElementById('btnCopyResult').click();
      return;
    }
    const targetChannelId = state.textChannels[0]?.id || state.currentVcId;
    try {
      const res = await fetch(`/api/guilds/${state.currentGuildId}/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelId: targetChannelId,
          vcName: state.currentVcName,
          result: state.lastResult,
        }),
      });
      if (!res.ok) throw new Error('送信エラー');
      showToast('📢 Discordのチャットへ抽選結果Embedを送信しました！');
    } catch (err) {
      showToast(`⚠️ Discord送信失敗: ${err.message}`);
    }
  });

  document
    .getElementById('btnOpenMoveModal')
    .addEventListener('click', openMoveConfirmationModal);

  const closeModal = () => {
    document.getElementById('moveModalBackdrop').classList.add('hidden');
  };
  document.getElementById('btnCloseMoveModal').addEventListener('click', closeModal);
  document.getElementById('btnCancelMove').addEventListener('click', closeModal);

  document.getElementById('btnConfirmMove').addEventListener('click', () => {
    executeMoveFromModal(false);
  });

  document.getElementById('btnGatherOriginalVc').addEventListener('click', () => {
    executeMoveFromModal(true);
  });

  document.getElementById('guildSelect').addEventListener('change', (e) => {
    state.currentGuildId = e.target.value;
    if (state.currentGuildId !== 'demo_guild') {
      loadGuildVoiceChannels(state.currentGuildId);
    }
  });

  document.getElementById('vcSelect').addEventListener('change', (e) => {
    const vcId = e.target.value;
    const found = state.voiceChannels.find((v) => v.id === vcId);
    if (found) {
      state.currentVcId = found.id;
      state.currentVcName = found.name;
      if (found.members) {
        state.members = found.members;
        state.priorityIds.clear();
        state.excludedIds.clear();
        renderMemberList();
        renderPendingState();
      }
    }
  });

  document.getElementById('btnSyncDiscord').addEventListener('click', () => {
    if (state.botReady && state.currentGuildId !== 'demo_guild') {
      loadGuildVoiceChannels(state.currentGuildId, state.currentVcId);
    } else {
      syncWithDiscordBackend();
      showToast('📡 VC情報をリフレッシュしました');
    }
  });

  const inviteModal = document.getElementById('inviteModalBackdrop');
  const clientIdInput = document.getElementById('clientIdInput');
  const generatedInviteUrlInput = document.getElementById('generatedInviteUrl');

  const updateGeneratedInvite = () => {
    const url = buildClientInviteUrl(clientIdInput.value) || state.inviteUrl || '';
    generatedInviteUrlInput.value = url;
    return url;
  };

  document.getElementById('btnInviteBot').addEventListener('click', () => {
    updateGeneratedInvite();
    inviteModal.classList.remove('hidden');
  });

  document.getElementById('btnCloseInviteModal').addEventListener('click', () => {
    inviteModal.classList.add('hidden');
  });

  clientIdInput.addEventListener('input', updateGeneratedInvite);

  document.getElementById('btnCopyInviteUrl').addEventListener('click', () => {
    const url = updateGeneratedInvite();
    if (!url) {
      showToast('⚠️ 先に Discord Application ID (数字) を入力してください');
      return;
    }
    navigator.clipboard.writeText(url).then(() => {
      showToast('📋 サーバー導入用URLをコピーしました！');
    });
  });

  document.getElementById('btnOpenInviteLink').addEventListener('click', () => {
    const url = updateGeneratedInvite();
    if (!url) {
      showToast('⚠️ 先に Discord Application ID (数字) を入力してください');
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  });

  if (new URLSearchParams(window.location.search).get('openInviteModal') === '1') {
    inviteModal.classList.remove('hidden');
  }
});
