// 音源解灰与歌词兜底插件 (echo-music-unblock v1.1.0)
// 基于 EchoMusic v2.3.2+ 原生极简组件规范与 ctx.player.audioSource / ctx.lyrics：
// 1. 本地授权目录无损/音频直通 (local)
// 2. 酷狗同曲异版智能替换 (kugou-alt)
// 3. 外部多平台音源接口解灰 (external: GDStudio / Meting / 网易云 / 自定义 API)
// 4. 描述符持久化锁定与过期外链按需刷新 (pinned) + 仅本次试听 (session override)
// 5. 多源双语歌词兜底 (本地 .lrc / 酷狗异版 / 网易云原文+翻译双语合并 / LRCLIB)
// 6. 原生 Dialog 换源弹窗 + 原生 Tabs/Drawer/Popconfirm 管理中心 + 跨插件下载协同

const PLUGIN_VERSION = '1.1.0';
const STORAGE_SETTINGS = 'emu.settings.v1';
const STORAGE_PINNED = 'emu.pinned.v1';
const STORAGE_HISTORY = 'emu.history.v1';
const MAX_HISTORY_ITEMS = 80;
const LOCAL_SCAN_LIMIT = 10000;
const PINNED_URL_TTL_MS = 20 * 60 * 1000;

const EXTERNAL_PLATFORMS = [
  { id: 'netease', label: '网易云音乐', short: 'NETEASE' },
  { id: 'kuwo', label: '酷我音乐', short: 'KUWO' },
  { id: 'tencent', label: 'QQ 音乐', short: 'TENCENT' },
];

const DEFAULT_SETTINGS = {
  enabled: true,
  localPriority: true,
  enableLocal: true,
  enableKugouAlt: true,
  enableExternalApi: true,
  upgradeLowQuality: false,
  enableLyricFallback: true,
  bilingualLyric: true,
  customApiUrl: '',
  preferredExternalSources: ['netease', 'kuwo', 'tencent'],
  localFolders: [],
};

const CHANNEL_META = {
  pinned: { label: '锁定源', short: '锁定' },
  local: { label: '本地曲库', short: '本地' },
  'kugou-alt': { label: '酷狗异版', short: '异版' },
  external: { label: '外部音源', short: '解灰' },
};

const CHANNEL_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'local', label: '本地' },
  { id: 'kugou-alt', label: '酷狗异版' },
  { id: 'external', label: '外部' },
];

// ---- 文本归一化、时长格式化与相似度计算 ----

const UNWANTED_VARIANT_RE = /(伴奏|卡拉ok|karaoke|instrumental|off\s*vocal|纯音乐版|dj版|dj\s*remix|慢摇|喊麦)/i;

const normalizeText = (value) => {
  const raw = String(value ?? '').toLowerCase();
  if (!raw) return '';
  return raw
    .replace(/[（(【\[].*?[）)】\]]/g, '')
    .replace(/\b(feat\.?|ft\.?|live|ver\.?|version|remaster(?:ed)?)\b/gi, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .trim();
};

const formatDuration = (sec) => {
  const total = Math.round(Number(sec) || 0);
  if (total <= 0) return '';
  const mins = Math.floor(total / 60);
  const rem = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
};

const formatDurationCompare = (targetSec, candSec) => {
  const cand = Math.round(Number(candSec) || 0);
  if (cand <= 0) return '';
  const fmt = formatDuration(cand);
  const target = Math.round(Number(targetSec) || 0);
  if (target <= 0) return fmt;
  const diff = cand - target;
  if (Math.abs(diff) <= 2) return `${fmt} · 时长一致`;
  return `${fmt} (${diff > 0 ? '+' : ''}${diff}s)`;
};

const formatShortTime = (timestamp) => {
  const ts = Number(timestamp) || 0;
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return '';
  }
};

const extractSongMeta = (song) => {
  if (!song || typeof song !== 'object') {
    return { id: '', hash: '', title: '', artist: '', album: '', duration: 0, coverUrl: '' };
  }
  const title = String(song.title ?? song.name ?? song.SongName ?? song.songname ?? '').trim();
  const artist = String(
    song.artist ||
      (Array.isArray(song.artists) ? song.artists.map((a) => a?.name || a).filter(Boolean).join(' / ') : '') ||
      (Array.isArray(song.singers) ? song.singers.map((a) => a?.name || a).filter(Boolean).join(' / ') : '') ||
      song.SingerName ||
      song.singername ||
      '',
  ).trim();
  const album = String(song.album ?? song.albumName ?? song.AlbumName ?? song.album_name ?? '').trim();
  const rawDur = Number(song.duration ?? song.Duration ?? song.timelength ?? 0);
  const duration =
    Number.isFinite(rawDur) && rawDur > 0
      ? rawDur > 10000
        ? Math.round(rawDur / 1000)
        : Math.round(rawDur)
      : 0;
  const hash = String(song.hash ?? song.FileHash ?? song.filehash ?? '').trim();
  const id = String(song.id ?? song.mixSongId ?? song.albumAudioId ?? hash ?? '').trim();
  const coverUrl = String(song.coverUrl ?? song.cover ?? song.img ?? song.Image ?? '').trim();
  return { id, hash, title, artist, album, duration, coverUrl };
};

const getTrackKey = (song) => {
  if (typeof song === 'string') return song.trim();
  const meta = extractSongMeta(song);
  if (meta.hash) return `hash:${meta.hash.toLowerCase()}`;
  if (meta.id) return `id:${meta.id}`;
  const normTitle = normalizeText(meta.title);
  const normArtist = normalizeText(meta.artist);
  return normTitle ? `meta:${normArtist}:${normTitle}` : '';
};

