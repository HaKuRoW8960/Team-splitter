/**
 * Discord VC 読み上げBot (TTS) エンジン (純粋JS WAV PCMアップサンプラー搭載・外部バイナリ不要)
 * - ずんだもん / 四国めたん / 春日部つむぎ / 冥鳴ひまり / ゆっくり風ボイス
 * - 24kHz 16bit Mono WAV を純粋Node.jsで 48kHz 16bit Stereo s16le PCM に変換して再生
 */

const { Readable } = require('stream');

let voiceLib = null;
let voiceEngineError = null;
try {
  voiceLib = require('@discordjs/voice');
} catch (err) {
  voiceEngineError = err.message;
  console.error('Failed to load @discordjs/voice:', err.message);
}

/**
 * 選択可能な読み上げボイス一覧
 */
const VOICE_PRESETS = {
  zunda_normal: {
    id: 'zunda_normal',
    name: 'ずんだもん（ノーマル）',
    description: 'VOICEVOX 定番の元気なずんだもんボイスなのだ！',
    speakerId: 3,
    pitchStep: 1.0,
    emoji: '🟢',
  },
  zunda_amaama: {
    id: 'zunda_amaama',
    name: 'ずんだもん（あまあま）',
    description: 'VOICEVOX 甘えん坊なずんだもんボイス',
    speakerId: 1,
    pitchStep: 1.0,
    emoji: '💚',
  },
  zunda_tsun: {
    id: 'zunda_tsun',
    name: 'ずんだもん（ツンツン）',
    description: 'VOICEVOX ツンツンしたずんだもんボイス',
    speakerId: 7,
    pitchStep: 1.0,
    emoji: '💢',
  },
  zunda_sasayaki: {
    id: 'zunda_sasayaki',
    name: 'ずんだもん（ささやき）',
    description: 'VOICEVOX ささやき声のずんだもんボイス',
    speakerId: 22,
    pitchStep: 1.0,
    emoji: '🍃',
  },
  yukkuri_reimu: {
    id: 'yukkuri_reimu',
    name: 'ゆっくりボイス（霊夢風）',
    description: '定番のゆっくり霊夢風トーンで読み上げます',
    speakerId: 47,
    pitchStep: 1.06,
    emoji: '🎀',
  },
  yukkuri_marisa: {
    id: 'yukkuri_marisa',
    name: 'ゆっくりボイス（魔理沙風）',
    description: '少し低めで聞き取りやすいゆっくり魔理沙風トーン',
    speakerId: 2,
    pitchStep: 0.94,
    emoji: '🌟',
  },
  metan_normal: {
    id: 'metan_normal',
    name: '四国めたん（ノーマル）',
    description: 'VOICEVOX はっきり聞き取りやすいお嬢様ボイス',
    speakerId: 2,
    pitchStep: 1.0,
    emoji: '🎀',
  },
  tsumugi: {
    id: 'tsumugi',
    name: '春日部つむぎ',
    description: 'VOICEVOX 明るい埼玉ギャルボイス',
    speakerId: 8,
    pitchStep: 1.0,
    emoji: '🌻',
  },
  himari: {
    id: 'himari',
    name: '冥鳴ひまり',
    description: 'VOICEVOX 落ち着いた優しい死神ボイス',
    speakerId: 14,
    pitchStep: 1.0,
    emoji: '🔮',
  },
  nurserobo: {
    id: 'nurserobo',
    name: 'ナースロボ＿タイプＴ',
    description: 'VOICEVOX クールなロボットナースボイス',
    speakerId: 47,
    pitchStep: 1.0,
    emoji: '🤖',
  },
};

const ttsSessions = new Map();
const userVoicePrefs = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Discordのチャット文面を読み上げ用に綺麗にする
 */
function sanitizeTextForTts(rawText, guild) {
  if (!rawText) return '';
  let text = String(rawText);

  text = text.replace(/```[\s\S]*?```/g, ' コードブロック省略 ');
  text = text.replace(/\|\|[\s\S]*?\|\|/g, ' ネタバレ ');
  text = text.replace(/https?:\/\/\S+/gi, ' URL省略 ');

  text = text.replace(/<@!?(\d+)>/g, (_, id) => {
    if (guild) {
      const m = guild.members.cache.get(id);
      if (m) return `@${m.displayName}`;
    }
    return '';
  });

  text = text.replace(/<@&(\d+)>/g, '');
  text = text.replace(/<#(\d+)>/g, (_, id) => {
    if (guild) {
      const c = guild.channels.cache.get(id);
      if (c) return c.name;
    }
    return 'チャンネル';
  });

  text = text.replace(/<a?:([a-zA-Z0-9_]+):\d+>/g, '$1');
  text = text.replace(/(?:^|\s)[wｗ]{1,6}(?=$|\s|[!！?？。、])/gi, ' わら ');
  text = text.replace(/\s+/g, ' ').trim();

  if (text.length > 110) {
    text = text.slice(0, 110) + '、以下略';
  }

  return text;
}

/**
 * 純粋Node.jsで 16-bit WAV バッファを 48kHz Stereo s16le PCM にリサンプリング変換する（FFmpeg不要）
 */
