/**
 * Discord VC 読み上げBot (TTS) エンジン
 * - ずんだもん / 四国めたん / 春日部つむぎ / 冥鳴ひまり (VOICEVOX Web API: tts.quest v3)
 * - ゆっくりボイス 霊夢風 / 魔理沙風 (Google TTS + FFmpeg 音響フィルタによる高速・無制限合成)
 * - VC内テキストチャットおよびコマンド実行チャンネルの自動読み上げキュー管理
 */

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
  NoSubscriberBehavior,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');

let ffmpegStaticPath = null;
try {
  ffmpegStaticPath = require('ffmpeg-static');
} catch (_) {}

function getFfmpegCommand() {
  return process.env.FFMPEG_PATH || ffmpegStaticPath || 'ffmpeg';
}

/**
 * 選択可能な読み上げボイス一覧
 */
const VOICE_PRESETS = {
  zunda_normal: {
    id: 'zunda_normal',
    name: 'ずんだもん（ノーマル）',
    description: 'VOICEVOX 定番の元気なずんだもんボイスなのだ！',
    engine: 'voicevox',
    speakerId: 3,
    emoji: '🟢',
  },
  zunda_amaama: {
    id: 'zunda_amaama',
    name: 'ずんだもん（あまあま）',
    description: 'VOICEVOX 甘えん坊なずんだもんボイス',
    engine: 'voicevox',
    speakerId: 1,
    emoji: '💚',
  },
  zunda_tsun: {
    id: 'zunda_tsun',
    name: 'ずんだもん（ツンツン）',
    description: 'VOICEVOX ツンツンしたずんだもんボイス',
    engine: 'voicevox',
    speakerId: 7,
    emoji: '💢',
  },
  zunda_sasayaki: {
    id: 'zunda_sasayaki',
    name: 'ずんだもん（ささやき）',
    description: 'VOICEVOX ささやき声のずんだもんボイス',
    engine: 'voicevox',
    speakerId: 22,
    emoji: '🍃',
  },
  yukkuri_reimu: {
    id: 'yukkuri_reimu',
    name: 'ゆっくりボイス（霊夢風・高速）',
    description: '待ち時間ゼロでサクサク読み上げる定番ゆっくり風ボイス',
    engine: 'yukkuri',
    pitchRate: 1.12,
    tempoRate: 0.96,
    emoji: '🎀',
  },
  yukkuri_marisa: {
    id: 'yukkuri_marisa',
    name: 'ゆっくりボイス（魔理沙風・低め）',
    description: '少し低めで聞き取りやすいゆっくり魔理沙風ボイス',
    engine: 'yukkuri',
    pitchRate: 0.96,
    tempoRate: 1.08,
    emoji: '🌟',
  },
  metan_normal: {
    id: 'metan_normal',
    name: '四国めたん（ノーマル）',
    description: 'VOICEVOX はっきり聞き取りやすいお嬢様ボイス',
    engine: 'voicevox',
    speakerId: 2,
    emoji: '🎀',
  },
  tsumugi: {
    id: 'tsumugi',
    name: '春日部つむぎ',
    description: 'VOICEVOX 明るい埼玉ギャルボイス',
    engine: 'voicevox',
    speakerId: 8,
    emoji: '🌻',
  },
  himari: {
    id: 'himari',
    name: '冥鳴ひまり',
    description: 'VOICEVOX 落ち着いた優しい死神ボイス',
    engine: 'voicevox',
    speakerId: 14,
    emoji: '🔮',
  },
  nurserobo: {
    id: 'nurserobo',
    name: 'ナースロボ＿タイプＴ',
    description: 'VOICEVOX クールなロボットナースボイス',
    engine: 'voicevox',
    speakerId: 47,
    emoji: '🤖',
  },
};

// サーバーごとの読み上げセッション管理 (guildId -> GuildTtsSession)
const ttsSessions = new Map();

// ユーザー個人のボイス設定 (userId -> voiceId)
const userVoicePrefs = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Discordのチャット文面を読み上げ用に綺麗にする
 */