const calcTitleSimilarity = (targetTitle, candTitle) => {
  const a = normalizeText(targetTitle);
  const b = normalizeText(candTitle);
  if (!a || !b) return 0;
  const targetHasVariant = UNWANTED_VARIANT_RE.test(String(targetTitle || ''));
  const candHasVariant = UNWANTED_VARIANT_RE.test(String(candTitle || ''));
  if (!targetHasVariant && candHasVariant) return 0.15;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
    return ratio >= 0.6 ? 0.88 : 0.72;
  }
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const ch of setA) {
    if (setB.has(ch)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return union > 0 ? inter / union : 0;
};

const calcArtistSimilarity = (targetArtist, candArtist) => {
  const a = normalizeText(targetArtist);
  const b = normalizeText(candArtist);
  if (!a) return 0.6;
  if (!b) return 0.2;
  if (a === b) return 1;
  const partsA = String(targetArtist || '')
    .split(/[/、&,，;；\s]+/)
    .map(normalizeText)
    .filter(Boolean);
  const partsB = String(candArtist || '')
    .split(/[/、&,，;；\s]+/)
    .map(normalizeText)
    .filter(Boolean);
  for (const pa of partsA) {
    for (const pb of partsB) {
      if (pa === pb || pa.includes(pb) || pb.includes(pa)) return 0.92;
    }
  }
  return 0;
};

const calcDurationSimilarity = (targetSec, candSec) => {
  const a = Number(targetSec) || 0;
  const b = Number(candSec) || 0;
  if (a <= 0 || b <= 0) return 0.65;
  const diff = Math.abs(a - b);
  if (diff <= 3) return 1;
  if (diff <= 8) return 0.82;
  if (diff <= 15) return 0.55;
  if (diff <= 30) return 0.25;
  return 0;
};

const scoreCandidate = (targetMeta, candMeta) => {
  const titleScore = calcTitleSimilarity(targetMeta.title, candMeta.title);
  if (titleScore < 0.45) return 0;
  const artistScore = calcArtistSimilarity(targetMeta.artist, candMeta.artist);
  const durScore = calcDurationSimilarity(targetMeta.duration, candMeta.duration);
  return Number((titleScore * 0.55 + artistScore * 0.3 + durScore * 0.15).toFixed(3));
};

// ---- 歌词工具（双语合并） ----

const parseLrcLinesToMap = (lrcText) => {
  const map = new Map();
  const lines = String(lrcText || '').split(/\r?\n/);
  const timeRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of lines) {
    const matches = [...line.matchAll(timeRe)];
    if (!matches.length) continue;
    const content = line.replace(timeRe, '').trim();
    if (!content) continue;
    for (const m of matches) {
      const min = Number(m[1]) || 0;
      const sec = Number(m[2]) || 0;
      const msRaw = String(m[3] || '0').padEnd(3, '0').slice(0, 3);
      const key = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${msRaw.slice(0, 2)}`;
      map.set(key, content);
    }
  }
  return map;
};

const mergeBilingualLrc = (origLrc, transLrc) => {
  const orig = String(origLrc || '').replace(/^\uFEFF/, '').trim();
  const trans = String(transLrc || '').replace(/^\uFEFF/, '').trim();
  if (!orig) return trans;
  if (!trans) return orig;
  const transMap = parseLrcLinesToMap(trans);
  if (transMap.size === 0) return orig;

  const timeRe = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
  const out = [];
  for (const line of orig.split(/\r?\n/)) {
    out.push(line);
    const m = timeRe.exec(line);
    if (!m) continue;
    const min = Number(m[1]) || 0;
    const sec = Number(m[2]) || 0;
    const msRaw = String(m[3] || '0').padEnd(3, '0').slice(0, 3);
    const key = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${msRaw.slice(0, 2)}`;
    const tContent = transMap.get(key);
    if (tContent && tContent !== '//') {
      out.push(`${m[0]}${tContent}`);
    }
  }
  return out.join('\n');
};

const extractUrlsFromSongUrlResponse = (payload) => {
  const urls = [];
  const visit = (val) => {
    if (!val) return;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (/^https?:\/\//i.test(trimmed) && !urls.includes(trimmed)) urls.push(trimmed);
      return;
    }
    if (Array.isArray(val)) {
      val.forEach(visit);
      return;
    }
    if (typeof val === 'object') {
      visit(val.url);
      visit(val.play_url);
      visit(val.playUrl);
      visit(val.backupUrl);
      visit(val.backup_url);
      visit(val.backupUrls);
      if (val.data) visit(val.data);
      if (val.info) visit(val.info);
    }
  };
  visit(payload);
  return urls;
};

const parseFilenameTitleArtist = (fileName) => {
  const base = String(fileName || '')
    .replace(/\.[^.]+$/, '')
    .replace(/^\d+\s*[.\-_]\s*/, '')
    .trim();
  const sepIdx = base.indexOf(' - ');
  if (sepIdx > 0 && sepIdx < base.length - 3) {
    return {
      artist: base.slice(0, sepIdx).trim(),
      title: base.slice(sepIdx + 3).trim(),
    };
  }
  return { artist: '', title: base };
};

const getFsGrantApi = (ctx) => {
  if (ctx?.fs && typeof ctx.fs.requestDirectory === 'function') return ctx.fs;
  if (ctx?.fs?.files && typeof ctx.fs.files.requestDirectory === 'function') return ctx.fs.files;
  return null;
};

const normalizePinnedEntry = (trackKey, raw) => {
  if (!raw || typeof raw !== 'object') return null;
  const now = Date.now();
  return {
    trackKey,
    targetTitle: String(raw.targetTitle ?? raw.title ?? '').trim(),
    targetArtist: String(raw.targetArtist ?? raw.artist ?? '').trim(),
    targetAlbum: String(raw.targetAlbum ?? '').trim(),
    targetDuration: Number(raw.targetDuration) || 0,
    channel: String(raw.channel || 'external'),
    provider: String(raw.provider || ''),
    sourcePlatform: String(raw.sourcePlatform || ''),
    externalId: String(raw.externalId || ''),
    lyricId: String(raw.lyricId || ''),
    hash: String(raw.hash || ''),
    fallbackHashes: Array.isArray(raw.fallbackHashes) ? raw.fallbackHashes.filter(Boolean) : [],
    localItem:
      raw.localItem && typeof raw.localItem === 'object'
        ? {
            name: String(raw.localItem.name || ''),
            path: String(raw.localItem.path || ''),
            baseKey: String(raw.localItem.baseKey || ''),
            folderName: String(raw.localItem.folderName || ''),
            ext: String(raw.localItem.ext || ''),
            quality: String(raw.localItem.quality || ''),
          }
        : null,
    quality: String(raw.quality || '320'),
    ext: String(raw.ext || (raw.quality === 'flac' ? 'flac' : 'mp3')),
    channelLabel: String(raw.channelLabel || CHANNEL_META[raw.channel]?.label || '锁定音源'),
    title: String(raw.title ?? raw.targetTitle ?? '').trim(),
    artist: String(raw.artist ?? raw.targetArtist ?? '').trim(),
    album: String(raw.album ?? '').trim(),
    duration: Number(raw.duration) || 0,
    url: String(raw.url || '').trim(),
    urlCachedAt: Number(raw.urlCachedAt ?? raw.updatedAt ?? now) || now,
    updatedAt: Number(raw.updatedAt ?? now) || now,
  };
};

const formatPinnedDescriptorHint = (entry) => {
  if (!entry) return '';
  if (entry.channel === 'local') {
    const folder = entry.localItem?.folderName || '本地目录';
    const fileName = entry.localItem?.name || entry.title;
    return fileName ? `${folder} · ${fileName}` : folder;
  }
  if (entry.channel === 'kugou-alt') {
    return entry.hash ? `酷狗异版 · ${entry.hash.slice(0, 8)}` : '酷狗同曲异版';
  }
  const parts = [];
  if (entry.provider === 'gdstudio') parts.push('GDStudio');
  else if (entry.provider === 'netease-direct') parts.push('NetEase');
  else if (entry.sourcePlatform === 'custom') parts.push('自定义 API');
  if (entry.sourcePlatform && entry.sourcePlatform !== 'custom') {
    parts.push(entry.sourcePlatform.toUpperCase());
  }
  if (entry.externalId) parts.push(`#${entry.externalId}`);
  return parts.join(' · ') || entry.channelLabel || '外部音源';
};

// ---- 核心状态与解灰引擎 ----

const createUnblockEngine = (ctx) => {
  const { reactive } = ctx.vue;
  let scanSeq = 0;

  const state = reactive({
    settings: {
      ...DEFAULT_SETTINGS,
      preferredExternalSources: [...DEFAULT_SETTINGS.preferredExternalSources],
      localFolders: [],
    },
    pinned: {},
    sessionOverrides: {},
    history: [],
    localIndex: [],
    localLyricIndex: new Map(),
    localScanning: false,
    activeTrackStatus: null,
    dialogOpen: false,
    modalTargetTrack: null,
    candidatesTrackKey: '',
    scanningCandidates: false,
    candidates: [],
    testingApi: false,
    testApiResult: '',
    testApiOk: null,
  });

  const saveSettings = async (patch = {}) => {
    Object.assign(state.settings, patch);
    try {
      await ctx.storage.set(STORAGE_SETTINGS, JSON.parse(JSON.stringify(state.settings)));
    } catch {}
  };

  const savePinned = async () => {
    try {
      await ctx.storage.set(STORAGE_PINNED, JSON.parse(JSON.stringify(state.pinned)));
    } catch {}
  };

  const recordHistory = async (entry) => {
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: Date.now(),
      ...entry,
    };
    state.history = [item, ...state.history.filter((h) => h.trackKey !== entry.trackKey)].slice(
      0,
      MAX_HISTORY_ITEMS,
    );
    try {
      await ctx.storage.set(STORAGE_HISTORY, JSON.parse(JSON.stringify(state.history)));
    } catch {}
  };

  const clearHistory = async () => {
    state.history = [];
    try {
      await ctx.storage.set(STORAGE_HISTORY, []);
    } catch {}
    ctx.toast?.info?.('已清空解灰记录');
  };

  // 扫描本地授权文件夹索引
  const rebuildLocalIndex = async () => {
    if (state.localScanning) return state.localIndex;
    state.localScanning = true;
    const audioList = [];
    const lyricMap = new Map();
    try {
      const folders = [...(state.settings.localFolders || [])];
      const fsGrants = getFsGrantApi(ctx);
      if (fsGrants && typeof fsGrants.listDirectoryGrants === 'function') {
        try {
          const grants = await fsGrants.listDirectoryGrants();
          if (Array.isArray(grants)) {
            for (const g of grants) {
              if (
                g &&
                g.id &&
                g.available !== false &&
                !folders.some((f) => f.id === g.id || (g.displayPath && f.path === g.displayPath))
              ) {
                folders.push({
                  id: g.id,
                  name: g.name || '已授权目录',
                  path: g.displayPath || g.name || g.id,
                  directoryRef: g,
                });
              }
            }
          }
        } catch {}
      }

      const ingestFileEntries = (files, folderName, ownerBridge = null) => {
        if (!Array.isArray(files)) return;
        for (const file of files) {
          const ext = String(file.extension || file.name?.match(/\.[^.]+$/)?.[0] || '').toLowerCase();
          const baseKey = String(file.name || '')
            .replace(/\.[^.]+$/, '')
            .toLowerCase()
            .trim();
          if (file.kind === 'lyric' || ext === '.lrc') {
            if (baseKey && !lyricMap.has(baseKey)) {
              lyricMap.set(baseKey, { ...file, ownerBridge });
            }
            continue;
          }
          if (file.kind === 'audio' || /\.(flac|mp3|wav|m4a|ogg|aac|opus)$/i.test(ext)) {
            const parsed = parseFilenameTitleArtist(file.name);
            const isLossless = ext === '.flac' || ext === '.wav';
            audioList.push({
              name: file.name,
              title: parsed.title,
              artist: parsed.artist,
              ext: ext.replace(/^\./, '') || 'mp3',
              quality: isLossless ? 'flac' : '320',
              size: file.size || 0,
              path: file.path || '',
              url: file.url || '',
              fileRef: file.file || null,
              baseKey,
              folderName: folderName || '本地目录',
              ownerBridge,
            });
          }
        }
      };

      const dlBridge = globalThis.__echoMusicDownload;
      if (dlBridge && typeof dlBridge.listLocalFiles === 'function') {
        try {
          const dlRes = await dlBridge.listLocalFiles();
          if (dlRes?.ok && Array.isArray(dlRes.files)) {
            ingestFileEntries(dlRes.files, '已下载曲库', dlBridge);
          }
        } catch {}
      }

      for (const folder of folders) {
        try {
          const target =
            folder.directoryRef ||
            (folder.id
              ? { id: folder.id, name: folder.name, access: 'read', kind: 'user', available: true }
              : folder.path);
          if (!target || typeof ctx.fs?.listFiles !== 'function') continue;
          const res = await ctx.fs.listFiles(target, {
            recursive: true,
            extensions: ['mp3', 'flac', 'm4a', 'wav', 'ogg', 'aac', 'opus', 'lrc'],
            limit: LOCAL_SCAN_LIMIT,
          });
          if (!res?.ok || !Array.isArray(res.files)) continue;
          ingestFileEntries(res.files, folder.name || '本地目录', null);
        } catch (err) {
          console.warn('[echo-music-unblock] 扫描目录失败:', folder, err?.message || err);
        }
      }
    } finally {
      state.localIndex = audioList;
      state.localLyricIndex = lyricMap;
      state.localScanning = false;
    }
    return audioList;
  };

  const resolveLocalFilePlayUrl = async (item) => {
    if (!item) return '';
    if (item.url && /^file:\/\//i.test(item.url)) return item.url;
    if (item.path && typeof ctx.fs?.getFileUrl === 'function') {
      try {
        const r = await ctx.fs.getFileUrl(item.path);
        if (r?.ok && r.url) return r.url;
      } catch {}
    }
    if (item.fileRef && item.ownerBridge && typeof item.ownerBridge.openLocalMedia === 'function') {
      try {
        const lease = await item.ownerBridge.openLocalMedia(item.fileRef);
        if (lease?.url) return lease.url;
      } catch {}
    }
    const fsGrants = getFsGrantApi(ctx);
    if (item.fileRef && fsGrants && typeof fsGrants.openMedia === 'function') {
      try {
        const lease = await fsGrants.openMedia(item.fileRef);
        if (lease?.url) return lease.url;
      } catch {}
    }
    return '';
  };

  // 通道 1：本地目录匹配
  const findLocalCandidates = async (songMeta) => {
    if (
      !state.localIndex.length &&
      (state.settings.localFolders?.length > 0 || globalThis.__echoMusicDownload)
    ) {
      await rebuildLocalIndex();
    }
    const matches = [];
    for (const item of state.localIndex) {
      let score = scoreCandidate(songMeta, { title: item.title, artist: item.artist, duration: 0 });
      if (!item.artist && normalizeText(item.title) === normalizeText(songMeta.title)) {
        score = Math.max(score, 0.86);
      }
      if (score < 0.68) continue;
      if (item.quality === 'flac') score = Math.min(1, Number((score + 0.04).toFixed(3)));
      matches.push({
        id: `local:${item.path || item.name}`,
        channel: 'local',
        channelLabel: `本地曲库 (${item.folderName})`,
        title: item.title || item.name,
        artist: item.artist || songMeta.artist,
        album: item.folderName || '',
        duration: 0,
        quality: item.quality,
        ext: item.ext,
        score,
        localItem: item,
      });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, 5);
  };

  // 通道 2：酷狗同曲异版搜索
  const findKugouAltCandidates = async (songMeta, preferredQuality = '320') => {
    const searchFn = ctx.kugou?.search?.search || ctx.kugou?.search?.searchSongs;
    const getUrlFn = ctx.kugou?.music?.getSongUrl;
    if (typeof searchFn !== 'function' || typeof getUrlFn !== 'function') return [];

    const keyword = [songMeta.title, songMeta.artist].filter(Boolean).join(' ').trim();
    if (!keyword) return [];

    try {
      const res = await searchFn(keyword, 'song', 1, 16);
      const data = res?.data ?? res ?? {};
      const rawList = data?.lists ?? data?.info ?? res?.lists ?? res?.info ?? [];
      if (!Array.isArray(rawList) || rawList.length === 0) return [];

      const scored = [];
      const currentHash = String(songMeta.hash || '').toLowerCase();
      for (const item of rawList) {
        const candTitle = String(item?.SongName ?? item?.songname ?? item?.FileName ?? '').trim();
        const candArtist = String(
          item?.SingerName ??
            item?.singername ??
            (Array.isArray(item?.Singers)
              ? item.Singers.map((s) => s?.name).filter(Boolean).join(' / ')
              : ''),
        ).trim();
        const candAlbum = String(item?.AlbumName ?? item?.album_name ?? '').trim();
        const candDur = Number(item?.Duration ?? item?.duration ?? 0);
        const hash320 = String(item?.HQFileHash ?? item?.HQ?.Hash ?? '').trim();
        const hashFlac = String(item?.SQFileHash ?? item?.SQ?.Hash ?? '').trim();
        const hash128 = String(item?.FileHash ?? item?.filehash ?? item?.hash ?? '').trim();
        const primaryHash =
          (preferredQuality === 'flac' && hashFlac) ||
          (preferredQuality !== '128' && hash320) ||
          hash128;
        if (!primaryHash || primaryHash.toLowerCase() === currentHash) continue;

        const score = scoreCandidate(songMeta, {
          title: candTitle,
          artist: candArtist,
          duration: candDur,
        });
        if (score < 0.65) continue;

        scored.push({
          id: `kugou-alt:${primaryHash}`,
          channel: 'kugou-alt',
          channelLabel: '酷狗同曲异版',
          title: candTitle,
          artist: candArtist,
          album: candAlbum,
          duration: candDur,
          hash: primaryHash,
          fallbackHashes: [hashFlac, hash320, hash128].filter(Boolean),
          quality: primaryHash === hashFlac ? 'flac' : primaryHash === hash320 ? '320' : '128',
          score,
        });
      }

      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, 6);
    } catch (err) {
      console.warn('[echo-music-unblock] 酷狗异版检索失败:', err?.message || err);
      return [];
    }
  };

  const resolveKugouCandidateUrl = async (cand, preferredQuality = '320') => {
    const getUrlFn = ctx.kugou?.music?.getSongUrl;
    if (typeof getUrlFn !== 'function') return null;
    const hashes = Array.from(new Set([cand.hash, ...(cand.fallbackHashes || [])].filter(Boolean)));
    const qualities =
      preferredQuality === 'flac'
        ? ['flac', '320', '128', '']
        : preferredQuality === '320'
          ? ['320', '128', '']
          : ['128', ''];

    for (const h of hashes) {
      for (const q of qualities) {
        try {
          const res = await getUrlFn(h, q);
          const urls = extractUrlsFromSongUrlResponse(res);
          if (urls.length > 0) {
            return {
              url: urls[0],
              urls,
              quality: q || cand.quality || '128',
              hash: h,
            };
          }
        } catch {}
      }
    }
    return null;
  };

  // 通道 3：外部多平台音源接口 (Custom API + GDStudio / Meting / 网易云兜底)
  const netFetchJson = async (url, options = {}) => {
    if (typeof ctx.net?.fetch === 'function') {
      const res = await ctx.net.fetch({
        url,
        method: options.method || 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'application/json, text/plain, */*',
          ...(options.headers || {}),
        },
        responseType: 'json',
        timeoutMs: options.timeoutMs || 8000,
      });
      if (res && res.status >= 200 && res.status < 400) {
        if (typeof res.data === 'string') {
          try {
            return JSON.parse(res.data);
          } catch {
            return res.data;
          }
        }
        return res.data;
      }
    }
    return null;
  };

  const buildCustomApiRequestUrl = (template, songMeta, preferredQuality = '320') => {
    const keyword = [songMeta.title, songMeta.artist].filter(Boolean).join(' ').trim();
    return String(template || '')
      .trim()
      .replace(/\{title\}/gi, encodeURIComponent(songMeta.title || ''))
      .replace(/\{artist\}/gi, encodeURIComponent(songMeta.artist || ''))
      .replace(/\{album\}/gi, encodeURIComponent(songMeta.album || ''))
      .replace(/\{keyword\}/gi, encodeURIComponent(keyword))
      .replace(/\{quality\}/gi, encodeURIComponent(preferredQuality || '320'))
      .replace(/\{hash\}/gi, encodeURIComponent(songMeta.hash || ''));
  };

  const testCustomApi = async (templateOverride) => {
    const template = String(
      templateOverride !== undefined ? templateOverride : state.settings.customApiUrl || '',
    ).trim();
    if (!template) {
      state.testApiOk = false;
      state.testApiResult = '请先填写自定义音源 API 模板 URL';
      return { ok: false, message: state.testApiResult };
    }
    if (!/^https?:\/\//i.test(template)) {
      state.testApiOk = false;
      state.testApiResult = 'URL 需以 http:// 或 https:// 开头';
      return { ok: false, message: state.testApiResult };
    }
    state.testingApi = true;
    state.testApiResult = '正在测试连通性…';
    state.testApiOk = null;
    const started = Date.now();
    try {
      const builtUrl = buildCustomApiRequestUrl(
        template,
        { title: '稻香', artist: '周杰伦', album: '魔杰座', hash: 'test' },
        '320',
      );
      const data = await netFetchJson(builtUrl, { timeoutMs: 7000 });
      const latency = Date.now() - started;
      const urls = extractUrlsFromSongUrlResponse(data);
      if (urls.length > 0) {
        state.testApiOk = true;
        state.testApiResult = `连通成功 · 返回 ${urls.length} 条音频直链 (${latency}ms)`;
        return { ok: true, message: state.testApiResult, urls, latencyMs: latency };
      }
      if (data !== null) {
        state.testApiOk = false;
        state.testApiResult = `接口已响应 (${latency}ms)，但未解析到可用音频 URL 字段`;
        return { ok: false, message: state.testApiResult, latencyMs: latency };
      }
      state.testApiOk = false;
      state.testApiResult = `连接失败或响应超时 (${latency}ms)`;
      return { ok: false, message: state.testApiResult, latencyMs: latency };
    } catch (err) {
      state.testApiOk = false;
      state.testApiResult = `请求异常：${err?.message || '网络不可达'}`;
      return { ok: false, message: state.testApiResult };
    } finally {
      state.testingApi = false;
    }
  };

  const findExternalApiCandidates = async (songMeta, preferredQuality = '320') => {
    const results = [];
    const customTemplate = String(state.settings.customApiUrl || '').trim();
    const keyword = [songMeta.title, songMeta.artist].filter(Boolean).join(' ').trim();
    if (!keyword) return results;

    // 3A. 用户自定义音源接口模板
    if (customTemplate) {
      try {
        const builtUrl = buildCustomApiRequestUrl(customTemplate, songMeta, preferredQuality);
        const data = await netFetchJson(builtUrl, { timeoutMs: 7000 });
        const urls = extractUrlsFromSongUrlResponse(data);
        if (urls.length > 0) {
          results.push({
            id: `external:custom:${urls[0]}`,
            channel: 'external',
            channelLabel: '自定义音源 API',
            provider: 'custom',
            sourcePlatform: 'custom',
            title: songMeta.title,
            artist: songMeta.artist,
            album: songMeta.album || '',
            duration: songMeta.duration || 0,
            quality: preferredQuality === 'flac' ? 'flac' : '320',
            url: urls[0],
            urls,
            score: 0.95,
          });
        }
      } catch (err) {
        console.warn('[echo-music-unblock] 自定义音源请求失败:', err?.message || err);
      }
    }

    // 3B. GDStudio 多平台音源接口 (按用户配置的平台优先级顺序)
    const platforms =
      Array.isArray(state.settings.preferredExternalSources) &&
      state.settings.preferredExternalSources.length
        ? state.settings.preferredExternalSources
        : ['netease', 'kuwo'];
    for (let idx = 0; idx < Math.min(platforms.length, 3); idx += 1) {
      const source = platforms[idx];
      try {
        const searchUrl = `https://music-api.gdstudio.xyz/api.php?types=search&source=${encodeURIComponent(source)}&name=${encodeURIComponent(keyword)}&count=6&pages=1`;
        const list = await netFetchJson(searchUrl, { timeoutMs: 6500 });
        if (Array.isArray(list)) {
          for (const item of list) {
            const candTitle = String(item?.name ?? item?.title ?? '').trim();
            const candArtist = Array.isArray(item?.artist)
              ? item.artist.join(' / ')
              : String(item?.artist ?? '').trim();
            const trackId = String(item?.id ?? item?.url_id ?? '').trim();
            if (!trackId || !candTitle) continue;
            const rawDur = Number(item?.duration ?? 0);
            const candDur = rawDur > 10000 ? Math.round(rawDur / 1000) : Math.round(rawDur);
            const score = scoreCandidate(songMeta, {
              title: candTitle,
              artist: candArtist,
              duration: candDur,
            });
            if (score < 0.65) continue;
            const priorityBoost = Math.max(0, (2 - idx) * 0.015);
            results.push({
              id: `external:gdstudio:${source}:${trackId}`,
              channel: 'external',
              channelLabel: `多平台音源 (${source.toUpperCase()})`,
              sourcePlatform: source,
              provider: 'gdstudio',
              externalId: trackId,
              lyricId: String(item?.lyric_id ?? trackId),
              title: candTitle,
              artist: candArtist,
              album: String(item?.album ?? ''),
              duration: candDur,
              quality: preferredQuality === 'flac' ? 'flac' : '320',
              score: Math.min(1, Number((score + priorityBoost).toFixed(3))),
            });
          }
        }
      } catch {}
    }

    // 3C. 网易云官方搜索 + 外链直通兜底
    if (platforms.includes('netease') || results.length === 0) {
      try {
        const neSearchUrl = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=6`;
        const neRes = await netFetchJson(neSearchUrl, {
          headers: { Referer: 'https://music.163.com/' },
          timeoutMs: 6000,
        });
        const songs = neRes?.result?.songs;
        if (Array.isArray(songs)) {
          for (const item of songs) {
            const candTitle = String(item?.name ?? '').trim();
            const candArtist = Array.isArray(item?.artists)
              ? item.artists.map((a) => a?.name).filter(Boolean).join(' / ')
              : '';
            const candDur = item?.duration ? Math.round(Number(item.duration) / 1000) : 0;
            const songId = String(item?.id ?? '').trim();
            if (!songId || !candTitle) continue;
            const score = scoreCandidate(songMeta, {
              title: candTitle,
              artist: candArtist,
              duration: candDur,
            });
            if (score < 0.66) continue;
            results.push({
              id: `external:netease:${songId}`,
              channel: 'external',
              channelLabel: '外部音源 (NetEase)',
              sourcePlatform: 'netease',
              provider: 'netease-direct',
              externalId: songId,
              lyricId: songId,
              title: candTitle,
              artist: candArtist,
              album: String(item?.album?.name ?? ''),
              duration: candDur,
              quality: '320',
              score,
            });
          }
        }
      } catch {}
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 8);
  };

  const resolveExternalCandidateUrl = async (cand, preferredQuality = '320', { bypassCachedUrl = false } = {}) => {
    if (!bypassCachedUrl && cand.url) {
      return { url: cand.url, urls: cand.urls || [cand.url], quality: cand.quality || '320' };
    }
    if (cand.sourcePlatform === 'custom' && state.settings.customApiUrl) {
      try {
        const builtUrl = buildCustomApiRequestUrl(
          state.settings.customApiUrl,
          {
            title: cand.targetTitle || cand.title || '',
            artist: cand.targetArtist || cand.artist || '',
            album: cand.targetAlbum || cand.album || '',
            hash: cand.hash || '',
          },
          preferredQuality,
        );
        const data = await netFetchJson(builtUrl, { timeoutMs: 7000 });
        const urls = extractUrlsFromSongUrlResponse(data);
        if (urls.length > 0) {
          return { url: urls[0], urls, quality: preferredQuality === 'flac' ? 'flac' : '320' };
        }
      } catch {}
    }
    if (cand.provider === 'gdstudio' && cand.externalId) {
      const br = preferredQuality === 'flac' ? '999' : '320';
      const urlApi = `https://music-api.gdstudio.xyz/api.php?types=url&source=${encodeURIComponent(cand.sourcePlatform || 'netease')}&id=${encodeURIComponent(cand.externalId)}&br=${br}`;
      const data = await netFetchJson(urlApi, { timeoutMs: 7000 });
      const resolvedUrl = String(data?.url || '').trim();
      if (/^https?:\/\//i.test(resolvedUrl)) {
        return {
          url: resolvedUrl,
          urls: [resolvedUrl],
          quality: Number(data?.br) >= 700 ? 'flac' : '320',
        };
      }
    }
    if (cand.sourcePlatform === 'netease' && cand.externalId) {
      try {
        const metingUrl = `https://api.i-meto.com/meting/api?server=netease&type=url&id=${encodeURIComponent(cand.externalId)}`;
        if (typeof ctx.net?.fetch === 'function') {
          const res = await ctx.net.fetch({
            url: metingUrl,
            method: 'GET',
            responseType: 'text',
            maxRedirects: 5,
            timeoutMs: 6500,
          });
          const finalUrl = String(res?.url || '').trim();
          if (
            /^https?:\/\//i.test(finalUrl) &&
            !finalUrl.includes('api.i-meto.com') &&
            !finalUrl.endsWith('/404')
          ) {
            return { url: finalUrl, urls: [finalUrl], quality: '320' };
          }
        }
      } catch {}
    }
    return null;
  };

  // 按持久化描述符解析/刷新锁定音源（过期直链自动按需刷新）
  const resolvePinnedDescriptor = async (pinned, songMeta, preferredQuality = '320', { forceRefresh = false } = {}) => {
    if (!pinned) return null;
    const now = Date.now();
    const cachedAt = Number(pinned.urlCachedAt ?? pinned.updatedAt ?? 0) || 0;
    const isExpired = !pinned.url || now - cachedAt > PINNED_URL_TTL_MS;

    // 1. 本地曲库锁定源：重新定位本地索引以获取有效的媒体租约 URL
    if (pinned.channel === 'local') {
      if (!state.localIndex.length && (state.settings.localFolders?.length > 0 || globalThis.__echoMusicDownload)) {
        await rebuildLocalIndex();
      }
      const targetPath = pinned.localItem?.path || '';
      const targetName = pinned.localItem?.name || '';
      const targetBaseKey = pinned.localItem?.baseKey || '';
      const matched =
        state.localIndex.find(
          (it) =>
            (targetPath && it.path === targetPath) ||
            (targetName && it.name === targetName) ||
            (targetBaseKey && it.baseKey === targetBaseKey),
        ) || null;
      if (matched) {
        const freshUrl = await resolveLocalFilePlayUrl(matched);
        if (freshUrl) {
          pinned.url = freshUrl;
          pinned.urlCachedAt = now;
          pinned.quality = matched.quality || pinned.quality || '320';
          pinned.ext = matched.ext || pinned.ext || 'mp3';
          void savePinned();
          return {
            url: freshUrl,
            urls: [freshUrl],
            quality: pinned.quality,
            ext: pinned.ext,
            baseKey: matched.baseKey || targetBaseKey,
            refreshed: true,
          };
        }
      }
      if (pinned.url) {
        return {
          url: pinned.url,
          urls: [pinned.url],
          quality: pinned.quality || '320',
          ext: pinned.ext || 'mp3',
          baseKey: targetBaseKey,
          refreshed: false,
        };
      }
      return null;
    }

    // 2. 酷狗同曲异版锁定源：按 hash 刷新过期直链
    if (pinned.channel === 'kugou-alt') {
      if ((forceRefresh || isExpired) && (pinned.hash || pinned.fallbackHashes?.length)) {
        const refreshed = await resolveKugouCandidateUrl(
          {
            hash: pinned.hash,
            fallbackHashes: pinned.fallbackHashes || [],
            quality: pinned.quality,
          },
          preferredQuality || pinned.quality || '320',
        );
        if (refreshed?.url) {
          pinned.url = refreshed.url;
          pinned.hash = refreshed.hash || pinned.hash;
          pinned.quality = refreshed.quality || pinned.quality;
          pinned.ext = pinned.quality === 'flac' ? 'flac' : 'mp3';
          pinned.urlCachedAt = now;
          void savePinned();
          return {
            url: refreshed.url,
            urls: refreshed.urls || [refreshed.url],
            quality: pinned.quality,
            ext: pinned.ext,
            refreshed: true,
          };
        }
      }
      if (pinned.url) {
        return {
          url: pinned.url,
          urls: [pinned.url],
          quality: pinned.quality || '320',
          ext: pinned.ext || (pinned.quality === 'flac' ? 'flac' : 'mp3'),
          refreshed: false,
        };
      }
      return null;
    }

    // 3. 外部平台锁定源：按 provider / sourcePlatform / externalId 按需刷新直链
    if (forceRefresh || isExpired) {
      const canRefresh = Boolean(
        pinned.externalId || (pinned.sourcePlatform === 'custom' && state.settings.customApiUrl),
      );
      if (canRefresh) {
        const refreshed = await resolveExternalCandidateUrl(
          {
            provider: pinned.provider,
            sourcePlatform: pinned.sourcePlatform,
            externalId: pinned.externalId,
            quality: pinned.quality,
            title: pinned.title || songMeta?.title || '',
            artist: pinned.artist || songMeta?.artist || '',
            targetTitle: pinned.targetTitle || songMeta?.title || '',
            targetArtist: pinned.targetArtist || songMeta?.artist || '',
            targetAlbum: pinned.targetAlbum || songMeta?.album || '',
            hash: pinned.hash || songMeta?.hash || '',
          },
          preferredQuality || pinned.quality || '320',
          { bypassCachedUrl: true },
        );
        if (refreshed?.url) {
          pinned.url = refreshed.url;
          pinned.quality = refreshed.quality || pinned.quality || '320';
          pinned.ext = pinned.quality === 'flac' ? 'flac' : 'mp3';
          pinned.urlCachedAt = now;
          void savePinned();
          return {
            url: refreshed.url,
            urls: refreshed.urls || [refreshed.url],
            quality: pinned.quality,
            ext: pinned.ext,
            refreshed: true,
          };
        }
      }
    }

    if (pinned.url) {
      return {
        url: pinned.url,
        urls: [pinned.url],
        quality: pinned.quality || '320',
        ext: pinned.ext || (pinned.quality === 'flac' ? 'flac' : 'mp3'),
        refreshed: false,
      };
    }
    return null;
  };

  // 全通道扫描候选列表（用于手动换源弹窗 & 诊断）
  const scanAllCandidates = async (song, preferredQuality = '320') => {
    const songMeta = extractSongMeta(song);
    if (!songMeta.title) return [];
    const [localList, kugouList, extList] = await Promise.all([
      state.settings.enableLocal ? findLocalCandidates(songMeta) : Promise.resolve([]),
      state.settings.enableKugouAlt ? findKugouAltCandidates(songMeta, preferredQuality) : Promise.resolve([]),
      state.settings.enableExternalApi ? findExternalApiCandidates(songMeta, preferredQuality) : Promise.resolve([]),
    ]);
    return [...localList, ...kugouList, ...extList];
  };

  // 带目标曲目隔离与防竞态保护的候选扫描
  const scanCandidatesFor = async (song, preferredQuality = 'flac') => {
    const key = getTrackKey(song);
    if (!song || !key) {
      state.candidates = [];
      state.candidatesTrackKey = '';
      state.scanningCandidates = false;
      return [];
    }
    const reqId = ++scanSeq;
    if (state.candidatesTrackKey !== key) {
      state.candidates = [];
      state.candidatesTrackKey = key;
    }
    state.scanningCandidates = true;
    try {
      const list = await scanAllCandidates(song, preferredQuality);
      if (reqId === scanSeq) {
        state.candidates = list;
        state.candidatesTrackKey = key;
      }
      return list;
    } finally {
      if (reqId === scanSeq) {
        state.scanningCandidates = false;
      }
    }
  };

  const openSwitcherForTrack = async (targetTrack, { forceScan = true } = {}) => {
    const track = targetTrack || ctx.player?.currentTrack?.value || null;
    if (!track) {
      ctx.toast?.info?.('当前没有可换源的歌曲');
      return;
    }
    const key = getTrackKey(track);
    state.modalTargetTrack = track;
    if (key !== state.candidatesTrackKey) {
      state.candidates = [];
      state.candidatesTrackKey = key;
    }
    state.dialogOpen = true;
    if (forceScan || state.candidates.length === 0) {
      await scanCandidatesFor(track, 'flac');
    }
  };

  const materializeCandidate = async (cand, preferredQuality = '320') => {
    if (!cand) return null;
    if (cand.channel === 'local' && cand.localItem) {
      const url = await resolveLocalFilePlayUrl(cand.localItem);
      if (!url) return null;
      return {
        ...cand,
        url,
        urls: [url],
        quality: cand.localItem.quality || '320',
        ext: cand.localItem.ext || 'mp3',
      };
    }
    if (cand.channel === 'kugou-alt') {
      const resolved = await resolveKugouCandidateUrl(cand, preferredQuality);
      if (!resolved?.url) return null;
      return {
        ...cand,
        url: resolved.url,
        urls: resolved.urls,
        hash: resolved.hash,
        quality: resolved.quality,
        ext: resolved.quality === 'flac' ? 'flac' : 'mp3',
      };
    }
    if (cand.channel === 'external') {
      const resolved = await resolveExternalCandidateUrl(cand, preferredQuality);
      if (!resolved?.url) return null;
      return {
        ...cand,
        url: resolved.url,
        urls: resolved.urls,
        quality: resolved.quality || cand.quality || '320',
        ext: (resolved.quality || cand.quality) === 'flac' ? 'flac' : 'mp3',
      };
    }
    return null;
  };

  // 自动瀑布流解析音源
  const resolveAudioSourceWaterfall = async (song, preferredQuality = '320', stage = 'after-catalog') => {
    if (!state.settings.enabled) return null;
    const trackKey = getTrackKey(song);
    const songMeta = extractSongMeta(song);
    if (!songMeta.title) return null;
    const isDownloadStage = stage === 'download-fallback';

    // 0. 检查当前会话临时试听覆盖（仅本次试听 / 指定下载候选）
    const sessionOverride = trackKey ? state.sessionOverrides[trackKey] : null;
    if (sessionOverride && sessionOverride.url) {
      if (!isDownloadStage) {
        state.activeTrackStatus = {
          trackKey,
          channel: sessionOverride.channel || 'external',
          label: `试听 · ${sessionOverride.channelLabel || '临时音源'}`,
          quality: sessionOverride.quality || preferredQuality,
          matchedTitle: sessionOverride.title || songMeta.title,
          matchedArtist: sessionOverride.artist || songMeta.artist,
          matchedHash: sessionOverride.hash || '',
          externalId: sessionOverride.externalId || '',
          lyricId: sessionOverride.lyricId || '',
          sourcePlatform: sessionOverride.sourcePlatform || '',
          baseKey: sessionOverride.baseKey || '',
          url: sessionOverride.url,
          isTemporary: true,
        };
      }
      return {
        url: sessionOverride.url,
        urls: sessionOverride.urls || [sessionOverride.url],
        quality: sessionOverride.quality || '320',
        ext: sessionOverride.ext || (sessionOverride.quality === 'flac' ? 'flac' : 'mp3'),
        sourceKind: 'plugin',
        channel: sessionOverride.channel || 'external',
        channelLabel: sessionOverride.channelLabel || '临时音源',
      };
    }

    // 1. 检查持久化锁定音源（支持按描述符自动刷新过期直链）
    const pinned = trackKey ? state.pinned[trackKey] : null;
    if (pinned) {
      const resolvedPinned = await resolvePinnedDescriptor(pinned, songMeta, preferredQuality);
      if (resolvedPinned?.url) {
        if (!isDownloadStage) {
          state.activeTrackStatus = {
            trackKey,
            channel: 'pinned',
            label: pinned.channelLabel || '手动锁定源',
            quality: resolvedPinned.quality || preferredQuality,
            matchedTitle: pinned.title || songMeta.title,
            matchedArtist: pinned.artist || songMeta.artist,
            matchedHash: pinned.hash || '',
            externalId: pinned.externalId || '',
            lyricId: pinned.lyricId || '',
            sourcePlatform: pinned.sourcePlatform || '',
            baseKey: resolvedPinned.baseKey || pinned.localItem?.baseKey || '',
            url: resolvedPinned.url,
          };
        }
        return {
          url: resolvedPinned.url,
          urls: resolvedPinned.urls || [resolvedPinned.url],
          quality: resolvedPinned.quality || '320',
          ext: resolvedPinned.ext || (resolvedPinned.quality === 'flac' ? 'flac' : 'mp3'),
          sourceKind: 'plugin',
          channel: 'pinned',
          channelLabel: pinned.channelLabel || '手动锁定源',
        };
      }
    }

    // before-catalog 阶段仅当开启 localPriority 时匹配本地曲库
    if (stage === 'before-catalog') {
      if (!state.settings.localPriority || !state.settings.enableLocal) return null;
      const localCands = await findLocalCandidates(songMeta);
      for (const cand of localCands) {
        if (cand.score < 0.8) continue;
        const mat = await materializeCandidate(cand, preferredQuality);
        if (mat?.url) {
          state.activeTrackStatus = {
            trackKey,
            channel: 'local',
            label: mat.channelLabel,
            quality: mat.quality,
            matchedTitle: mat.title,
            matchedArtist: mat.artist,
            url: mat.url,
            baseKey: cand.localItem?.baseKey || '',
          };
          void recordHistory({
            trackKey,
            title: songMeta.title,
            artist: songMeta.artist,
            album: songMeta.album,
            duration: songMeta.duration,
            hash: songMeta.hash,
            id: songMeta.id,
            channel: 'local',
            channelLabel: mat.channelLabel,
            quality: mat.quality,
          });
          return {
            url: mat.url,
            urls: mat.urls,
            quality: mat.quality,
            ext: mat.ext || 'mp3',
            sourceKind: 'plugin',
          };
        }
      }
      return null;
    }

    // after-catalog / final-fallback / download-fallback 完整解灰瀑布流
    const candidateGroups = [];
    if (state.settings.enableLocal) {
      candidateGroups.push(await findLocalCandidates(songMeta));
    }
    if (state.settings.enableKugouAlt) {
      candidateGroups.push(await findKugouAltCandidates(songMeta, preferredQuality));
    }
    if (state.settings.enableExternalApi) {
      candidateGroups.push(await findExternalApiCandidates(songMeta, preferredQuality));
    }

    for (const group of candidateGroups) {
      for (const cand of group) {
        const mat = await materializeCandidate(cand, preferredQuality);
        if (mat?.url) {
          if (!isDownloadStage) {
            state.activeTrackStatus = {
              trackKey,
              channel: mat.channel,
              label: mat.channelLabel,
              quality: mat.quality,
              matchedTitle: mat.title,
              matchedArtist: mat.artist,
              matchedHash: mat.hash || '',
              externalId: mat.externalId || '',
              lyricId: mat.lyricId || '',
              sourcePlatform: mat.sourcePlatform || '',
              baseKey: cand.localItem?.baseKey || '',
              url: mat.url,
            };
          }
          void recordHistory({
            trackKey,
            title: songMeta.title,
            artist: songMeta.artist,
            album: songMeta.album,
            duration: songMeta.duration,
            hash: songMeta.hash,
            id: songMeta.id,
            channel: mat.channel,
            channelLabel: mat.channelLabel,
            quality: mat.quality,
          });
          return {
            url: mat.url,
            urls: mat.urls,
            quality: mat.quality,
            ext: mat.ext || 'mp3',
            sourceKind: 'plugin',
            channel: mat.channel,
            channelLabel: mat.channelLabel,
          };
        }
      }
    }

    return null;
  };

  // 多源双语歌词兜底解析
  const resolveLyricWaterfall = async (song) => {
    if (!state.settings.enabled || !state.settings.enableLyricFallback) return null;
    const songMeta = extractSongMeta(song);
    if (!songMeta.title) return null;
    const trackKey = getTrackKey(song);
    const activeStatus =
      state.activeTrackStatus && state.activeTrackStatus.trackKey === trackKey
        ? state.activeTrackStatus
        : null;

    // 1. 本地同名 .lrc 歌词文件
    if (state.settings.enableLocal) {
      const baseKeys = [
        activeStatus?.baseKey,
        `${songMeta.artist} - ${songMeta.title}`.toLowerCase(),
        `${songMeta.title} - ${songMeta.artist}`.toLowerCase(),
        songMeta.title.toLowerCase(),
      ].filter(Boolean);
      for (const key of baseKeys) {
        const lrcFile = state.localLyricIndex.get(key);
        if (lrcFile) {
          try {
            const target = lrcFile.file || lrcFile.path;
            const res =
              lrcFile.ownerBridge && typeof lrcFile.ownerBridge.readLocalText === 'function'
                ? await lrcFile.ownerBridge.readLocalText(target, {
                    encoding: 'utf8',
                    maxBytes: 1024 * 1024,
                  })
                : await ctx.fs.readTextFile(target, { encoding: 'utf8', maxBytes: 1024 * 1024 });
            const content = String(res?.content || '').replace(/^\uFEFF/, '').trim();
            if (content) return { decodeContent: content, source: '本地 LRC' };
          } catch {}
        }
      }
    }

    // 2. 酷狗异版匹配到的歌曲 Hash 歌词
    const candidateHash = activeStatus?.matchedHash || songMeta.hash;
    if (
      candidateHash &&
      typeof ctx.kugou?.music?.searchLyric === 'function' &&
      typeof ctx.kugou?.music?.getLyric === 'function'
    ) {
      try {
        const searchRes = await ctx.kugou.music.searchLyric(candidateHash, {
          duration: songMeta.duration ? songMeta.duration * 1000 : undefined,
        });
        const data = searchRes?.data ?? searchRes ?? {};
        const cand = data?.candidates?.[0] ?? data?.info?.[0];
        const id = cand?.id ?? cand?.lyric_id;
        const accesskey = cand?.accesskey ?? cand?.accessKey;
        if (id && accesskey) {
          const lrcRes = await ctx.kugou.music.getLyric(String(id), String(accesskey));
          const decoded = String(
            lrcRes?.decodeContent ?? lrcRes?.data?.decodeContent ?? lrcRes?.lyric ?? '',
          )
            .replace(/^\uFEFF/, '')
            .trim();
          if (decoded) return { decodeContent: decoded, source: '酷狗歌词' };
        }
      } catch {}
    }

    // 3. 网易云双语歌词兜底（原文 + 翻译自动合并）
    try {
      let neSongId =
        activeStatus?.sourcePlatform === 'netease' && activeStatus?.externalId
          ? activeStatus.externalId
          : '';
      if (!neSongId) {
        const keyword = [songMeta.title, songMeta.artist].filter(Boolean).join(' ').trim();
        const neSearchUrl = `https://music.163.com/api/search/get/web?s=${encodeURIComponent(keyword)}&type=1&offset=0&total=true&limit=4`;
        const neRes = await netFetchJson(neSearchUrl, {
          headers: { Referer: 'https://music.163.com/' },
          timeoutMs: 5000,
        });
        const best = (neRes?.result?.songs || []).find((item) => {
          const candTitle = String(item?.name || '').trim();
          const candArtist = Array.isArray(item?.artists)
            ? item.artists.map((a) => a?.name).filter(Boolean).join(' / ')
            : '';
          return scoreCandidate(songMeta, { title: candTitle, artist: candArtist, duration: 0 }) >= 0.68;
        });
        if (best?.id) neSongId = String(best.id);
      }

      if (neSongId) {
        const lyricUrl = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(neSongId)}&lv=1&kv=1&tv=-1`;
        const lyricRes = await netFetchJson(lyricUrl, {
          headers: { Referer: 'https://music.163.com/' },
          timeoutMs: 5000,
        });
        const origLrc = String(lyricRes?.lrc?.lyric || '').trim();
        const transLrc = String(lyricRes?.tlyric?.lyric || '').trim();
        if (origLrc) {
          const merged = state.settings.bilingualLyric
            ? mergeBilingualLrc(origLrc, transLrc)
            : origLrc;
          return { decodeContent: merged, source: '网易云双语歌词' };
        }
      }
    } catch {}

    // 4. LRCLIB 国际歌词库兜底
    try {
      const lrclibUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(songMeta.title)}&artist_name=${encodeURIComponent(songMeta.artist || '')}`;
      const lrcData = await netFetchJson(lrclibUrl, { timeoutMs: 5000 });
      const synced = String(lrcData?.syncedLyrics || lrcData?.plainLyrics || '').trim();
      if (synced) {
        return { decodeContent: synced, source: 'LRCLIB' };
      }
    } catch {}

    return null;
  };

  const isTargetCurrentPlaying = (song, trackKey) => {
    const current = ctx.player?.currentTrack?.value;
    if (!current) return false;
    const currentKey = getTrackKey(current);
    if (currentKey && trackKey && currentKey === trackKey) return true;
    const currentId = String(ctx.player?.currentTrackId?.value ?? '').trim();
    const meta = extractSongMeta(song);
    return Boolean(currentId && meta.id && currentId === meta.id);
  };

  const triggerPlaybackForTarget = async (song, trackKey, { playIfNotCurrent = false } = {}) => {
    try {
      const currentId = ctx.player?.currentTrackId?.value;
      if (isTargetCurrentPlaying(song, trackKey) && currentId && typeof ctx.player?.playTrack === 'function') {
        await ctx.player.playTrack(currentId, { autoPlay: true });
        return;
      }
      if (playIfNotCurrent) {
        if (typeof ctx.player?.playSong === 'function') {
          await ctx.player.playSong(song);
          return;
        }
        const meta = extractSongMeta(song);
        if (meta.id && typeof ctx.player?.playTrack === 'function') {
          await ctx.player.playTrack(meta.id, { autoPlay: true });
        }
      }
    } catch {}
  };

  // 仅本次试听（不写入持久化锁定）
  const applyTemporaryCandidate = async (song, cand) => {
    const trackKey = getTrackKey(song);
    if (!trackKey) return false;
    const songMeta = extractSongMeta(song);
    const mat = await materializeCandidate(cand, 'flac');
    if (!mat?.url) {
      ctx.toast?.warning?.('该候选音源暂不可用，请尝试其他源');
      return false;
    }
    state.sessionOverrides[trackKey] = {
      trackKey,
      channel: mat.channel,
      provider: mat.provider || '',
      sourcePlatform: mat.sourcePlatform || '',
      externalId: mat.externalId || '',
      lyricId: mat.lyricId || '',
      hash: mat.hash || '',
      baseKey: mat.localItem?.baseKey || '',
      channelLabel: mat.channelLabel,
      title: mat.title,
      artist: mat.artist,
      quality: mat.quality,
      ext: mat.ext || (mat.quality === 'flac' ? 'flac' : 'mp3'),
      url: mat.url,
      urls: mat.urls || [mat.url],
      updatedAt: Date.now(),
    };
    if (isTargetCurrentPlaying(song, trackKey)) {
      state.activeTrackStatus = {
        trackKey,
        channel: mat.channel,
        label: `试听 · ${mat.channelLabel}`,
        quality: mat.quality,
        matchedTitle: mat.title,
        matchedArtist: mat.artist,
        matchedHash: mat.hash || '',
        externalId: mat.externalId || '',
        lyricId: mat.lyricId || '',
        sourcePlatform: mat.sourcePlatform || '',
        baseKey: mat.localItem?.baseKey || '',
        url: mat.url,
        isTemporary: true,
      };
    }
    ctx.toast?.success?.(`开始试听「${songMeta.title || mat.title}」· ${mat.channelLabel}`);
    await triggerPlaybackForTarget(song, trackKey, { playIfNotCurrent: true });
    return true;
  };

  // 手动应用并持久化锁定候选音源（完整保存音源描述符以便过期按需刷新）
  const applyAndPinCandidate = async (song, cand) => {
    const trackKey = getTrackKey(song);
    if (!trackKey) return false;
    const songMeta = extractSongMeta(song);
    const mat = await materializeCandidate(cand, 'flac');
    if (!mat?.url) {
      ctx.toast?.warning?.('该候选音源暂不可用，请尝试其他源');
      return false;
    }
    const now = Date.now();
    delete state.sessionOverrides[trackKey];
    state.pinned[trackKey] = normalizePinnedEntry(trackKey, {
      trackKey,
      targetTitle: songMeta.title || mat.title,
      targetArtist: songMeta.artist || mat.artist,
      targetAlbum: songMeta.album || '',
      targetDuration: songMeta.duration || 0,
      channel: mat.channel,
      provider: mat.provider || '',
      sourcePlatform: mat.sourcePlatform || '',
      externalId: mat.externalId || '',
      lyricId: mat.lyricId || '',
      hash: mat.hash || '',
      fallbackHashes: Array.isArray(mat.fallbackHashes) ? mat.fallbackHashes.slice(0, 4) : [],
      localItem: mat.localItem
        ? {
            name: mat.localItem.name || '',
            path: mat.localItem.path || '',
            baseKey: mat.localItem.baseKey || '',
            folderName: mat.localItem.folderName || '',
            ext: mat.localItem.ext || '',
            quality: mat.localItem.quality || '',
          }
        : null,
      quality: mat.quality,
      ext: mat.ext || (mat.quality === 'flac' ? 'flac' : 'mp3'),
      channelLabel: mat.channelLabel,
      title: mat.title,
      artist: mat.artist,
      album: mat.album || '',
      duration: mat.duration || 0,
      url: mat.url,
      urlCachedAt: now,
      updatedAt: now,
    });
    await savePinned();

    const isCurrent = isTargetCurrentPlaying(song, trackKey);
    if (isCurrent) {
      state.activeTrackStatus = {
        trackKey,
        channel: 'pinned',
        label: `锁定 · ${mat.channelLabel}`,
        quality: mat.quality,
        matchedTitle: mat.title,
        matchedArtist: mat.artist,
        matchedHash: mat.hash || '',
        externalId: mat.externalId || '',
        lyricId: mat.lyricId || '',
        sourcePlatform: mat.sourcePlatform || '',
        baseKey: mat.localItem?.baseKey || '',
        url: mat.url,
      };
      ctx.toast?.success?.(`已切换并锁定音源：${mat.channelLabel}`);
      await triggerPlaybackForTarget(song, trackKey, { playIfNotCurrent: false });
    } else {
      ctx.toast?.success?.(
        `已为「${songMeta.title || mat.title}」锁定音源：${mat.channelLabel}`,
      );
    }
    return true;
  };

  // 发送候选音源至歌曲下载插件 (globalThis.__echoMusicDownload)
  const downloadCandidate = async (song, cand) => {
    const dlBridge = globalThis.__echoMusicDownload;
    if (!dlBridge) {
      ctx.toast?.info?.('未检测到「歌曲下载」插件');
      return false;
    }
    const trackKey = getTrackKey(song);
    const songMeta = extractSongMeta(song);
    const mat = await materializeCandidate(cand, 'flac');
    if (!mat?.url) {
      ctx.toast?.warning?.('该候选音源暂不可用，无法发起下载');
      return false;
    }
    if (trackKey) {
      state.sessionOverrides[trackKey] = {
        trackKey,
        channel: mat.channel,
        provider: mat.provider || '',
        sourcePlatform: mat.sourcePlatform || '',
        externalId: mat.externalId || '',
        lyricId: mat.lyricId || '',
        hash: mat.hash || '',
        baseKey: mat.localItem?.baseKey || '',
        channelLabel: mat.channelLabel,
        title: mat.title,
        artist: mat.artist,
        quality: mat.quality,
        ext: mat.ext || (mat.quality === 'flac' ? 'flac' : 'mp3'),
        url: mat.url,
        urls: mat.urls || [mat.url],
        updatedAt: Date.now(),
      };
    }
    const payload = {
      ...(song && typeof song === 'object' ? song : {}),
      id: songMeta.id || cand.id,
      hash: songMeta.hash || cand.hash || `unblock-${Date.now()}`,
      title: songMeta.title || cand.title,
      name: songMeta.title || cand.title,
      artist: songMeta.artist || cand.artist,
      album: songMeta.album || cand.album || '',
      duration: songMeta.duration || cand.duration || 0,
      coverUrl: songMeta.coverUrl || '',
      url: mat.url,
      quality: mat.quality,
      ext: mat.ext,
      unblockSource: mat,
    };
    try {
      if (typeof dlBridge.enqueueSongs === 'function') {
        await dlBridge.enqueueSongs([payload]);
        ctx.toast?.success?.(`已将「${payload.title}」(${mat.channelLabel}) 加入下载队列`);
        return true;
      }
      if (typeof dlBridge.downloadSong === 'function') {
        await dlBridge.downloadSong(payload);
        ctx.toast?.success?.(`已将「${payload.title}」(${mat.channelLabel}) 加入下载队列`);
        return true;
      }
      if (typeof dlBridge.enqueue === 'function') {
        await dlBridge.enqueue(payload);
        ctx.toast?.success?.(`已将「${payload.title}」(${mat.channelLabel}) 加入下载队列`);
        return true;
      }
      ctx.toast?.info?.(`已预选此音源，请在歌曲右键菜单点击「下载歌曲」即可使用该源下载`);
      return true;
    } catch (err) {
      ctx.toast?.warning?.(`发送到下载队列失败：${err?.message || err}`);
      return false;
    }
  };

  const unpinTrack = async (songOrKey) => {
    const trackKey = getTrackKey(songOrKey);
    if (!trackKey || (!state.pinned[trackKey] && !state.sessionOverrides[trackKey])) return false;
    delete state.pinned[trackKey];
    delete state.sessionOverrides[trackKey];
    await savePinned();
    if (state.activeTrackStatus?.trackKey === trackKey) {
      state.activeTrackStatus = null;
    }
    ctx.toast?.info?.('已解除该歌曲的锁定音源');
    return true;
  };

  const unpinAllTracks = async () => {
    const count = Object.keys(state.pinned).length;
    if (count === 0) return 0;
    const keys = Object.keys(state.pinned);
    for (const k of keys) {
      delete state.pinned[k];
      delete state.sessionOverrides[k];
    }
    await savePinned();
    if (state.activeTrackStatus?.channel === 'pinned') {
      state.activeTrackStatus = null;
    }
    ctx.toast?.info?.(`已解除全部 ${count} 首歌曲的音源锁定`);
    return count;
  };

  const addLocalFolder = async () => {
    const fsGrants = getFsGrantApi(ctx);
    if (fsGrants && typeof fsGrants.requestDirectory === 'function') {
      try {
        const res = await fsGrants.requestDirectory({
          access: 'read',
          purpose: '扫描本地无损/已下载音乐用于解灰直通播放',
          persist: true,
        });
        if (res && res.ok && !res.canceled && res.directory) {
          const dir = res.directory;
          const displayPath = dir.displayPath || dir.name || dir.id;
          if (!state.settings.localFolders.some((f) => f.id === dir.id || f.path === displayPath)) {
            state.settings.localFolders.push({
              id: dir.id,
              name: dir.name || displayPath.split(/[\\/]/).pop() || '本地目录',
              path: displayPath,
            });
            await saveSettings();
            await rebuildLocalIndex();
            ctx.toast?.success?.(`已添加本地曲库目录：${displayPath}`);
          }
          return;
        }
      } catch {}
    }
    if (ctx.dialog?.selectDirectory) {
      const res = await ctx.dialog.selectDirectory({ title: '选择本地音乐曲库目录' });
      if (res && !res.canceled && res.paths?.[0]) {
        const p = res.paths[0];
        if (!state.settings.localFolders.some((f) => f.path === p)) {
          state.settings.localFolders.push({
            name: p.split(/[\\/]/).filter(Boolean).pop() || p,
            path: p,
          });
          await saveSettings();
          await rebuildLocalIndex();
          ctx.toast?.success?.(`已添加本地曲库目录：${p}`);
        }
      }
    }
  };

  const removeLocalFolder = async (folderPath) => {
    state.settings.localFolders = state.settings.localFolders.filter(
      (f) => f.path !== folderPath && f.id !== folderPath,
    );
    await saveSettings();
    await rebuildLocalIndex();
    ctx.toast?.info?.('已移除本地曲库目录');
  };

  const restore = async () => {
    try {
      const savedSettings = await ctx.storage.get(STORAGE_SETTINGS);
      if (savedSettings && typeof savedSettings === 'object') {
        Object.assign(state.settings, DEFAULT_SETTINGS, savedSettings);
        if (
          !Array.isArray(state.settings.preferredExternalSources) ||
          state.settings.preferredExternalSources.length === 0
        ) {
          state.settings.preferredExternalSources = [...DEFAULT_SETTINGS.preferredExternalSources];
        }
        if (!Array.isArray(state.settings.localFolders)) {
          state.settings.localFolders = [];
        }
      }
    } catch {}
    try {
      const savedPinned = await ctx.storage.get(STORAGE_PINNED);
      if (savedPinned && typeof savedPinned === 'object') {
        const normalized = {};
        for (const [k, val] of Object.entries(savedPinned)) {
          const entry = normalizePinnedEntry(k, val);
          if (entry) normalized[k] = entry;
        }
        state.pinned = normalized;
      }
    } catch {}
    try {
      const savedHistory = await ctx.storage.get(STORAGE_HISTORY);
      if (Array.isArray(savedHistory)) {
        state.history = savedHistory;
      }
    } catch {}
    void rebuildLocalIndex();
  };

  return {
    state,
    restore,
    saveSettings,
    clearHistory,
    rebuildLocalIndex,
    addLocalFolder,
    removeLocalFolder,
    testCustomApi,
    scanAllCandidates,
    scanCandidatesFor,
    openSwitcherForTrack,
    materializeCandidate,
    resolvePinnedDescriptor,
    applyTemporaryCandidate,
    applyAndPinCandidate,
    downloadCandidate,
    unpinTrack,
    unpinAllTracks,
    resolveAudioSourceWaterfall,
    resolveLyricWaterfall,
  };
};