function wavBufferTo48kStereoPcmResource(wavBuf, pitchStep = 1.0) {
  const channels = wavBuf.readUInt16LE(22) || 1;
  const inSampleRate = wavBuf.readUInt32LE(24) || 24000;

  let dataOffset = 44;
  let dataLength = wavBuf.length - 44;
  for (let i = 12; i < Math.min(wavBuf.length - 8, 256); i++) {
    if (
      wavBuf[i] === 0x64 &&
      wavBuf[i + 1] === 0x61 &&
      wavBuf[i + 2] === 0x74 &&
      wavBuf[i + 3] === 0x61
    ) {
      dataLength = wavBuf.readUInt32LE(i + 4);
      dataOffset = i + 8;
      break;
    }
  }

  const availableBytes = Math.min(dataLength, wavBuf.length - dataOffset);
  const frameSize = channels * 2;
  const totalInFrames = Math.floor(availableBytes / frameSize);

  const outSampleRate = 48000;
  const step = (inSampleRate / outSampleRate) * (pitchStep || 1.0);
  const totalOutFrames = Math.max(1, Math.floor(totalInFrames / step));

  const outBuf = Buffer.alloc(totalOutFrames * 4);

  for (let outIdx = 0; outIdx < totalOutFrames; outIdx++) {
    const srcPos = outIdx * step;
    const idx0 = Math.min(totalInFrames - 1, Math.floor(srcPos));
    const idx1 = Math.min(totalInFrames - 1, idx0 + 1);
    const frac = srcPos - idx0;

    const sample0 = wavBuf.readInt16LE(dataOffset + idx0 * frameSize);
    const sample1 = wavBuf.readInt16LE(dataOffset + idx1 * frameSize);
    const interpolated = Math.max(
      -32768,
      Math.min(32767, Math.round(sample0 + (sample1 - sample0) * frac))
    );

    const outByteOffset = outIdx * 4;
    outBuf.writeInt16LE(interpolated, outByteOffset);
    outBuf.writeInt16LE(interpolated, outByteOffset + 2);
  }

  const stream = Readable.from([outBuf]);
  return voiceLib.createAudioResource(stream, {
    inputType: voiceLib.StreamType.Raw,
    inlineVolume: true,
  });
}

/**
 * VOICEVOX Web API (tts.quest v3) から WAV を取得し、純粋JSで 48kHz Stereo PCM リソースを生成
 */
async function createTtsAudioResource(text, voiceId = 'zunda_normal') {
  const preset = VOICE_PRESETS[voiceId] || VOICE_PRESETS.zunda_normal;
  const speakerId = preset.speakerId ?? 3;
  const apiKey = process.env.VOICEVOX_API_KEY || '';
  let apiUrl =
    `https://api.tts.quest/v3/voicevox/synthesis` +
    `?speaker=${speakerId}&text=${encodeURIComponent(text)}`;
  if (apiKey) {
    apiUrl += `&key=${encodeURIComponent(apiKey)}`;
  }

  let res = await fetch(apiUrl);
  let data = await res.json();

  if (!data.success && data.retryAfter) {
    const waitSec = Math.min(Number(data.retryAfter) || 2, 5);
    await sleep(waitSec * 1000);
    res = await fetch(apiUrl);
    data = await res.json();
  }

  if (!data.success || !data.wavDownloadUrl) {
    throw new Error('tts.quest synthesis unavailable');
  }

  const statusUrl = data.audioStatusUrl;
  const wavUrl = data.wavDownloadUrl;

  for (let i = 0; i < 30; i++) {
    try {
      const stRes = await fetch(statusUrl);
      if (stRes.ok) {
        const st = await stRes.json();
        if (st.isAudioReady) break;
        if (st.isAudioError) throw new Error('VOICEVOX synthesis error');
      }
    } catch (_) {}
    await sleep(400);
  }

  const wavRes = await fetch(wavUrl);
  if (!wavRes.ok) {
    throw new Error(`WAV download HTTP ${wavRes.status}`);
  }
  const arrayBuf = await wavRes.arrayBuffer();
  const wavBuf = Buffer.from(arrayBuf);

  return wavBufferTo48kStereoPcmResource(wavBuf, preset.pitchStep || 1.0);
}

/**
 * サーバー（Guild）ごとのVC接続＆読み上げキュー管理クラス
 */
class GuildTtsSession {
  constructor(guild, vcChannel, textChannelId, defaultVoice = 'zunda_normal') {
    if (!voiceLib) {
      throw new Error(`音声ライブラリ未ロード: ${voiceEngineError}`);
    }
    this.guildId = guild.id;
    this.vcId = vcChannel.id;
    this.vcName = vcChannel.name;
    this.defaultVoice = VOICE_PRESETS[defaultVoice] ? defaultVoice : 'zunda_normal';
    this.readSpeakerName = false;

    this.boundChannelIds = new Set([vcChannel.id]);
    if (textChannelId) {
      this.boundChannelIds.add(textChannelId);
    }

    this.queue = [];
    this.isProcessing = false;

    this.player = voiceLib.createAudioPlayer({
      behaviors: {
        noSubscriber: voiceLib.NoSubscriberBehavior.Play,
      },
    });

    this.connection = voiceLib.joinVoiceChannel({
      channelId: vcChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    this.connection.subscribe(this.player);

    this.player.on(voiceLib.AudioPlayerStatus.Idle, () => {
      this.isProcessing = false;
      this.processNext();
    });

    this.player.on('error', (err) => {
      console.error('AudioPlayer error:', err.message);
      this.isProcessing = false;
      this.processNext();
    });

    this.connection.on(voiceLib.VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          voiceLib.entersState(this.connection, voiceLib.VoiceConnectionStatus.Signalling, 5000),
          voiceLib.entersState(this.connection, voiceLib.VoiceConnectionStatus.Connecting, 5000),
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

function joinVcForTts(guild, vcChannel, textChannelId, voiceId = 'zunda_normal') {
  const existing = ttsSessions.get(guild.id);
  if (existing) {
    existing.destroy();
  }
  const session = new GuildTtsSession(guild, vcChannel, textChannelId, voiceId);
  ttsSessions.set(guild.id, session);

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
  wavBufferTo48kStereoPcmResource,
  joinVcForTts,
};