function sanitizeTextForTts(rawText, guild) {
  if (!rawText) return '';
  let text = String(rawText);

  // コードブロック省略
  text = text.replace(/```[\s\S]*?```/g, ' コードブロック省略 ');
  // ネタバレ伏せ字
  text = text.replace(/\|\|[\s\S]*?\|\|/g, ' ネタバレ ');
  // URL省略
  text = text.replace(/https?:\/\/\S+/gi, ' URL省略 ');

  // ユーザーメンション <@12345> を名前に変換
  text = text.replace(/<@!?(\d+)>/g, (_, id) => {
    if (guild) {
      const m = guild.members.cache.get(id);
      if (m) return `@${m.displayName}`;
    }
    return '';
  });

  // ロールメンション・チャンネルメンション
  text = text.replace(/<@&(\d+)>/g, '');
  text = text.replace(/<#(\d+)>/g, (_, id) => {
    if (guild) {
      const c = guild.channels.cache.get(id);
      if (c) return c.name;
    }
    return 'チャンネル';
  });

  // カスタム絵文字 <:name:12345> -> name
  text = text.replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, '$1');

  // 単体の草 (w / ｗ) を「わら」に変換
  text = text.replace(/(?:^|\s)[wｗ]{1,6}(?=$|\s|[!！?？。、])/gi, ' わら ');

  // 改行や連続空白を整理
  text = text.replace(/\s+/g, ' ').trim();

  // 長文カット（110文字超は以下略）
  if (text.length > 110) {
    text = text.slice(0, 110) + '、以下略';
  }

  return text;
}

/**
 * MP3 バッファを FFmpeg で 48kHz Stereo s16le PCM ストリームに変換する
 */
function createPcmResourceFromMp3Buffer(mp3Buffer, audioFilter = null) {
  const ffmpegCmd = getFfmpegCommand();
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0'];

  if (audioFilter) {
    args.push('-af', audioFilter);
  }

  args.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

  const ff = spawn(ffmpegCmd, args, {
    stdio: ['pipe', 'pipe', 'ignore'],
  });

  const outputStream = new PassThrough();
  ff.stdout.pipe(outputStream);

  ff.on('error', (err) => {
    console.error('FFmpeg spawn error:', err.message);
    outputStream.end();
  });

  ff.stdin.on('error', () => {});
  ff.stdin.end(mp3Buffer);

  return createAudioResource(outputStream, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  });
}

/**
 * ゆっくりボイス（Google TTS + FFmpeg ゆっくり音響フィルタ）でMP3を合成
 */
async function synthesizeYukkuriMp3(text, preset) {
  const safeText = text.slice(0, 180);
  const url =
    `https://translate.google.com/translate_tts?ie=UTF-8&tl=ja&client=tw-ob` +
    `&q=${encodeURIComponent(safeText)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`Google TTS HTTP ${res.status}`);
  }

  const arrayBuf = await res.arrayBuffer();
  const mp3Buf = Buffer.from(arrayBuf);

  const pitch = preset?.pitchRate || 1.12;
  const tempo = preset?.tempoRate || 0.96;
  // ピッチ変更＋テンポ補正でゆっくりボイス特有の声質を作る
  const filter = `asetrate=24000*${pitch},aresample=48000,atempo=${tempo}`;

  return createPcmResourceFromMp3Buffer(mp3Buf, filter);
}

/**
 * VOICEVOX Web API (tts.quest v3) でずんだもん等の音声を合成
 * API混雑時は自動的にゆっくりボイスへフォールバックして無音を防ぐ
 */
async function synthesizeVoicevoxResource(text, preset) {
  const speakerId = preset.speakerId ?? 3;
  const apiKey = process.env.VOICEVOX_API_KEY || '';
  let apiUrl =
    `https://api.tts.quest/v3/voicevox/synthesis` +
    `?speaker=${speakerId}&text=${encodeURIComponent(text)}`;
  if (apiKey) {
    apiUrl += `&key=${encodeURIComponent(apiKey)}`;
  }

  const res = await fetch(apiUrl);
  const data = await res.json();

  // レート制限 (retryAfter) が返ってきた場合は少し待つかフォールバック
  if (!data.success && data.retryAfter) {
    const waitSec = Math.min(Number(data.retryAfter) || 2, 4);
    await sleep(waitSec * 1000);
    const retryRes = await fetch(apiUrl);
    const retryData = await retryRes.json();
    if (!retryData.success || !retryData.mp3DownloadUrl) {
      return synthesizeYukkuriMp3(text, VOICE_PRESETS.yukkuri_reimu);
    }
    return downloadVoicevoxMp3WhenReady(retryData);
  }

  if (!data.success || !data.mp3DownloadUrl) {
    return synthesizeYukkuriMp3(text, VOICE_PRESETS.yukkuri_reimu);
  }

  return downloadVoicevoxMp3WhenReady(data);
}