// ---- 原生极简样式 (严格使用 EchoMusic surfaces.css / shapes.css 令牌，零硬编码色值) ----

const CSS = `
.emu-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: var(--bg-main);
  color: var(--color-text-main);
}
.emu-scroll {
  flex: 1;
  min-height: 0;
}
.emu-header-details {
  display: contents;
}
.emu-header-subtitle {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-secondary);
  line-height: 1.45;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.emu-header-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-text-secondary);
}
.emu-header-dot {
  opacity: 0.45;
}
.emu-status-on {
  color: var(--color-primary-text);
  font-weight: 600;
}
.emu-status-off {
  color: var(--color-text-secondary);
}
.emu-header-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.emu-btn-inner {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.emu-collapsed-primary {
  color: var(--color-primary-text);
}
.emu-collapsed-primary:hover {
  background: var(--control-hover-bg);
}
.emu-collapsed-icon:hover {
  background: var(--control-hover-bg);
}

/* 吸顶原生下划线 Tabs（严格对齐 Cloud.vue，仅 1px var(--border-subtle) 底线） */
.emu-tabs-root {
  width: 100%;
}
.emu-sticky-header {
  position: sticky;
  z-index: 110;
  background: var(--bg-main);
}
.emu-sticky-inner {
  padding: 0 24px;
}
.emu-sticky-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 56px;
  border-bottom: 1px solid var(--border-subtle);
}
.emu-tabs-list {
  display: flex;
  align-items: center;
  gap: 28px;
  height: 36px;
  background: transparent;
  border: none;
}
.emu-tab-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
}
.emu-sticky-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.emu-search-box {
  width: 210px;
  max-width: 36vw;
}

/* 主体内容区与无边框清爽分组 */
.emu-tab-panel {
  padding: 20px 24px 48px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.emu-panel-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px;
  border-radius: var(--radius-card, 10px);
  background: var(--content-panel-bg);
  border: none;
}
.emu-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 28px;
}
.emu-section-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.emu-section-title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--color-text-main);
  line-height: 1.35;
}
.emu-section-sub {
  margin: 0;
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.emu-section-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* 无边框清爽列表行（默认透明，hover 显示 var(--row-hover-bg)） */
.emu-flat-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.emu-flat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 12px;
  border-radius: var(--radius-item, 6px);
  background: transparent;
  transition: background-color 0.14s ease;
}
.emu-flat-row:hover {
  background: var(--row-hover-bg);
}
.emu-row-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.emu-row-title-line {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.emu-row-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-main);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.emu-row-artist {
  font-size: 12px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.emu-row-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--color-text-secondary);
  line-height: 1.4;
}
.emu-tag-accent {
  color: var(--color-primary-text);
  font-weight: 600;
}
.emu-tag-muted {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: var(--radius-detail, 4px);
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 600;
}
.emu-row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.emu-flat-row .emu-hover-reveal {
  opacity: 0.72;
  transition: opacity 0.14s ease;
}
.emu-flat-row:hover .emu-hover-reveal {
  opacity: 1;
}

.emu-empty {
  padding: 36px 16px;
  text-align: center;
  font-size: 12.5px;
  color: var(--color-text-secondary);
  line-height: 1.6;
}

/* 设置分组（供插件设置弹窗与页面右侧 Drawer 复用，无外框轻底色） */
.emu-settings-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.emu-settings-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.emu-settings-heading {
  margin: 0;
  padding: 0 4px;
  font-size: 12px;
  font-weight: 650;
  color: var(--color-text-secondary);
}
.emu-settings-group {
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-card, 10px);
  background: var(--content-panel-bg);
  border: none;
  padding: 4px 16px;
}
.emu-setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.emu-setting-row:last-child {
  border-bottom: none;
}
.emu-setting-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.emu-setting-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-main);
}
.emu-setting-desc {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.45;
}
.emu-priority-controls {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.emu-priority-rank {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: var(--radius-detail, 4px);
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}
.emu-priority-rank.is-active {
  background: var(--control-active-bg);
  color: var(--color-primary-text);
}
.emu-api-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 0;
}
.emu-api-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}
.emu-api-status {
  font-size: 12px;
  color: var(--color-text-secondary);
  min-width: 0;
  flex: 1;
}
.emu-api-status.is-ok {
  color: var(--color-primary-text);
}
.emu-api-status.is-err {
  color: var(--control-danger-text);
}
.emu-settings-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding-top: 4px;
}

/* 设置右侧抽屉 */
.emu-settings-drawer {
  width: min(440px, 90vw);
}
.emu-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 24px 24px;
}

/* 原生 Dialog 换源弹窗内容样式 */
.emu-switcher-dialog {
  width: min(640px, 92vw);
  max-width: 92vw;
  max-height: min(760px, calc(100vh - 140px));
}
.emu-dialog-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.emu-dialog-target-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.emu-status-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-card, 10px);
  background: var(--content-panel-bg);
  border: none;
}
.emu-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-subtle);
}
.emu-filter-links {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}
.emu-filter-link {
  appearance: none;
  background: transparent;
  border: none;
  padding: 4px 2px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.14s ease, border-color 0.14s ease;
}
.emu-filter-link:hover {
  color: var(--color-text-main);
}
.emu-filter-link.is-active {
  color: var(--color-primary-text);
  border-bottom-color: var(--color-primary);
}
`;