async function downloadVoicevoxMp3WhenReady(data) {
  const statusUrl = data.audioStatusUrl;
  const mp3Url = data.mp3DownloadUrl;

  // 最大12秒間（400ms × 30回）生成完了をポーリング
  for (let i = 0; i < 30; i++) {
    try {
      const stRes = await fetch(statusUrl);
      if (stRes.ok) {
        const st = await stRes.json();
        if (st.isAudioReady) break;
        if (st.isAudioError) {
          throw new Error('VOICEVOX audio synthesis error');
        }
      }
    } catch (_) {}
    await sleep(400);
  }

  const audioRes = await fetch(mp3Url);
  if (!audioRes.ok) {
    throw new Error(`Failed to download VOICEVOX mp3: ${audioRes.status}`);
  }
  const arrayBuf = await audioRes.arrayBuffer();
  const mp3Buf = Buffer.from(arrayBuf);

  return createPcmResourceFromMp3Buffer(mp3Buf, null);
}

/**
 * テキストとボイスIDから再生可能な AudioResource を生成する
 */
async function createTtsAudioResource(text, voiceId = 'zunda_normal') {
  const preset = VOICE_PRESETS[voiceId] || VOICE_PRESETS.zunda_normal;

  try {
    if (preset.engine === 'yukkuri') {
      return await synthesizeYukkuriMp3(text, preset);
    }
    return await synthesizeVoicevoxResource(text, preset);
  } catch (err) {
    console.warn(`⚠️ TTS合成フォールバック (${preset.name}):`, err.message);
    return await synthesizeYukkuriMp3(text, VOICE_PRESETS.yukkuri_reimu);
  }
}

/**
 * サーバー（Guild）ごとのVC接続＆読み上げキュー管理クラス
 */
class GuildTtsSession {
  constructor(guild, vcChannel, textChannelId, defaultVoice = 'zunda_normal') {
    this.guildId = guild.id;
    this.vcId = vcChannel.id;
    this.vcName = vcChannel.name;
    this.defaultVoice = VOICE_PRESETS[defaultVoice] ? defaultVoice : 'zunda_normal';
    this.readSpeakerName = false; // 発言者名を読むかどうか

    // 読み上げ対象のチャンネルIDセット（VC自体のテキストチャット ＋ `/join` を実行したチャンネル）
    this.boundChannelIds = new Set([vcChannel.id]);
    if (textChannelId) {
      this.boundChannelIds.add(textChannelId);
    }

    this.queue = [];
    this.isProcessing = false;

    this.player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play,
      },
    });

    this.connection = joinVoiceChannel({
      channelId: vcChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.connection.subscribe(this.player);

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.isProcessing = false;
      this.processNext();
    });

    this.player.on('error', (err) => {
      console.error('AudioPlayer error:', err.message);
      this.isProcessing = false;
      this.processNext();
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch (_) {
        this.destroy();
      }
    });
  }

  enqueue(text, voiceId = null) {
    if (!text || !text.trim()) return;
    if (this.queue.length >= 25) {
      this.queue.shift();
    }
    this.queue.push({
      text: text.trim(),
      voiceId: voiceId || this.defaultVoice,
    });
    if (!this.isProcessing) {
      this.processNext();
    }
  }

  async processNext() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const item = this.queue.shift();
    try {
      const resource = await createTtsAudioResource(item.text, item.voiceId);
      if (resource.volume) {
        resource.volume.setVolume(1.0);
      }
      this.player.play(resource);
    } catch (err) {
      console.error('TTS play error:', err.message);
      this.isProcessing = false;
      this.processNext();
    }
  }

  skip() {
    this.queue = [];
    this.player.stop(true);
    this.isProcessing = false;
  }

  destroy() {
    this.queue = [];
    try {
      this.player.stop(true);
    } catch (_) {}
    try {
      this.connection.destroy();
    } catch (_) {}
    ttsSessions.delete(this.guildId);
  }
}

/**
 * VCに読み上げBotを参加させる（すでに接続中なら移動または設定更新）
 */
function joinVcForTts(guild, vcChannel, textChannelId, voiceId = 'zunda_normal') {
  const existing = ttsSessions.get(guild.id);
  if (existing) {
    existing.destroy();
  }
  const session = new GuildTtsSession(guild, vcChannel, textChannelId, voiceId);
  ttsSessions.set(guild.id, session);

  // 入室挨拶を読み上げ
  const preset = VOICE_PRESETS[session.defaultVoice];
  const greeting =
    session.defaultVoice.startsWith('zunda')
      ? '読み上げを開始するのだ！よろしくなのだ！'
      : '読み上げを開始します。ゆっくりしていってね！';
  session.enqueue(greeting, session.defaultVoice);

  return session;
}

module.exports = {
  VOICE_PRESETS,
  ttsSessions,
  userVoicePrefs,
  sanitizeTextForTts,
  joinVcForTts,
};