let engine = null;

export function activate(ctx) {
  const { h, defineComponent, defineAsyncComponent, computed, ref, watch, onBeforeUnmount, resolveComponent } = ctx.vue;

  ctx.css.inject(CSS, { id: 'echo-music-unblock-style' });
  engine = createUnblockEngine(ctx);
  void engine.restore();

  const loadComponent = (name, fallbackTag = 'div') => {
    const entry = ctx.ui?.components?.[name];
    if (!entry) return fallbackTag;
    if (typeof entry === 'function') return defineAsyncComponent(entry);
    return entry;
  };

  const Button = loadComponent('Button', 'button');
  const Switch = loadComponent('Switch', 'input');
  const Input = loadComponent('Input', 'input');
  const Badge = loadComponent('Badge', 'span');
  const Tabs = loadComponent('Tabs', 'div');
  const TabsList = loadComponent('TabsList', 'div');
  const TabsTrigger = loadComponent('TabsTrigger', 'button');
  const TabsContent = loadComponent('TabsContent', 'div');
  const Dialog = loadComponent('Dialog', 'div');
  const Drawer = loadComponent('Drawer', 'div');
  const DrawerHeader = loadComponent('DrawerHeader', 'header');
  const Popconfirm = loadComponent('Popconfirm', 'div');
  const PageScrollContainer = loadComponent('PageScrollContainer', 'div');
  const PageStickyHeader = loadComponent('PageStickyHeader', 'div');
  const DetailPageSliverHeader = loadComponent('DetailPageSliverHeader', 'div');
  const SongSearchInput = ctx.ui?.components?.SongSearchInput
    ? loadComponent('SongSearchInput', Input)
    : null;

  // 暴露跨插件调用桥接（供 echo-music-download 灰歌自动解灰下载与歌词刮削复用）
  globalThis.__echoMusicUnblock = {
    version: PLUGIN_VERSION,
    resolveSongForDownload: (song, quality = '320') =>
      engine.resolveAudioSourceWaterfall(song, quality, 'download-fallback'),
    resolveLyricForDownload: (song) => engine.resolveLyricWaterfall(song),
    scanCandidates: (song, quality = '320') => engine.scanAllCandidates(song, quality),
    openSwitcher: (song) => engine.openSwitcherForTrack(song),
    getPinnedCount: () => Object.keys(engine.state.pinned).length,
  };

  // 1. 注册 before-catalog 音源解析器（会话试听覆盖 / 手动锁定源 / 本地无损直通）
  ctx.player.audioSource.register({
    id: 'unblock-before-catalog',
    order: 50,
    position: 'before-catalog',
    match: ({ track }) => {
      if (!engine.state.settings.enabled) return false;
      const key = getTrackKey(track);
      if (key && (engine.state.sessionOverrides[key] || engine.state.pinned[key])) return true;
      return Boolean(engine.state.settings.localPriority && engine.state.settings.enableLocal);
    },
    resolve: ({ track, quality }) =>
      engine.resolveAudioSourceWaterfall(track, quality || '320', 'before-catalog'),
  });

  // 2. 注册 after-catalog 与 final-fallback 音源解析器（核心灰歌/无版权自动解灰与低音质提权）
  ctx.player.audioSource.register({
    id: 'unblock-after-catalog',
    order: 100,
    position: 'after-catalog',
    match: () => Boolean(engine.state.settings.enabled),
    resolve: ({ track, quality }) =>
      engine.resolveAudioSourceWaterfall(track, quality || '320', 'after-catalog'),
    transformStages: ['catalog'],
    transform: async ({ track, quality, source }) => {
      if (!engine.state.settings.enabled || !engine.state.settings.upgradeLowQuality) return null;
      if ((quality === '320' || quality === 'flac') && source?.quality === '128') {
        const upgraded = await engine.resolveAudioSourceWaterfall(track, quality, 'after-catalog');
        if (upgraded?.url && upgraded.quality !== '128') return upgraded;
      }
      return null;
    },
  });

  ctx.player.audioSource.register({
    id: 'unblock-final-fallback',
    order: 100,
    position: 'final-fallback',
    match: () => Boolean(engine.state.settings.enabled),
    resolve: ({ track, quality }) =>
      engine.resolveAudioSourceWaterfall(track, quality || '320', 'final-fallback'),
  });

  // 3. 注册多源双语歌词兜底解析器
  ctx.lyrics.registerResolver({
    id: 'unblock-lyric-fallback',
    order: 200,
    match: () =>
      Boolean(engine.state.settings.enabled && engine.state.settings.enableLyricFallback),
    resolve: ({ track }) => engine.resolveLyricWaterfall(track),
  });

  // 切歌时同步重置或匹配当前歌曲徽标状态
  ctx.events?.onTrackChange?.((track) => {
    const key = getTrackKey(track);
    if (!key) {
      engine.state.activeTrackStatus = null;
      return;
    }
    if (engine.state.sessionOverrides[key]) {
      const o = engine.state.sessionOverrides[key];
      engine.state.activeTrackStatus = {
        trackKey: key,
        channel: o.channel || 'external',
        label: `试听 · ${o.channelLabel || '临时音源'}`,
        quality: o.quality || '320',
        matchedTitle: o.title,
        matchedArtist: o.artist,
        matchedHash: o.hash || '',
        externalId: o.externalId || '',
        lyricId: o.lyricId || '',
        sourcePlatform: o.sourcePlatform || '',
        baseKey: o.baseKey || '',
        url: o.url,
        isTemporary: true,
      };
    } else if (engine.state.pinned[key]) {
      const p = engine.state.pinned[key];
      engine.state.activeTrackStatus = {
        trackKey: key,
        channel: 'pinned',
        label: p.channelLabel || '锁定音源',
        quality: p.quality || '320',
        matchedTitle: p.title,
        matchedArtist: p.artist,
        matchedHash: p.hash || '',
        externalId: p.externalId || '',
        lyricId: p.lyricId || '',
        sourcePlatform: p.sourcePlatform || '',
        baseKey: p.localItem?.baseKey || '',
        url: p.url,
      };
    } else if (engine.state.activeTrackStatus?.trackKey !== key) {
      engine.state.activeTrackStatus = null;
    }
  });

  // 4. 注册播放栏右侧音源徽标与快速换源按钮（严格绑定 currentTrack）
  ctx.ui.playerbar.register({
    id: 'unblock-switcher',
    title: '音源解灰与换源',
    icon: ctx.icons?.iconSparkles || ctx.icons?.iconMusic || 'tabler:sparkles',
    tooltip: '查看当前音源状态 / 手动切换解灰音源',
    defaultPlacement: 'right',
    badgeDefaultVisible: true,
    badge: () => {
      const status = engine.state.activeTrackStatus;
      if (!status) return null;
      return CHANNEL_META[status.channel]?.short || '解灰';
    },
    onClick: () => {
      void engine.openSwitcherForTrack(ctx.player?.currentTrack?.value ?? null);
    },
  });

  const navigateToUnblockPage = () => {
    try {
      if (ctx.router?.push) {
        void ctx.router.push({
          name: 'plugin-page',
          params: { pluginId: ctx.id || 'echo-music-unblock', pageId: 'unblock' },
        });
        return;
      }
    } catch {}
    try {
      if (ctx.router?.push) {
        void ctx.router.push(`/plugin/${ctx.id || 'echo-music-unblock'}/unblock`);
      }
    } catch {}
  };

  // ---- 独立轻量设置面板（复用于 ctx.ui.settings.define 与页面右侧 Drawer，绝不嵌套 PageScrollContainer） ----
  const createSettingsPanel = ({ showOpenPageButton = false } = {}) =>
    defineComponent({
      name: showOpenPageButton ? 'EchoMusicUnblockSettingsDialogPanel' : 'EchoMusicUnblockSettingsPanel',
      setup() {
        const Icon = resolveComponent('Icon');
        const customApiDraft = ref(engine.state.settings.customApiUrl || '');
        let debounceTimer = null;

        watch(
          () => engine.state.settings.customApiUrl,
          (val) => {
            if (String(val ?? '') !== customApiDraft.value) {
              customApiDraft.value = String(val ?? '');
            }
          },
        );

        const flushCustomApi = () => {
          if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
          }
          const trimmed = String(customApiDraft.value || '').trim();
          if (trimmed !== engine.state.settings.customApiUrl) {
            void engine.saveSettings({ customApiUrl: trimmed });
          }
        };

        const handleCustomApiInput = (v) => {
          customApiDraft.value = String(v ?? '');
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void engine.saveSettings({ customApiUrl: String(customApiDraft.value || '').trim() });
          }, 450);
        };

        onBeforeUnmount(() => {
          flushCustomApi();
        });

        // 构造带排序顺序的外部平台列表：已启用的按 preferredExternalSources 排序，未启用的排在后方
        const orderedPlatforms = computed(() => {
          const activeIds = Array.isArray(engine.state.settings.preferredExternalSources)
            ? engine.state.settings.preferredExternalSources
            : [];
          const activeList = activeIds
            .map((id) => EXTERNAL_PLATFORMS.find((p) => p.id === id))
            .filter(Boolean)
            .map((p, idx) => ({ ...p, enabled: true, rank: idx + 1 }));
          const inactiveList = EXTERNAL_PLATFORMS.filter((p) => !activeIds.includes(p.id)).map((p) => ({
            ...p,
            enabled: false,
            rank: null,
          }));
          return [...activeList, ...inactiveList];
        });

        const togglePlatform = (platformId, nextEnabled) => {
          const current = Array.isArray(engine.state.settings.preferredExternalSources)
            ? [...engine.state.settings.preferredExternalSources]
            : [];
          let next;
          if (nextEnabled) {
            next = current.includes(platformId) ? current : [...current, platformId];
          } else {
            next = current.filter((id) => id !== platformId);
          }
          void engine.saveSettings({ preferredExternalSources: next });
        };

        const movePlatform = (platformId, delta) => {
          const current = Array.isArray(engine.state.settings.preferredExternalSources)
            ? [...engine.state.settings.preferredExternalSources]
            : [];
          const idx = current.indexOf(platformId);
          const targetIdx = idx + delta;
          if (idx < 0 || targetIdx < 0 || targetIdx >= current.length) return;
          const [moved] = current.splice(idx, 1);
          current.splice(targetIdx, 0, moved);
          void engine.saveSettings({ preferredExternalSources: current });
        };

        const renderToggleRow = (label, desc, value, onChange, { disabled = false } = {}) =>
          h('div', { class: 'emu-setting-row' }, [
            h('div', { class: 'emu-setting-copy' }, [
              h('span', { class: 'emu-setting-label' }, label),
              h('span', { class: 'emu-setting-desc' }, desc),
            ]),
            h(Switch, {
              modelValue: Boolean(value),
              disabled,
              size: 'sm',
              'onUpdate:modelValue': (v) => onChange(Boolean(v)),
            }),
          ]);

        return () => {
          const s = engine.state.settings;
          const enabledPlatformCount = Array.isArray(s.preferredExternalSources)
            ? s.preferredExternalSources.length
            : 0;

          return h('div', { class: 'emu-settings-panel' }, [
            h('div', { class: 'emu-settings-section' }, [
              h('h4', { class: 'emu-settings-heading' }, '解灰通道与音质'),
              h('div', { class: 'emu-settings-group' }, [
                renderToggleRow(
                  '启用音源自动解灰',
                  '酷狗曲库无版权或灰歌无法播放时自动按通道接管解析',
                  s.enabled,
                  (v) => engine.saveSettings({ enabled: v }),
                ),
                renderToggleRow(
                  '本地曲库直通优先',
                  '若本地已授权目录存在同名无损或高品质音频，优先直通免耗流量',
                  s.localPriority,
                  (v) => engine.saveSettings({ localPriority: v }),
                  { disabled: !s.enabled || !s.enableLocal },
                ),
                renderToggleRow(
                  '启用本地目录匹配',
                  '允许解灰引擎检索本地音乐目录与歌曲下载目录中的音频文件',
                  s.enableLocal,
                  (v) => engine.saveSettings({ enableLocal: v }),
                  { disabled: !s.enabled },
                ),
                renderToggleRow(
                  '酷狗同曲异版智能替换',
                  '自动检索酷狗内同名同歌手的其他可播专辑版本（智能过滤伴奏与 DJ 版）',
                  s.enableKugouAlt,
                  (v) => engine.saveSettings({ enableKugouAlt: v }),
                  { disabled: !s.enabled },
                ),
                renderToggleRow(
                  '外部多平台音源解灰',
                  '当酷狗曲库无可用版本时，通过外部多平台聚合接口自动匹配播放',
                  s.enableExternalApi,
                  (v) => engine.saveSettings({ enableExternalApi: v }),
                  { disabled: !s.enabled },
                ),
                renderToggleRow(
                  '低音质自动提权 (128k → 320k/FLAC)',
                  '当目标音质为 320k/FLAC 但曲库仅返回 128k 时，尝试升级为高品音源',
                  s.upgradeLowQuality,
                  (v) => engine.saveSettings({ upgradeLowQuality: v }),
                  { disabled: !s.enabled },
                ),
              ]),
            ]),

            h('div', { class: 'emu-settings-section' }, [
              h('h4', { class: 'emu-settings-heading' }, '歌词兜底'),
              h('div', { class: 'emu-settings-group' }, [
                renderToggleRow(
                  '多源歌词自动兜底',
                  '缺失歌词时依次尝试本地 .lrc、酷狗异版、网易云与 LRCLIB',
                  s.enableLyricFallback,
                  (v) => engine.saveSettings({ enableLyricFallback: v }),
                  { disabled: !s.enabled },
                ),
                renderToggleRow(
                  '自动合并中译双语歌词',
                  '通过网易云兜底歌词时自动合并原文与中文翻译时间戳',
                  s.bilingualLyric,
                  (v) => engine.saveSettings({ bilingualLyric: v }),
                  { disabled: !s.enabled || !s.enableLyricFallback },
                ),
              ]),
            ]),

            h('div', { class: 'emu-settings-section' }, [
              h('h4', { class: 'emu-settings-heading' }, '外部平台优先级'),
              h(
                'div',
                { class: 'emu-settings-group' },
                orderedPlatforms.value.map((plat) =>
                  h('div', { class: 'emu-setting-row', key: plat.id }, [
                    h('div', { class: 'emu-priority-controls' }, [
                      h(
                        'span',
                        { class: ['emu-priority-rank', plat.enabled ? 'is-active' : ''] },
                        plat.enabled ? String(plat.rank) : '—',
                      ),
                      h('div', { class: 'emu-setting-copy' }, [
                        h('span', { class: 'emu-setting-label' }, plat.label),
                        h('span', { class: 'emu-setting-desc' }, plat.short),
                      ]),
                    ]),
                    h('div', { class: 'emu-priority-controls' }, [
                      plat.enabled
                        ? h(
                            Button,
                            {
                              variant: 'ghost',
                              size: 'icon',
                              tooltip: '上移优先级',
                              disabled: plat.rank <= 1,
                              onClick: () => movePlatform(plat.id, -1),
                            },
                            {
                              default: () =>
                                h(Icon, {
                                  icon: ctx.icons?.iconChevronUp || ctx.icons?.iconArrowUp || 'tabler:chevron-up',
                                  width: 14,
                                  height: 14,
                                }),
                            },
                          )
                        : null,
                      plat.enabled
                        ? h(
                            Button,
                            {
                              variant: 'ghost',
                              size: 'icon',
                              tooltip: '下移优先级',
                              disabled: plat.rank >= enabledPlatformCount,
                              onClick: () => movePlatform(plat.id, 1),
                            },
                            {
                              default: () =>
                                h(Icon, {
                                  icon: ctx.icons?.iconChevronDown || ctx.icons?.iconArrowDown || 'tabler:chevron-down',
                                  width: 14,
                                  height: 14,
                                }),
                            },
                          )
                        : null,
                      h(Switch, {
                        modelValue: plat.enabled,
                        size: 'sm',
                        'onUpdate:modelValue': (v) => togglePlatform(plat.id, Boolean(v)),
                      }),
                    ]),
                  ]),
                ),
              ),
            ]),

            h('div', { class: 'emu-settings-section' }, [
              h('h4', { class: 'emu-settings-heading' }, '自定义外部音源 API（可选）'),
              h('div', { class: 'emu-settings-group' }, [
                h('div', { class: 'emu-api-box' }, [
                  h(
                    'span',
                    { class: 'emu-setting-desc' },
                    '支持占位符：{title}、{artist}、{album}、{keyword}、{quality}、{hash}。留空将使用内置公共多平台源。',
                  ),
                  h(Input, {
                    modelValue: customApiDraft.value,
                    placeholder: 'https://your-api.example.com/match?title={title}&artist={artist}&quality={quality}',
                    size: 'compact',
                    'onUpdate:modelValue': handleCustomApiInput,
                    onBlur: flushCustomApi,
                  }),
                  h('div', { class: 'emu-api-actions' }, [
                    h(
                      'span',
                      {
                        class: [
                          'emu-api-status',
                          engine.state.testApiOk === true
                            ? 'is-ok'
                            : engine.state.testApiOk === false
                              ? 'is-err'
                              : '',
                        ],
                      },
                      engine.state.testApiResult || '输入后自动保存，可点击右侧按钮验证接口返回格式',
                    ),
                    h(
                      Button,
                      {
                        variant: 'soft-secondary',
                        size: 'xs',
                        loading: engine.state.testingApi,
                        disabled: engine.state.testingApi || !customApiDraft.value.trim(),
                        onClick: () => {
                          flushCustomApi();
                          void engine.testCustomApi(customApiDraft.value);
                        },
                      },
                      { default: () => (engine.state.testingApi ? '测试中…' : '测试连通性') },
                    ),
                  ]),
                ]),
              ]),
            ]),

            showOpenPageButton
              ? h('div', { class: 'emu-settings-footer' }, [
                  h(
                    Button,
                    {
                      variant: 'soft-primary',
                      size: 'default',
                      onClick: navigateToUnblockPage,
                    },
                    {
                      default: () =>
                        h('span', { class: 'emu-btn-inner' }, [
                          h(Icon, {
                            icon: ctx.icons?.iconExternalLink || ctx.icons?.iconSparkles || 'tabler:external-link',
                            width: 15,
                            height: 15,
                          }),
                          h('span', null, '打开音源解灰中心'),
                        ]),
                    },
                  ),
                ])
              : null,
          ]);
        };
      },
    });

  const UnblockSettingsPanel = createSettingsPanel({ showOpenPageButton: false });
  const UnblockSettingsDialogPanel = createSettingsPanel({ showOpenPageButton: true });

  // 5. 宿主原生 Dialog 手动换源弹窗（严格绑定 modalTargetTrack，自动支持 Esc 与弹窗栈）
  const SwitcherDialog = defineComponent({
    name: 'EchoMusicUnblockSwitcherDialog',
    setup() {
      const Icon = resolveComponent('Icon');
      const currentTrack = computed(() => ctx.player?.currentTrack?.value ?? null);
      const targetTrack = computed(() => engine.state.modalTargetTrack || currentTrack.value);
      const channelFilter = ref('all');

      watch(
        () => getTrackKey(targetTrack.value),
        () => {
          channelFilter.value = 'all';
        },
      );

      const targetKey = computed(() => getTrackKey(targetTrack.value));
      const matchedCandidates = computed(() =>
        targetKey.value && engine.state.candidatesTrackKey === targetKey.value
          ? engine.state.candidates
          : [],
      );
      const filteredCandidates = computed(() => {
        if (channelFilter.value === 'all') return matchedCandidates.value;
        return matchedCandidates.value.filter((c) => c.channel === channelFilter.value);
      });

      const countByChannel = (id) => {
        if (id === 'all') return matchedCandidates.value.length;
        return matchedCandidates.value.filter((c) => c.channel === id).length;
      };

      return () => {
        const track = targetTrack.value;
        const meta = extractSongMeta(track);
        const key = targetKey.value;
        const currentKey = getTrackKey(currentTrack.value);
        const isCurrentPlaying = Boolean(key && currentKey && key === currentKey);
        const pinnedEntry = key ? engine.state.pinned[key] : null;
        const sessionOverride = key ? engine.state.sessionOverrides[key] : null;
        const activeStatus =
          engine.state.activeTrackStatus && engine.state.activeTrackStatus.trackKey === key
            ? engine.state.activeTrackStatus
            : null;
        const hasDownloadBridge = Boolean(globalThis.__echoMusicDownload);

        const targetDescParts = [];
        if (meta.title) {
          targetDescParts.push(meta.artist ? `${meta.title} - ${meta.artist}` : meta.title);
          if (meta.album) targetDescParts.push(`专辑：${meta.album}`);
          if (meta.duration > 0) targetDescParts.push(formatDuration(meta.duration));
        }

        return h(
          Dialog,
          {
            open: engine.state.dialogOpen,
            title: '音源诊断与手动换源',
            showClose: true,
            contentClass: 'emu-switcher-dialog',
            'onUpdate:open': (val) => {
              engine.state.dialogOpen = Boolean(val);
            },
          },
          {
            description: () =>
              h('span', { class: 'emu-dialog-target-meta' }, [
                h('span', null, targetDescParts.join(' · ') || '当前未选择歌曲'),
                meta.title
                  ? h(
                      'span',
                      { class: 'emu-tag-muted' },
                      isCurrentPlaying ? '正在播放' : '指定歌曲',
                    )
                  : null,
              ]),
            default: () =>
              h('div', { class: 'emu-dialog-stack' }, [
                // 当前目标曲目生效/锁定状态条
                pinnedEntry || sessionOverride || activeStatus
                  ? h('div', { class: 'emu-status-banner' }, [
                      h('div', { class: 'emu-row-main' }, [
                        h(
                          'div',
                          { class: 'emu-row-title' },
                          pinnedEntry
                            ? `已锁定音源：${pinnedEntry.channelLabel}`
                            : sessionOverride
                              ? `本次试听：${sessionOverride.channelLabel}`
                              : `当前生效：${activeStatus.label}`,
                        ),
                        h('div', { class: 'emu-row-meta' }, [
                          h(
                            'span',
                            { class: 'emu-tag-accent' },
                            String(
                              (pinnedEntry || sessionOverride || activeStatus)?.quality || '320',
                            ).toUpperCase(),
                          ),
                          h(
                            'span',
                            null,
                            pinnedEntry
                              ? formatPinnedDescriptorHint(pinnedEntry)
                              : `${(sessionOverride || activeStatus)?.title || activeStatus?.matchedTitle || meta.title}`,
                          ),
                        ]),
                      ]),
                      pinnedEntry
                        ? h(
                            Popconfirm,
                            {
                              title: '解除该歌曲的音源锁定？',
                              description: '解除后将恢复自动解灰与默认曲库播放。',
                              tone: 'danger',
                              confirmText: '解除锁定',
                              onConfirm: () => engine.unpinTrack(track),
                            },
                            {
                              trigger: () =>
                                h(
                                  Button,
                                  { variant: 'outline', size: 'xs' },
                                  { default: () => '解除锁定' },
                                ),
                            },
                          )
                        : null,
                    ])
                  : null,

                // 通道筛选文字链接 + 重新扫描
                h('div', { class: 'emu-filter-bar' }, [
                  h(
                    'div',
                    { class: 'emu-filter-links' },
                    CHANNEL_FILTERS.map((f) => {
                      const cnt = countByChannel(f.id);
                      return h(
                        'button',
                        {
                          key: f.id,
                          type: 'button',
                          class: ['emu-filter-link', channelFilter.value === f.id ? 'is-active' : ''],
                          onClick: () => {
                            channelFilter.value = f.id;
                          },
                        },
                        cnt > 0 ? `${f.label} (${cnt})` : f.label,
                      );
                    }),
                  ),
                  h(
                    Button,
                    {
                      variant: 'soft-primary',
                      size: 'xs',
                      loading: engine.state.scanningCandidates,
                      disabled: engine.state.scanningCandidates || !track,
                      onClick: () => engine.scanCandidatesFor(track, 'flac'),
                    },
                    { default: () => (engine.state.scanningCandidates ? '检索中…' : '重新扫描') },
                  ),
                ]),

                // 候选列表
                engine.state.scanningCandidates
                  ? h('div', { class: 'emu-empty' }, '正在检索本地曲库、酷狗异版与多平台外部音源…')
                  : filteredCandidates.value.length === 0
                    ? h(
                        'div',
                        { class: 'emu-empty' },
                        matchedCandidates.value.length === 0
                          ? '暂未找到候选替换音源，可点击「重新扫描」或检查通道设置'
                          : '当前筛选通道下暂无候选音源',
                      )
                    : h(
                        'div',
                        { class: 'emu-flat-list' },
                        filteredCandidates.value.map((cand) => {
                          const durCompare = formatDurationCompare(meta.duration, cand.duration);
                          const sameAlbum =
                            meta.album &&
                            cand.album &&
                            normalizeText(meta.album) === normalizeText(cand.album);
                          return h('div', { class: 'emu-flat-row', key: cand.id }, [
                            h('div', { class: 'emu-row-main' }, [
                              h('div', { class: 'emu-row-title-line' }, [
                                h('span', { class: 'emu-row-title' }, cand.title || meta.title),
                                cand.artist
                                  ? h('span', { class: 'emu-row-artist' }, `· ${cand.artist}`)
                                  : null,
                              ]),
                              h('div', { class: 'emu-row-meta' }, [
                                h('span', { class: 'emu-tag-accent' }, cand.channelLabel),
                                h(
                                  'span',
                                  { class: 'emu-tag-muted' },
                                  String(cand.quality || '320').toUpperCase(),
                                ),
                                h('span', null, `匹配 ${Math.round((cand.score || 0) * 100)}%`),
                                cand.album
                                  ? h(
                                      'span',
                                      { class: sameAlbum ? 'emu-tag-accent' : '' },
                                      sameAlbum ? `专辑一致 · ${cand.album}` : `专辑：${cand.album}`,
                                    )
                                  : null,
                                durCompare ? h('span', null, durCompare) : null,
                              ]),
                            ]),
                            h('div', { class: 'emu-row-actions' }, [
                              hasDownloadBridge
                                ? h(
                                    Button,
                                    {
                                      variant: 'ghost',
                                      size: 'xs',
                                      tooltip: '使用此候选音源下载',
                                      onClick: () => engine.downloadCandidate(track, cand),
                                    },
                                    {
                                      default: () =>
                                        h('span', { class: 'emu-btn-inner' }, [
                                          h(Icon, {
                                            icon:
                                              ctx.icons?.iconArrowBarToDown ||
                                              ctx.icons?.iconCloudDownload ||
                                              'tabler:download',
                                            width: 14,
                                            height: 14,
                                          }),
                                          h('span', null, '下载此音源'),
                                        ]),
                                    },
                                  )
                                : null,
                              h(
                                Button,
                                {
                                  variant: 'soft-secondary',
                                  size: 'xs',
                                  onClick: () => engine.applyTemporaryCandidate(track, cand),
                                },
                                { default: () => '仅本次试听' },
                              ),
                              h(
                                Button,
                                {
                                  variant: 'soft-primary',
                                  size: 'xs',
                                  onClick: () => engine.applyAndPinCandidate(track, cand),
                                },
                                { default: () => '切换并锁定' },
                              ),
                            ]),
                          ]);
                        }),
                      ),
              ]),
          },
        );
      };
    },
  });

  ctx.ui.teleport(SwitcherDialog, { id: 'echo-music-unblock-modal' });

  // 6. 主管理页面（DetailPageSliverHeader + 原生下划线 Tabs + 设置侧滑 Drawer）
  const UnblockPage = defineComponent({
    name: 'EchoMusicUnblockPage',
    setup() {
      const Icon = resolveComponent('Icon');
      const activeTab = ref('history');
      const headerRef = ref(null);
      const settingsDrawerOpen = ref(false);
      const searchQuery = ref('');
      const stickyTop = computed(() => headerRef.value?.currentHeight ?? 56);
      const currentTrack = computed(() => ctx.player?.currentTrack?.value ?? null);
      const coverUrl = computed(
        () =>
          ctx.cover?.createThemedIconCoverUrl?.({
            icon: ctx.icons?.iconSparkles || ctx.icons?.iconMusic,
          }) || '',
      );

      watch(activeTab, () => {
        searchQuery.value = '';
      });

      const pinnedEntries = computed(() =>
        Object.values(engine.state.pinned).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
      );

      const filteredHistory = computed(() => {
        const q = searchQuery.value.trim().toLowerCase();
        if (!q) return engine.state.history;
        return engine.state.history.filter(
          (item) =>
            String(item.title || '').toLowerCase().includes(q) ||
            String(item.artist || '').toLowerCase().includes(q) ||
            String(item.channelLabel || '').toLowerCase().includes(q),
        );
      });

      const filteredPinned = computed(() => {
        const q = searchQuery.value.trim().toLowerCase();
        if (!q) return pinnedEntries.value;
        return pinnedEntries.value.filter(
          (item) =>
            String(item.targetTitle || item.title || '').toLowerCase().includes(q) ||
            String(item.targetArtist || item.artist || '').toLowerCase().includes(q) ||
            String(item.channelLabel || '').toLowerCase().includes(q) ||
            String(item.sourcePlatform || '').toLowerCase().includes(q),
        );
      });

      const filteredLocalTracks = computed(() => {
        const q = searchQuery.value.trim().toLowerCase();
        const list = q
          ? engine.state.localIndex.filter(
              (item) =>
                String(item.title || item.name || '').toLowerCase().includes(q) ||
                String(item.artist || '').toLowerCase().includes(q) ||
                String(item.folderName || '').toLowerCase().includes(q),
            )
          : engine.state.localIndex;
        return list.slice(0, 60);
      });

      const searchPlaceholder = computed(() => {
        if (activeTab.value === 'pinned') return '搜索已锁定歌曲…';
        if (activeTab.value === 'local') return '搜索本地音频…';
        return '搜索解灰记录…';
      });

      const renderSearchInput = () =>
        SongSearchInput
          ? h(SongSearchInput, {
              modelValue: searchQuery.value,
              placeholder: searchPlaceholder.value,
              'onUpdate:modelValue': (v) => {
                searchQuery.value = String(v ?? '');
              },
            })
          : h('div', { class: 'emu-search-box' }, [
              h(Input, {
                modelValue: searchQuery.value,
                placeholder: searchPlaceholder.value,
                size: 'compact',
                'onUpdate:modelValue': (v) => {
                  searchQuery.value = String(v ?? '');
                },
              }),
            ]);

      const renderHistoryTab = () => {
        const track = currentTrack.value;
        const meta = extractSongMeta(track);
        const currentKey = getTrackKey(track);
        const currentPinned = currentKey ? engine.state.pinned[currentKey] : null;
        const currentActive =
          engine.state.activeTrackStatus && engine.state.activeTrackStatus.trackKey === currentKey
            ? engine.state.activeTrackStatus
            : null;
        const inlineCandidates =
          currentKey && engine.state.candidatesTrackKey === currentKey
            ? engine.state.candidates.slice(0, 5)
            : [];

        return h('div', { class: 'emu-tab-panel' }, [
          // 区块 1：当前播放歌曲诊断
          h('section', { class: 'emu-panel-group' }, [
            h('div', { class: 'emu-section-head' }, [
              h('div', { class: 'emu-section-copy' }, [
                h('h3', { class: 'emu-section-title' }, '当前播放诊断'),
                h(
                  'p',
                  { class: 'emu-section-sub' },
                  meta.title
                    ? `${meta.title}${meta.artist ? ` · ${meta.artist}` : ''}${
                        currentPinned
                          ? ` · 已锁定 (${currentPinned.channelLabel})`
                          : currentActive
                            ? ` · ${currentActive.label}`
                            : ' · 原生曲库'
                      }`
                    : '当前未播放歌曲，开始播放后可在此快速检测可用替换音源',
                ),
              ]),
              h('div', { class: 'emu-section-actions' }, [
                currentPinned
                  ? h(
                      Popconfirm,
                      {
                        title: '解除当前歌曲的音源锁定？',
                        tone: 'danger',
                        confirmText: '解除锁定',
                        onConfirm: () => engine.unpinTrack(track),
                      },
                      {
                        trigger: () =>
                          h(Button, { variant: 'ghost', size: 'xs' }, { default: () => '解除锁定' }),
                      },
                    )
                  : null,
                h(
                  Button,
                  {
                    variant: 'soft-secondary',
                    size: 'xs',
                    disabled: !track || engine.state.scanningCandidates,
                    onClick: () => engine.scanCandidatesFor(track, 'flac'),
                  },
                  { default: () => (engine.state.scanningCandidates ? '扫描中…' : '扫描候选') },
                ),
                h(
                  Button,
                  {
                    variant: 'soft-primary',
                    size: 'xs',
                    disabled: !track,
                    onClick: () => engine.openSwitcherForTrack(track),
                  },
                  { default: () => '打开换源面板' },
                ),
              ]),
            ]),
            inlineCandidates.length > 0
              ? h(
                  'div',
                  { class: 'emu-flat-list' },
                  inlineCandidates.map((cand) =>
                    h('div', { class: 'emu-flat-row', key: cand.id }, [
                      h('div', { class: 'emu-row-main' }, [
                        h('div', { class: 'emu-row-title-line' }, [
                          h('span', { class: 'emu-row-title' }, cand.title),
                          cand.artist ? h('span', { class: 'emu-row-artist' }, `· ${cand.artist}`) : null,
                        ]),
                        h('div', { class: 'emu-row-meta' }, [
                          h('span', { class: 'emu-tag-accent' }, cand.channelLabel),
                          h('span', { class: 'emu-tag-muted' }, String(cand.quality || '320').toUpperCase()),
                          h('span', null, `匹配 ${Math.round((cand.score || 0) * 100)}%`),
                          cand.album ? h('span', null, `专辑：${cand.album}`) : null,
                        ]),
                      ]),
                      h('div', { class: 'emu-row-actions' }, [
                        h(
                          Button,
                          {
                            variant: 'soft-secondary',
                            size: 'xs',
                            onClick: () => engine.applyTemporaryCandidate(track, cand),
                          },
                          { default: () => '仅本次试听' },
                        ),
                        h(
                          Button,
                          {
                            variant: 'soft-primary',
                            size: 'xs',
                            onClick: () => engine.applyAndPinCandidate(track, cand),
                          },
                          { default: () => '切换并锁定' },
                        ),
                      ]),
                    ]),
                  ),
                )
              : null,
          ]),

          // 区块 2：最近自动解灰与直通记录
          h('section', { class: 'emu-panel-group' }, [
            h('div', { class: 'emu-section-head' }, [
              h('div', { class: 'emu-section-copy' }, [
                h('h3', { class: 'emu-section-title' }, '最近自动解灰与直通记录'),
                h(
                  'p',
                  { class: 'emu-section-sub' },
                  `共 ${engine.state.history.length} 条记录，遇到无版权或灰歌时自动接管并留痕`,
                ),
              ]),
              engine.state.history.length > 0
                ? h(
                    Popconfirm,
                    {
                      title: '确认清空全部解灰记录？',
                      description: '仅清空历史流水，不影响已锁定的歌曲音源。',
                      tone: 'danger',
                      confirmText: '确认清空',
                      onConfirm: () => engine.clearHistory(),
                    },
                    {
                      trigger: () =>
                        h(
                          Button,
                          { variant: 'ghost', size: 'xs' },
                          { default: () => '清空记录' },
                        ),
                    },
                  )
                : null,
            ]),
            filteredHistory.value.length === 0
              ? h(
                  'div',
                  { class: 'emu-empty' },
                  engine.state.history.length === 0
                    ? '暂无解灰记录，播放无版权灰歌或命中本地无损曲库时将自动显示在这里'
                    : '没有匹配当前关键词的解灰记录',
                )
              : h(
                  'div',
                  { class: 'emu-flat-list' },
                  filteredHistory.value.map((item) =>
                    h('div', { class: 'emu-flat-row', key: item.id }, [
                      h('div', { class: 'emu-row-main' }, [
                        h('div', { class: 'emu-row-title-line' }, [
                          h('span', { class: 'emu-row-title' }, item.title || '未知歌曲'),
                          item.artist ? h('span', { class: 'emu-row-artist' }, `· ${item.artist}`) : null,
                        ]),
                        h('div', { class: 'emu-row-meta' }, [
                          h('span', { class: 'emu-tag-accent' }, item.channelLabel || item.channel),
                          h('span', { class: 'emu-tag-muted' }, String(item.quality || '320').toUpperCase()),
                          h('span', null, formatShortTime(item.timestamp)),
                        ]),
                      ]),
                      h('div', { class: 'emu-row-actions emu-hover-reveal' }, [
                        h(
                          Button,
                          {
                            variant: 'ghost',
                            size: 'xs',
                            onClick: () =>
                              engine.openSwitcherForTrack({
                                id: item.id,
                                hash: item.hash || '',
                                title: item.title,
                                artist: item.artist,
                                album: item.album || '',
                                duration: item.duration || 0,
                              }),
                          },
                          { default: () => '重新换源' },
                        ),
                      ]),
                    ]),
                  ),
                ),
          ]),
        ]);
      };

      const renderPinnedTab = () =>
        h('div', { class: 'emu-tab-panel' }, [
          h('section', { class: 'emu-panel-group' }, [
            h('div', { class: 'emu-section-head' }, [
              h('div', { class: 'emu-section-copy' }, [
                h('h3', { class: 'emu-section-title' }, '已锁定音源列表'),
                h(
                  'p',
                  { class: 'emu-section-sub' },
                  `已持久锁定 ${pinnedEntries.value.length} 首歌曲 · 已保存音源描述符，外部直链过期后播放时自动按需刷新`,
                ),
              ]),
              pinnedEntries.value.length > 0
                ? h(
                    Popconfirm,
                    {
                      title: '解除全部已锁定音源？',
                      description: `将移除全部 ${pinnedEntries.value.length} 首歌曲的手动锁定，恢复默认自动解灰策略。`,
                      tone: 'danger',
                      confirmText: '全部解除',
                      onConfirm: () => engine.unpinAllTracks(),
                    },
                    {
                      trigger: () =>
                        h(
                          Button,
                          { variant: 'danger', size: 'xs' },
                          { default: () => '解除全部锁定' },
                        ),
                    },
                  )
                : null,
            ]),
            filteredPinned.value.length === 0
              ? h(
                  'div',
                  { class: 'emu-empty' },
                  pinnedEntries.value.length === 0
                    ? '暂无已锁定歌曲，在换源弹窗中点击「切换并锁定」即可为歌曲固定专属音源'
                    : '没有找到匹配的已锁定歌曲',
                )
              : h(
                  'div',
                  { class: 'emu-flat-list' },
                  filteredPinned.value.map((entry) =>
                    h('div', { class: 'emu-flat-row', key: entry.trackKey }, [
                      h('div', { class: 'emu-row-main' }, [
                        h('div', { class: 'emu-row-title-line' }, [
                          h('span', { class: 'emu-row-title' }, entry.targetTitle || entry.title || '未知歌曲'),
                          entry.targetArtist || entry.artist
                            ? h('span', { class: 'emu-row-artist' }, `· ${entry.targetArtist || entry.artist}`)
                            : null,
                        ]),
                        h('div', { class: 'emu-row-meta' }, [
                          h('span', { class: 'emu-tag-accent' }, entry.channelLabel || '锁定源'),
                          h('span', { class: 'emu-tag-muted' }, String(entry.quality || '320').toUpperCase()),
                          h('span', null, formatPinnedDescriptorHint(entry)),
                          entry.updatedAt ? h('span', null, `更新于 ${formatShortTime(entry.updatedAt)}`) : null,
                        ]),
                      ]),
                      h('div', { class: 'emu-row-actions' }, [
                        h(
                          Button,
                          {
                            variant: 'ghost',
                            size: 'xs',
                            onClick: () =>
                              engine.openSwitcherForTrack({
                                id: entry.trackKey.startsWith('id:') ? entry.trackKey.slice(3) : '',
                                hash: entry.trackKey.startsWith('hash:') ? entry.trackKey.slice(5) : '',
                                title: entry.targetTitle || entry.title,
                                artist: entry.targetArtist || entry.artist,
                                album: entry.targetAlbum || entry.album || '',
                                duration: entry.targetDuration || entry.duration || 0,
                              }),
                          },
                          { default: () => '换源' },
                        ),
                        h(
                          Popconfirm,
                          {
                            title: '解除此歌曲的音源锁定？',
                            description: `解除「${entry.targetTitle || entry.title || '该歌曲'}」后将恢复自动解析。`,
                            tone: 'danger',
                            confirmText: '解除锁定',
                            onConfirm: () => engine.unpinTrack(entry.trackKey),
                          },
                          {
                            trigger: () =>
                              h(
                                Button,
                                { variant: 'ghost', size: 'xs' },
                                { default: () => '解除锁定' },
                              ),
                          },
                        ),
                      ]),
                    ]),
                  ),
                ),
          ]),
        ]);

      const renderLocalTab = () => {
        const dlInfo = globalThis.__echoMusicDownload?.getSaveDirInfo?.();
        return h('div', { class: 'emu-tab-panel' }, [
          h('section', { class: 'emu-panel-group' }, [
            h('div', { class: 'emu-section-head' }, [
              h('div', { class: 'emu-section-copy' }, [
                h('h3', { class: 'emu-section-title' }, '本地无损与已下载曲库目录'),
                h(
                  'p',
                  { class: 'emu-section-sub' },
                  `已索引 ${engine.state.localIndex.length} 首音频 · ${engine.state.localLyricIndex.size} 份本地 LRC 歌词${
                    dlInfo?.hasGrant ? ` · 已自动关联下载目录 (${dlInfo.saveDir})` : ''
                  }`,
                ),
              ]),
              h('div', { class: 'emu-section-actions' }, [
                h(
                  Button,
                  {
                    variant: 'soft-secondary',
                    size: 'xs',
                    loading: engine.state.localScanning,
                    disabled: engine.state.localScanning,
                    onClick: () => engine.rebuildLocalIndex(),
                  },
                  { default: () => (engine.state.localScanning ? '扫描中…' : '刷新索引') },
                ),
                h(
                  Button,
                  {
                    variant: 'soft-primary',
                    size: 'xs',
                    onClick: () => engine.addLocalFolder(),
                  },
                  { default: () => '添加目录' },
                ),
              ]),
            ]),
            engine.state.settings.localFolders.length === 0
              ? h(
                  'div',
                  { class: 'emu-empty' },
                  dlInfo?.hasGrant
                    ? '已自动关联「歌曲下载」目录；你也可以点击右上角添加更多本地无损音乐文件夹'
                    : '尚未手动添加本地曲库目录（授权歌曲下载目录后也将自动识别关联）',
                )
              : h(
                  'div',
                  { class: 'emu-flat-list' },
                  engine.state.settings.localFolders.map((folder) =>
                    h('div', { class: 'emu-flat-row', key: folder.id || folder.path }, [
                      h('div', { class: 'emu-row-main' }, [
                        h('div', { class: 'emu-row-title' }, folder.name || '本地音乐目录'),
                        h('div', { class: 'emu-row-meta' }, [h('span', null, folder.path)]),
                      ]),
                      h('div', { class: 'emu-row-actions' }, [
                        h(
                          Popconfirm,
                          {
                            title: '移除此本地曲库目录？',
                            description: '仅取消目录索引关联，不会删除硬盘上的任何音频文件。',
                            tone: 'danger',
                            confirmText: '确认移除',
                            onConfirm: () => engine.removeLocalFolder(folder.id || folder.path),
                          },
                          {
                            trigger: () =>
                              h(
                                Button,
                                { variant: 'ghost', size: 'xs' },
                                { default: () => '移除' },
                              ),
                          },
                        ),
                      ]),
                    ]),
                  ),
                ),
          ]),

          // 已索引音频预览
          engine.state.localIndex.length > 0
            ? h('section', { class: 'emu-panel-group' }, [
                h('div', { class: 'emu-section-head' }, [
                  h('div', { class: 'emu-section-copy' }, [
                    h('h3', { class: 'emu-section-title' }, '已索引本地音频'),
                    h(
                      'p',
                      { class: 'emu-section-sub' },
                      searchQuery.value.trim()
                        ? `匹配 ${filteredLocalTracks.value.length} 首（最多展示 60 条）`
                        : `展示前 ${filteredLocalTracks.value.length} 首，共 ${engine.state.localIndex.length} 首`,
                    ),
                  ]),
                ]),
                filteredLocalTracks.value.length === 0
                  ? h('div', { class: 'emu-empty' }, '没有匹配当前搜索词的本地音频')
                  : h(
                      'div',
                      { class: 'emu-flat-list' },
                      filteredLocalTracks.value.map((item, idx) =>
                        h('div', { class: 'emu-flat-row', key: `${item.path || item.name}-${idx}` }, [
                          h('div', { class: 'emu-row-main' }, [
                            h('div', { class: 'emu-row-title-line' }, [
                              h('span', { class: 'emu-row-title' }, item.title || item.name),
                              item.artist
                                ? h('span', { class: 'emu-row-artist' }, `· ${item.artist}`)
                                : null,
                            ]),
                            h('div', { class: 'emu-row-meta' }, [
                              h('span', { class: 'emu-tag-accent' }, item.folderName),
                              h('span', { class: 'emu-tag-muted' }, String(item.ext || 'mp3').toUpperCase()),
                              h('span', null, item.name),
                            ]),
                          ]),
                        ]),
                      ),
                    ),
              ])
            : null,
        ]);
      };

      return () =>
        h('div', { class: 'emu-root' }, [
          h(
            PageScrollContainer,
            { class: 'emu-scroll' },
            {
              default: () => [
                h(
                  DetailPageSliverHeader,
                  {
                    ref: headerRef,
                    typeLabel: 'UNBLOCK',
                    title: '音源解灰与歌词兜底',
                    coverUrl: coverUrl.value,
                    hasDetails: true,
                    distributeDetails: true,
                    expandedHeight: 176,
                    collapsedHeight: 56,
                  },
                  {
                    details: () =>
                      h('div', { class: 'emu-header-details' }, [
                        h(
                          'div',
                          { class: 'emu-header-subtitle' },
                          '全通道灰歌自动接管 · 本地直通 · 酷狗异版 · 多平台外源与双语歌词',
                        ),
                        h('div', { class: 'emu-header-stats' }, [
                          h(
                            'span',
                            { class: engine.state.settings.enabled ? 'emu-status-on' : 'emu-status-off' },
                            engine.state.settings.enabled ? '自动解灰已开启' : '自动解灰已暂停',
                          ),
                          h('span', { class: 'emu-header-dot' }, '·'),
                          h('span', null, `本地索引 ${engine.state.localIndex.length} 首`),
                          h('span', { class: 'emu-header-dot' }, '·'),
                          h('span', null, `已锁定 ${pinnedEntries.value.length} 首`),
                          h('span', { class: 'emu-header-dot' }, '·'),
                          h('span', null, `解灰记录 ${engine.state.history.length} 条`),
                        ]),
                      ]),
                    actions: () =>
                      h('div', { class: 'emu-header-actions' }, [
                        h(
                          Button,
                          {
                            variant: 'soft-primary',
                            size: 'default',
                            onClick: () =>
                              engine.openSwitcherForTrack(ctx.player?.currentTrack?.value ?? null),
                          },
                          {
                            default: () =>
                              h('span', { class: 'emu-btn-inner' }, [
                                h(Icon, {
                                  icon: ctx.icons?.iconSparkles || ctx.icons?.iconMusic || 'tabler:sparkles',
                                  width: 16,
                                  height: 16,
                                }),
                                h('span', null, '当前歌曲换源'),
                              ]),
                          },
                        ),
                        h(
                          Button,
                          {
                            variant: 'soft-secondary',
                            size: 'default',
                            loading: engine.state.localScanning,
                            onClick: () => engine.rebuildLocalIndex(),
                          },
                          {
                            default: () =>
                              h('span', { class: 'emu-btn-inner' }, [
                                h(Icon, {
                                  icon: ctx.icons?.iconRefreshCw || 'tabler:refresh',
                                  width: 15,
                                  height: 15,
                                }),
                                h('span', null, '刷新本地索引'),
                              ]),
                          },
                        ),
                        h(
                          Button,
                          {
                            variant: 'ghost',
                            size: 'icon',
                            tooltip: '通道与接口设置',
                            onClick: () => {
                              settingsDrawerOpen.value = true;
                            },
                          },
                          {
                            default: () =>
                              h(Icon, {
                                icon: ctx.icons?.iconSettings || 'tabler:settings',
                                width: 17,
                                height: 17,
                              }),
                          },
                        ),
                      ]),
                    'collapsed-actions': () => [
                      h(
                        Button,
                        {
                          variant: 'unstyled',
                          size: 'icon',
                          class: 'action-icon emu-collapsed-primary',
                          tooltip: '当前歌曲换源',
                          onClick: () =>
                            engine.openSwitcherForTrack(ctx.player?.currentTrack?.value ?? null),
                        },
                        {
                          default: () =>
                            h(Icon, {
                              icon: ctx.icons?.iconSparkles || ctx.icons?.iconMusic || 'tabler:sparkles',
                              width: 18,
                              height: 18,
                            }),
                        },
                      ),
                      h(
                        Button,
                        {
                          variant: 'unstyled',
                          size: 'icon',
                          class: 'action-icon icon-action emu-collapsed-icon',
                          tooltip: '刷新本地索引',
                          onClick: () => engine.rebuildLocalIndex(),
                        },
                        {
                          default: () =>
                            h(Icon, {
                              icon: ctx.icons?.iconRefreshCw || 'tabler:refresh',
                              width: 17,
                              height: 17,
                            }),
                        },
                      ),
                      h(
                        Button,
                        {
                          variant: 'unstyled',
                          size: 'icon',
                          class: 'action-icon icon-action emu-collapsed-icon',
                          tooltip: '通道与接口设置',
                          onClick: () => {
                            settingsDrawerOpen.value = true;
                          },
                        },
                        {
                          default: () =>
                            h(Icon, {
                              icon: ctx.icons?.iconSettings || 'tabler:settings',
                              width: 17,
                              height: 17,
                            }),
                        },
                      ),
                    ],
                  },
                ),

                h(
                  Tabs,
                  {
                    modelValue: activeTab.value,
                    class: 'emu-tabs-root',
                    'onUpdate:modelValue': (val) => {
                      if (val) activeTab.value = String(val);
                    },
                  },
                  {
                    default: () => [
                      h(
                        PageStickyHeader,
                        {
                          class: 'emu-sticky-header',
                          stickyTop: stickyTop.value,
                          style: { top: `${stickyTop.value}px` },
                        },
                        {
                          default: () =>
                            h('div', { class: 'emu-sticky-inner' }, [
                              h('div', { class: 'emu-sticky-bar' }, [
                                h(
                                  TabsList,
                                  { class: 'emu-tabs-list' },
                                  {
                                    default: () => [
                                      h(
                                        TabsTrigger,
                                        { value: 'history' },
                                        {
                                          default: () =>
                                            h('span', { class: 'emu-tab-label' }, [
                                              h('span', null, '解灰与记录'),
                                              engine.state.history.length > 0
                                                ? h(Badge, {
                                                    count: engine.state.history.length,
                                                    tone: activeTab.value === 'history' ? 'accent' : 'neutral',
                                                  })
                                                : null,
                                            ]),
                                        },
                                      ),
                                      h(
                                        TabsTrigger,
                                        { value: 'pinned' },
                                        {
                                          default: () =>
                                            h('span', { class: 'emu-tab-label' }, [
                                              h('span', null, '已锁定音源'),
                                              pinnedEntries.value.length > 0
                                                ? h(Badge, {
                                                    count: pinnedEntries.value.length,
                                                    tone: activeTab.value === 'pinned' ? 'accent' : 'neutral',
                                                  })
                                                : null,
                                            ]),
                                        },
                                      ),
                                      h(
                                        TabsTrigger,
                                        { value: 'local' },
                                        {
                                          default: () =>
                                            h('span', { class: 'emu-tab-label' }, [
                                              h('span', null, '本地曲库'),
                                              engine.state.localIndex.length > 0
                                                ? h(Badge, {
                                                    count: engine.state.localIndex.length,
                                                    tone: activeTab.value === 'local' ? 'accent' : 'neutral',
                                                  })
                                                : null,
                                            ]),
                                        },
                                      ),
                                    ],
                                  },
                                ),
                                h('div', { class: 'emu-sticky-tools' }, [renderSearchInput()]),
                              ]),
                            ]),
                        },
                      ),
                      h(TabsContent, { value: 'history' }, { default: renderHistoryTab }),
                      h(TabsContent, { value: 'pinned' }, { default: renderPinnedTab }),
                      h(TabsContent, { value: 'local' }, { default: renderLocalTab }),
                    ],
                  },
                ),
              ],
            },
          ),

          // 右侧原生设置抽屉
          h(
            Drawer,
            {
              open: settingsDrawerOpen.value,
              title: '通道与接口设置',
              side: 'right',
              panelClass: 'emu-settings-drawer',
              'onUpdate:open': (v) => {
                settingsDrawerOpen.value = Boolean(v);
              },
            },
            {
              default: () => [
                h(DrawerHeader, {
                  title: '通道与接口设置',
                  description: '配置解灰优先级、外部平台顺序、双语歌词与自定义 API',
                  onClose: () => {
                    settingsDrawerOpen.value = false;
                  },
                }),
                h('div', { class: 'emu-drawer-body' }, [h(UnblockSettingsPanel)]),
              ],
            },
          ),
        ]);
    },
  });

  ctx.ui.addPage({
    id: 'unblock',
    title: '音源解灰',
    icon: ctx.icons?.iconSparkles || ctx.icons?.iconMusic || 'tabler:sparkles',
    component: UnblockPage,
    order: 28,
    sidebar: {
      section: 'plugins',
      title: '音源解灰',
      order: 28,
    },
  });

  // 独立轻量设置面板（绝不嵌套整页 PageScrollContainer / SliverHeader）
  ctx.ui.settings.define({
    id: 'echo-music-unblock-settings',
    title: '音源解灰与歌词兜底',
    description: '管理灰歌自动解灰通道、外部平台优先级、双语歌词兜底与自定义 API',
    component: UnblockSettingsDialogPanel,
  });

  // 右键任意歌曲换源：严格锁定目标曲目 modalTargetTrack，不误绑当前播放曲目
  ctx.ui.addSongContextMenuItem({
    id: 'unblock-match',
    label: '诊断 / 手动切换音源',
    onSelect: async (song) => {
      if (song) {
        await engine.openSwitcherForTrack(song);
      }
    },
  });
}

export function deactivate() {
  if (globalThis.__echoMusicUnblock) {
    delete globalThis.__echoMusicUnblock;
  }
  engine = null;
}
