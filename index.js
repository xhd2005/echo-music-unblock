// 音源解灰与歌词兜底插件 (echo-music-unblock v1.0.0)
// 基于 EchoMusic v2.3.2+ 的 ctx.player.audioSource.register 与 ctx.lyrics.registerResolver：
// 1. 本地授权目录无损/音频直通 (local)
// 2. 酷狗同曲异版智能替换 (kugou-alt)
// 3. 外部多平台音源接口解灰 (external: GDStudio / Meting / 网易云 / 自定义 API)
// 4. 多源双语歌词兜底 (本地 .lrc / 酷狗异版 / LRCLIB / 网易云原文+翻译双语合并)
// 5. 播放栏实时音源徽标 + 手动换源诊断弹窗 + 跨插件下载桥接 (globalThis.__echoMusicUnblock)

const STORAGE_SETTINGS = 'emu.settings.v1';
const STORAGE_PINNED = 'emu.pinned.v1';
const STORAGE_HISTORY = 'emu.history.v1';
const MAX_HISTORY_ITEMS = 80;
const LOCAL_SCAN_LIMIT = 10000;

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
  pinned: { label: '锁定源', short: '锁定', tone: 'primary' },
  local: { label: '本地曲库', short: '本地', tone: 'success' },
  'kugou-alt': { label: '酷狗异版', short: '异版', tone: 'warning' },
  external: { label: '外部音源', short: '解灰', tone: 'accent' },
};

// ---- 文本归一化与相似度计算 ----

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
  const duration = Number.isFinite(rawDur) && rawDur > 0 ? (rawDur > 10000 ? Math.round(rawDur / 1000) : Math.round(rawDur)) : 0;
  const hash = String(song.hash ?? song.FileHash ?? song.filehash ?? '').trim();
  const id = String(song.id ?? song.mixSongId ?? song.albumAudioId ?? hash ?? '').trim();
  const coverUrl = String(song.coverUrl ?? song.cover ?? song.img ?? song.Image ?? '').trim();
  return { id, hash, title, artist, album, duration, coverUrl };
};

const getTrackKey = (song) => {
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
  // 防止普通原曲误匹配伴奏/DJ版
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

// ---- 歌词工具（双语合并与 KRC/Base64 解码） ----

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
  const base = String(fileName || '').replace(/\.[^.]+$/, '').replace(/^\d+\s*[.\-_]\s*/, '').trim();
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

// ---- 核心状态与解灰引擎 ----

const createUnblockEngine = (ctx) => {
  const { reactive } = ctx.vue;

  const state = reactive({
    settings: { ...DEFAULT_SETTINGS, localFolders: [] },
    pinned: {},
    history: [],
    localIndex: [],
    localLyricIndex: new Map(),
    localScanning: false,
    activeTrackStatus: null,
    dialogOpen: false,
    scanningCandidates: false,
    candidates: [],
    testingApi: false,
    testApiResult: '',
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
              if (g && g.id && g.available !== false && !folders.some((f) => f.id === g.id || (g.displayPath && f.path === g.displayPath))) {
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
          const ext = String(
            file.extension || file.name?.match(/\.[^.]+$/)?.[0] || '',
          ).toLowerCase();
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

      // 自动复用 echo-music-download 跨插件桥中的已下载目录文件
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
            (Array.isArray(item?.Singers) ? item.Singers.map((s) => s?.name).filter(Boolean).join(' / ') : ''),
        ).trim();
        const candAlbum = String(item?.AlbumName ?? item?.album_name ?? '').trim();
        const candDur = Number(item?.Duration ?? item?.duration ?? 0);
        const hash320 = String(item?.HQFileHash ?? item?.HQ?.Hash ?? '').trim();
        const hashFlac = String(item?.SQFileHash ?? item?.SQ?.Hash ?? '').trim();
        const hash128 = String(item?.FileHash ?? item?.filehash ?? item?.hash ?? '').trim();
        const primaryHash = (preferredQuality === 'flac' && hashFlac) || (preferredQuality !== '128' && hash320) || hash128;
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

  const findExternalApiCandidates = async (songMeta, preferredQuality = '320') => {
    const results = [];
    const customTemplate = String(state.settings.customApiUrl || '').trim();
    const keyword = [songMeta.title, songMeta.artist].filter(Boolean).join(' ').trim();
    if (!keyword) return results;

    // 3A. 用户自定义音源接口模板
    if (customTemplate) {
      try {
        const builtUrl = customTemplate
          .replace(/\{title\}/gi, encodeURIComponent(songMeta.title || ''))
          .replace(/\{artist\}/gi, encodeURIComponent(songMeta.artist || ''))
          .replace(/\{album\}/gi, encodeURIComponent(songMeta.album || ''))
          .replace(/\{keyword\}/gi, encodeURIComponent(keyword))
          .replace(/\{quality\}/gi, encodeURIComponent(preferredQuality || '320'))
          .replace(/\{hash\}/gi, encodeURIComponent(songMeta.hash || ''));
        const data = await netFetchJson(builtUrl, { timeoutMs: 7000 });
        const urls = extractUrlsFromSongUrlResponse(data);
        if (urls.length > 0) {
          results.push({
            id: `external:custom:${urls[0]}`,
            channel: 'external',
            channelLabel: '自定义音源 API',
            sourcePlatform: 'custom',
            title: songMeta.title,
            artist: songMeta.artist,
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

    // 3B. GDStudio 多平台音源接口 (netease / kuwo / tencent)
    const platforms = Array.isArray(state.settings.preferredExternalSources) && state.settings.preferredExternalSources.length
      ? state.settings.preferredExternalSources
      : ['netease', 'kuwo'];
    for (const source of platforms.slice(0, 2)) {
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
            const score = scoreCandidate(songMeta, { title: candTitle, artist: candArtist, duration: 0 });
            if (score < 0.65) continue;
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
              quality: preferredQuality === 'flac' ? 'flac' : '320',
              score,
            });
          }
        }
      } catch {}
    }

    // 3C. 网易云官方搜索 + 外链直通兜底
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

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 6);
  };

  const resolveExternalCandidateUrl = async (cand, preferredQuality = '320') => {
    if (cand.url) {
      return { url: cand.url, urls: cand.urls || [cand.url], quality: cand.quality || '320' };
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
      // Meting 公共解析兜底
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
          if (/^https?:\/\//i.test(finalUrl) && !finalUrl.includes('api.i-meto.com') && !finalUrl.endsWith('/404')) {
            return { url: finalUrl, urls: [finalUrl], quality: '320' };
          }
        }
      } catch {}
    }
    return null;
  };

  // 全通道扫描候选列表（用于手动换源诊断弹窗 & 自动解灰瀑布流）
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

    // 1. 检查手动锁定音源
    const pinned = trackKey ? state.pinned[trackKey] : null;
    if (pinned && pinned.url) {
      state.activeTrackStatus = {
        trackKey,
        channel: 'pinned',
        label: pinned.channelLabel || '手动锁定源',
        quality: pinned.quality || preferredQuality,
        matchedTitle: pinned.title || songMeta.title,
        matchedArtist: pinned.artist || songMeta.artist,
        url: pinned.url,
      };
      return {
        url: pinned.url,
        urls: [pinned.url],
        quality: pinned.quality || '320',
        sourceKind: 'plugin',
      };
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
            channel: 'local',
            channelLabel: mat.channelLabel,
            quality: mat.quality,
          });
          return {
            url: mat.url,
            urls: mat.urls,
            quality: mat.quality,
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
          void recordHistory({
            trackKey,
            title: songMeta.title,
            artist: songMeta.artist,
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
    if (candidateHash && typeof ctx.kugou?.music?.searchLyric === 'function' && typeof ctx.kugou?.music?.getLyric === 'function') {
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

  // 手动应用并锁定候选音源
  const applyAndPinCandidate = async (song, cand) => {
    const trackKey = getTrackKey(song);
    if (!trackKey) return false;
    const mat = await materializeCandidate(cand, 'flac');
    if (!mat?.url) {
      ctx.toast.warning('该候选音源暂不可用，请尝试其他源');
      return false;
    }
    state.pinned[trackKey] = {
      channel: mat.channel,
      channelLabel: mat.channelLabel,
      title: mat.title,
      artist: mat.artist,
      quality: mat.quality,
      url: mat.url,
      hash: mat.hash || '',
      updatedAt: Date.now(),
    };
    await savePinned();
    state.activeTrackStatus = {
      trackKey,
      channel: 'pinned',
      label: `锁定 · ${mat.channelLabel}`,
      quality: mat.quality,
      matchedTitle: mat.title,
      matchedArtist: mat.artist,
      url: mat.url,
    };
    ctx.toast.success(`已切换并锁定音源：${mat.channelLabel}`);
    try {
      const currentId = ctx.player?.currentTrackId?.value;
      if (currentId) {
        await ctx.player.playTrack(currentId, { autoPlay: true });
      }
    } catch {}
    return true;
  };

  const unpinTrack = async (song) => {
    const trackKey = getTrackKey(song);
    if (!trackKey || !state.pinned[trackKey]) return;
    delete state.pinned[trackKey];
    await savePinned();
    if (state.activeTrackStatus?.trackKey === trackKey) {
      state.activeTrackStatus = null;
    }
    ctx.toast.info('已解除当前歌曲的锁定音源');
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
            ctx.toast.success(`已添加本地曲库目录：${displayPath}`);
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
          ctx.toast.success(`已添加本地曲库目录：${p}`);
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
  };

  const restore = async () => {
    try {
      const savedSettings = await ctx.storage.get(STORAGE_SETTINGS);
      if (savedSettings && typeof savedSettings === 'object') {
        Object.assign(state.settings, DEFAULT_SETTINGS, savedSettings);
      }
    } catch {}
    try {
      const savedPinned = await ctx.storage.get(STORAGE_PINNED);
      if (savedPinned && typeof savedPinned === 'object') {
        state.pinned = savedPinned;
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
    rebuildLocalIndex,
    addLocalFolder,
    removeLocalFolder,
    scanAllCandidates,
    materializeCandidate,
    applyAndPinCandidate,
    unpinTrack,
    resolveAudioSourceWaterfall,
    resolveLyricWaterfall,
  };
};

// ---- 样式 (遵循 EchoMusic v2.3.x 原生主题变量) ----

const CSS = `
.emu-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.emu-tabbar {
  --custom-tab-width: 380px;
  max-width: 100%;
}
.emu-tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.emu-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px 24px 48px;
}
.emu-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px;
  border-radius: 14px;
  background: var(--bg-info-card, var(--control-muted-bg, rgba(128, 128, 128, 0.06)));
  border: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.14));
}
.emu-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.emu-card-title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-main);
}
.emu-card-subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.emu-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.1));
}
.emu-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.emu-row-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.emu-row-label {
  font-size: 13px;
  font-weight: 650;
  color: var(--color-text-main);
}
.emu-row-desc {
  font-size: 12px;
  color: var(--color-text-secondary);
  line-height: 1.45;
}
.emu-cand-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.emu-cand-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--control-muted-bg, rgba(128, 128, 128, 0.06));
  border: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.12));
  transition: border-color 0.15s ease;
}
.emu-cand-item:hover {
  border-color: var(--color-primary);
}
.emu-cand-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.emu-cand-title {
  font-size: 13px;
  font-weight: 650;
  color: var(--color-text-main);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.emu-cand-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--color-text-secondary);
}
.emu-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  background: color-mix(in srgb, var(--color-primary) 14%, transparent);
  color: var(--color-primary);
}
.emu-pill-neutral {
  background: var(--control-muted-bg, rgba(128, 128, 128, 0.12));
  color: var(--color-text-secondary);
}
.emu-empty {
  padding: 36px 16px;
  text-align: center;
  font-size: 12.5px;
  color: var(--color-text-secondary);
}
.emu-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  background: rgba(0, 0, 0, 0.48);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}
.emu-modal {
  width: 100%;
  max-width: 560px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  border-radius: 16px;
  background: var(--bg-main, #1e1e20);
  border: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.2));
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.emu-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.14));
}
.emu-modal-body {
  padding: 16px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
`;

let engine = null;

export function activate(ctx) {
  const { h, defineComponent, defineAsyncComponent, computed, ref, resolveComponent } = ctx.vue;

  ctx.css.inject(CSS, { id: 'echo-music-unblock-style' });
  engine = createUnblockEngine(ctx);
  void engine.restore();

  // 暴露跨插件调用桥接（供 echo-music-download 灰歌自动解灰下载与歌词刮削复用）
  globalThis.__echoMusicUnblock = {
    version: '1.0.0',
    resolveSongForDownload: (song, quality = '320') =>
      engine.resolveAudioSourceWaterfall(song, quality, 'download-fallback'),
    resolveLyricForDownload: (song) => engine.resolveLyricWaterfall(song),
    scanCandidates: (song, quality = '320') => engine.scanAllCandidates(song, quality),
  };

  // 1. 注册 before-catalog 音源解析器（用于手动锁定源 & 本地无损直通）
  ctx.player.audioSource.register({
    id: 'unblock-before-catalog',
    order: 50,
    position: 'before-catalog',
    match: ({ track }) => {
      if (!engine.state.settings.enabled) return false;
      const key = getTrackKey(track);
      if (key && engine.state.pinned[key]) return true;
      return Boolean(engine.state.settings.localPriority && engine.state.settings.enableLocal);
    },
    resolve: ({ track, quality }) =>
      engine.resolveAudioSourceWaterfall(track, quality || '320', 'before-catalog'),
  });

  // 2. 注册 after-catalog 与 final-fallback 音源解析器（核心灰歌/无版权自动解灰）
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
    match: () => Boolean(engine.state.settings.enabled && engine.state.settings.enableLyricFallback),
    resolve: ({ track }) => engine.resolveLyricWaterfall(track),
  });

  // 切歌时同步重置或匹配当前歌曲徽标状态
  ctx.events?.onTrackChange?.((track) => {
    const key = getTrackKey(track);
    if (!key) {
      engine.state.activeTrackStatus = null;
      return;
    }
    if (engine.state.pinned[key]) {
      const p = engine.state.pinned[key];
      engine.state.activeTrackStatus = {
        trackKey: key,
        channel: 'pinned',
        label: p.channelLabel || '锁定音源',
        quality: p.quality || '320',
        matchedTitle: p.title,
        matchedArtist: p.artist,
        url: p.url,
      };
    } else if (engine.state.activeTrackStatus?.trackKey !== key) {
      engine.state.activeTrackStatus = null;
    }
  });

  const Button = defineAsyncComponent(ctx.ui.components.Button);
  const Switch = defineAsyncComponent(ctx.ui.components.Switch);
  const Input = defineAsyncComponent(ctx.ui.components.Input);
  const Badge = defineAsyncComponent(ctx.ui.components.Badge);
  const CustomTabBar = defineAsyncComponent(ctx.ui.components.CustomTabBar);
  const PageScrollContainer = defineAsyncComponent(ctx.ui.components.PageScrollContainer);
  const PageStickyHeader = defineAsyncComponent(ctx.ui.components.PageStickyHeader);
  const DetailPageSliverHeader = defineAsyncComponent(ctx.ui.components.DetailPageSliverHeader);

  const triggerCandidateScan = async () => {
    const track = ctx.player?.currentTrack?.value;
    if (!track) {
      ctx.toast.info('当前没有正在播放的歌曲');
      return;
    }
    engine.state.scanningCandidates = true;
    engine.state.candidates = [];
    try {
      const list = await engine.scanAllCandidates(track, 'flac');
      engine.state.candidates = list;
    } finally {
      engine.state.scanningCandidates = false;
    }
  };

  // 4. 注册播放栏右侧音源徽标与快速换源按钮
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
      engine.state.dialogOpen = true;
      void triggerCandidateScan();
    },
  });

  // 5. 手动换源浮层组件 (Teleport)
  const SwitcherModal = defineComponent({
    name: 'EchoMusicUnblockModal',
    setup() {
      const currentTrack = computed(() => ctx.player?.currentTrack?.value ?? null);
      return () => {
        if (!engine.state.dialogOpen) return null;
        const track = currentTrack.value;
        const meta = extractSongMeta(track);
        const trackKey = getTrackKey(track);
        const isPinned = Boolean(trackKey && engine.state.pinned[trackKey]);
        const activeStatus = engine.state.activeTrackStatus;

        return h(
          'div',
          {
            class: 'emu-modal-backdrop',
            onClick: (e) => {
              if (e.target === e.currentTarget) engine.state.dialogOpen = false;
            },
          },
          [
            h('div', { class: 'emu-modal' }, [
              h('div', { class: 'emu-modal-header' }, [
                h('div', null, [
                  h('h3', { class: 'emu-card-title' }, '音源诊断与手动换源'),
                  h(
                    'p',
                    { class: 'emu-card-subtitle' },
                    meta.title ? `${meta.title} - ${meta.artist || '未知歌手'}` : '当前未播放歌曲',
                  ),
                ]),
                h(
                  Button,
                  {
                    variant: 'ghost',
                    size: 'xs',
                    onClick: () => {
                      engine.state.dialogOpen = false;
                    },
                  },
                  { default: () => '关闭' },
                ),
              ]),
              h('div', { class: 'emu-modal-body' }, [
                activeStatus
                  ? h('div', { class: 'emu-cand-item' }, [
                      h('div', { class: 'emu-cand-main' }, [
                        h('div', { class: 'emu-cand-title' }, `当前生效：${activeStatus.label}`),
                        h('div', { class: 'emu-cand-meta' }, [
                          h('span', { class: 'emu-pill' }, String(activeStatus.quality || '320').toUpperCase()),
                          h('span', null, `${activeStatus.matchedTitle || meta.title}`),
                        ]),
                      ]),
                      isPinned
                        ? h(
                            Button,
                            {
                              variant: 'outline',
                              size: 'xs',
                              onClick: () => engine.unpinTrack(track),
                            },
                            { default: () => '解除锁定' },
                          )
                        : null,
                    ])
                  : null,
                h('div', { class: 'emu-card-header' }, [
                  h('span', { class: 'emu-row-label' }, '全通道候选音源'),
                  h(
                    Button,
                    {
                      variant: 'soft-primary',
                      size: 'xs',
                      disabled: engine.state.scanningCandidates || !track,
                      onClick: triggerCandidateScan,
                    },
                    { default: () => (engine.state.scanningCandidates ? '正在检索…' : '重新扫描') },
                  ),
                ]),
                engine.state.scanningCandidates
                  ? h('div', { class: 'emu-empty' }, '正在检索本地曲库、酷狗异版与多平台外部音源…')
                  : engine.state.candidates.length === 0
                    ? h('div', { class: 'emu-empty' }, '暂未找到候选替换音源')
                    : h(
                        'div',
                        { class: 'emu-cand-list' },
                        engine.state.candidates.map((cand) =>
                          h('div', { class: 'emu-cand-item', key: cand.id }, [
                            h('div', { class: 'emu-cand-main' }, [
                              h('div', { class: 'emu-cand-title' }, `${cand.title} - ${cand.artist || '未知歌手'}`),
                              h('div', { class: 'emu-cand-meta' }, [
                                h('span', { class: 'emu-pill' }, cand.channelLabel),
                                h('span', { class: 'emu-pill emu-pill-neutral' }, String(cand.quality || '320').toUpperCase()),
                                h('span', null, `匹配度 ${Math.round((cand.score || 0) * 100)}%`),
                              ]),
                            ]),
                            h(
                              Button,
                              {
                                variant: 'soft-primary',
                                size: 'xs',
                                onClick: () => engine.applyAndPinCandidate(track, cand),
                              },
                              { default: () => '使用此源' },
                            ),
                          ]),
                        ),
                      ),
              ]),
            ]),
          ],
        );
      };
    },
  });

  ctx.ui.teleport(SwitcherModal, { id: 'echo-music-unblock-modal' });

  // 6. 主管理页面 (DetailPageSliverHeader + PageStickyHeader + CustomTabBar)
  const UnblockPage = defineComponent({
    name: 'EchoMusicUnblockPage',
    setup() {
      const Icon = resolveComponent('Icon');
      const activeTab = ref('diagnostics');
      const headerRef = ref(null);
      const stickyTop = computed(() => headerRef.value?.currentHeight ?? 56);
      const currentTrack = computed(() => ctx.player?.currentTrack?.value ?? null);
      const coverUrl = computed(() =>
        ctx.cover.createThemedIconCoverUrl({ icon: ctx.icons.iconSparkles || ctx.icons.iconMusic }),
      );

      const tabs = [
        { value: 'diagnostics', label: '音源诊断与记录', count: () => engine.state.history.length },
        { value: 'local', label: '本地曲库直通', count: () => engine.state.localIndex.length },
        { value: 'settings', label: '通道与接口设置', count: () => 0 },
      ];
      const tabValues = tabs.map((t) => t.value);
      const tabLabels = tabs.map((t) => t.label);
      const tabIndex = computed({
        get: () => Math.max(0, tabValues.indexOf(activeTab.value)),
        set: (idx) => {
          const next = tabValues[idx];
          if (next) activeTab.value = next;
        },
      });

      const renderDiagnosticsTab = () => {
        const track = currentTrack.value;
        const meta = extractSongMeta(track);
        return h('div', { class: 'emu-body' }, [
          h('div', { class: 'emu-card' }, [
            h('div', { class: 'emu-card-header' }, [
              h('div', null, [
                h('h3', { class: 'emu-card-title' }, '当前播放歌曲诊断'),
                h(
                  'p',
                  { class: 'emu-card-subtitle' },
                  meta.title ? `${meta.title} · ${meta.artist || '未知歌手'}` : '暂未播放歌曲',
                ),
              ]),
              h(
                Button,
                {
                  variant: 'soft-primary',
                  size: 'sm',
                  disabled: !track || engine.state.scanningCandidates,
                  onClick: triggerCandidateScan,
                },
                { default: () => (engine.state.scanningCandidates ? '扫描中…' : '扫描可用音源') },
              ),
            ]),
            engine.state.candidates.length > 0
              ? h(
                  'div',
                  { class: 'emu-cand-list' },
                  engine.state.candidates.map((cand) =>
                    h('div', { class: 'emu-cand-item', key: cand.id }, [
                      h('div', { class: 'emu-cand-main' }, [
                        h('div', { class: 'emu-cand-title' }, `${cand.title} - ${cand.artist}`),
                        h('div', { class: 'emu-cand-meta' }, [
                          h('span', { class: 'emu-pill' }, cand.channelLabel),
                          h('span', { class: 'emu-pill emu-pill-neutral' }, String(cand.quality || '320').toUpperCase()),
                          h('span', null, `匹配度 ${Math.round((cand.score || 0) * 100)}%`),
                        ]),
                      ]),
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
                  ),
                )
              : h('div', { class: 'emu-empty' }, '点击右上角「扫描可用音源」可检测本地、酷狗异版与多平台音源候选'),
          ]),
          h('div', { class: 'emu-card' }, [
            h('div', { class: 'emu-card-header' }, [
              h('h3', { class: 'emu-card-title' }, '最近自动解灰与直通记录'),
              engine.state.history.length > 0
                ? h(
                    Button,
                    {
                      variant: 'ghost',
                      size: 'xs',
                      onClick: async () => {
                        engine.state.history = [];
                        await ctx.storage.set(STORAGE_HISTORY, []);
                      },
                    },
                    { default: () => '清空记录' },
                  )
                : null,
            ]),
            engine.state.history.length === 0
              ? h('div', { class: 'emu-empty' }, '暂无解灰记录，遇到无版权/灰歌时将自动触发接管')
              : h(
                  'div',
                  { class: 'emu-cand-list' },
                  engine.state.history.map((item) =>
                    h('div', { class: 'emu-cand-item', key: item.id }, [
                      h('div', { class: 'emu-cand-main' }, [
                        h('div', { class: 'emu-cand-title' }, `${item.title} - ${item.artist || '未知歌手'}`),
                        h('div', { class: 'emu-cand-meta' }, [
                          h('span', { class: 'emu-pill' }, item.channelLabel || item.channel),
                          h('span', { class: 'emu-pill emu-pill-neutral' }, String(item.quality || '320').toUpperCase()),
                          h('span', null, new Date(item.timestamp).toLocaleString()),
                        ]),
                      ]),
                    ]),
                  ),
                ),
          ]),
        ]);
      };

      const renderLocalTab = () =>
        h('div', { class: 'emu-body' }, [
          h('div', { class: 'emu-card' }, [
            h('div', { class: 'emu-card-header' }, [
              h('div', null, [
                h('h3', { class: 'emu-card-title' }, '本地无损/已下载曲库目录'),
                h(
                  'p',
                  { class: 'emu-card-subtitle' },
                  `已索引 ${engine.state.localIndex.length} 首本地音频 · ${engine.state.localLyricIndex.size} 份本地 LRC 歌词`,
                ),
              ]),
              h('div', { class: 'flex items-center gap-2' }, [
                h(
                  Button,
                  {
                    variant: 'soft-secondary',
                    size: 'sm',
                    disabled: engine.state.localScanning,
                    onClick: () => engine.rebuildLocalIndex(),
                  },
                  { default: () => (engine.state.localScanning ? '扫描中…' : '刷新索引') },
                ),
                h(
                  Button,
                  {
                    variant: 'soft-primary',
                    size: 'sm',
                    onClick: () => engine.addLocalFolder(),
                  },
                  { default: () => '添加目录' },
                ),
              ]),
            ]),
            engine.state.settings.localFolders.length === 0
              ? h('div', { class: 'emu-empty' }, '尚未手动添加目录（若已授权歌曲下载目录，插件会自动识别并关联）')
              : h(
                  'div',
                  { class: 'emu-cand-list' },
                  engine.state.settings.localFolders.map((folder) =>
                    h('div', { class: 'emu-cand-item', key: folder.id || folder.path }, [
                      h('div', { class: 'emu-cand-main' }, [
                        h('div', { class: 'emu-cand-title' }, folder.name || '本地音乐目录'),
                        h('div', { class: 'emu-cand-meta' }, [h('span', null, folder.path)]),
                      ]),
                      h(
                        Button,
                        {
                          variant: 'outline',
                          size: 'xs',
                          onClick: () => engine.removeLocalFolder(folder.id || folder.path),
                        },
                        { default: () => '移除' },
                      ),
                    ]),
                  ),
                ),
          ]),
        ]);

      const renderSettingsTab = () =>
        h('div', { class: 'emu-body' }, [
          h('div', { class: 'emu-card' }, [
            h('h3', { class: 'emu-card-title' }, '解灰通道与优先级开关'),
            h('div', { class: 'emu-row' }, [
              h('div', { class: 'emu-row-copy' }, [
                h('span', { class: 'emu-row-label' }, '启用音源自动解灰'),
                h('span', { class: 'emu-row-desc' }, '当酷狗曲库无版权或灰歌无法播放时自动接管解析'),
              ]),
              h(Switch, {
                modelValue: engine.state.settings.enabled,
                'onUpdate:modelValue': (v) => engine.saveSettings({ enabled: Boolean(v) }),
              }),
            ]),
            h('div', { class: 'emu-row' }, [
              h('div', { class: 'emu-row-copy' }, [
                h('span', { class: 'emu-row-label' }, '本地曲库直通优先 (Before-Catalog)'),
                h('span', { class: 'emu-row-desc' }, '若本地目录已有同名无损/高品质音频，直接播放本地文件免消耗流量'),
              ]),
              h(Switch, {
                modelValue: engine.state.settings.localPriority,
                'onUpdate:modelValue': (v) => engine.saveSettings({ localPriority: Boolean(v) }),
              }),
            ]),
            h('div', { class: 'emu-row' }, [
              h('div', { class: 'emu-row-copy' }, [
                h('span', { class: 'emu-row-label' }, '酷狗同曲异版智能替换'),
                h('span', { class: 'emu-row-desc' }, '自动搜索酷狗内同名同歌手的其他可用专辑/合辑版本顶替灰歌'),
              ]),
              h(Switch, {
                modelValue: engine.state.settings.enableKugouAlt,
                'onUpdate:modelValue': (v) => engine.saveSettings({ enableKugouAlt: Boolean(v) }),
              }),
            ]),
            h('div', { class: 'emu-row' }, [
              h('div', { class: 'emu-row-copy' }, [
                h('span', { class: 'emu-row-label' }, '外部多平台音源解灰 (GDStudio / Meting / 网易云)'),
                h('span', { class: 'emu-row-desc' }, '当酷狗内无可用版本时，通过多平台音源接口自动匹配播放'),
              ]),
              h(Switch, {
                modelValue: engine.state.settings.enableExternalApi,
                'onUpdate:modelValue': (v) => engine.saveSettings({ enableExternalApi: Boolean(v) }),
              }),
            ]),
            h('div', { class: 'emu-row' }, [
              h('div', { class: 'emu-row-copy' }, [
                h('span', { class: 'emu-row-label' }, '低音质自动提权 (128k → 320k/FLAC)'),
                h('span', { class: 'emu-row-desc' }, '当目标音质为 320k/FLAC 但曲库仅返回 128k 时，尝试使用高音质源替换'),
              ]),
              h(Switch, {
                modelValue: engine.state.settings.upgradeLowQuality,
                'onUpdate:modelValue': (v) => engine.saveSettings({ upgradeLowQuality: Boolean(v) }),
              }),
            ]),
            h('div', { class: 'emu-row' }, [
              h('div', { class: 'emu-row-copy' }, [
                h('span', { class: 'emu-row-label' }, '多源双语歌词自动兜底 (LRCLIB / 网易云双语)'),
                h('span', { class: 'emu-row-desc' }, '缺失歌词时自动检索本地 LRC、网易云原文+翻译双语歌词与 LRCLIB'),
              ]),
              h(Switch, {
                modelValue: engine.state.settings.enableLyricFallback,
                'onUpdate:modelValue': (v) => engine.saveSettings({ enableLyricFallback: Boolean(v) }),
              }),
            ]),
          ]),
          h('div', { class: 'emu-card' }, [
            h('h3', { class: 'emu-card-title' }, '自定义外部音源 API 模板（可选）'),
            h(
              'p',
              { class: 'emu-card-subtitle' },
              '支持占位符：{title} 歌名、{artist} 歌手、{album} 专辑、{quality} 音质、{hash} 歌曲哈希。留空则默认使用内置多平台公共源。',
            ),
            h(Input, {
              modelValue: engine.state.settings.customApiUrl,
              placeholder: '例如：https://your-api.example.com/match?title={title}&artist={artist}&quality={quality}',
              'onUpdate:modelValue': (v) => engine.saveSettings({ customApiUrl: String(v ?? '').trim() }),
            }),
          ]),
        ]);

      return () =>
        h('div', { class: 'emu-page' }, [
          h(
            PageScrollContainer,
            { class: 'flex-1 min-h-0' },
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
                      h('div', { class: 'contents' }, [
                        h(
                          'div',
                          { class: 'text-[13px] font-semibold text-text-secondary' },
                          '全通道无版权灰歌自动接管 · 本地曲库直通 · 酷狗异版替换 · 双语歌词兜底',
                        ),
                        h(
                          'div',
                          {
                            class:
                              'flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] font-semibold text-text-secondary',
                          },
                          [
                            h('span', null, `本地索引 ${engine.state.localIndex.length} 首`),
                            h('span', null, `已锁定 ${Object.keys(engine.state.pinned).length} 首`),
                            h('span', null, `解灰记录 ${engine.state.history.length} 条`),
                          ],
                        ),
                      ]),
                    actions: () =>
                      h('div', { class: 'flex flex-wrap gap-2' }, [
                        h(
                          Button,
                          {
                            variant: 'soft-primary',
                            size: 'default',
                            class: 'flex items-center gap-2 rounded-lg text-[12px] font-semibold',
                            onClick: () => {
                              engine.state.dialogOpen = true;
                              void triggerCandidateScan();
                            },
                          },
                          {
                            default: () => [
                              h(Icon, { icon: ctx.icons.iconSparkles || ctx.icons.iconMusic, width: 16, height: 16 }),
                              h('span', null, '当前歌曲换源'),
                            ],
                          },
                        ),
                      ]),
                  },
                ),
                h(
                  PageStickyHeader,
                  { class: 'song-list-sticky sticky z-110 bg-bg-main', stickyTop: stickyTop.value },
                  {
                    default: () =>
                      h('div', { class: 'px-6' }, [
                        h(
                          'div',
                          { class: 'flex items-center justify-between h-14 border-b border-[var(--border-subtle)]' },
                          [
                            h(
                              CustomTabBar,
                              {
                                class: 'emu-tabbar',
                                modelValue: tabIndex.value,
                                tabs: tabLabels,
                                ariaLabel: '音源解灰导航',
                                'onUpdate:modelValue': (idx) => {
                                  tabIndex.value = idx;
                                },
                              },
                              {
                                tab: ({ label, index, selected }) => {
                                  const count = tabs[index]?.count?.() ?? 0;
                                  return [
                                    h('span', { class: 'emu-tab-label' }, label),
                                    count > 0 ? h(Badge, { count, tone: selected ? 'accent' : 'neutral' }) : null,
                                  ];
                                },
                              },
                            ),
                          ],
                        ),
                      ]),
                  },
                ),
                activeTab.value === 'diagnostics'
                  ? renderDiagnosticsTab()
                  : activeTab.value === 'local'
                    ? renderLocalTab()
                    : renderSettingsTab(),
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

  ctx.ui.settings.define({
    id: 'echo-music-unblock-settings',
    title: '音源解灰与歌词兜底',
    description: '管理灰歌自动解灰通道、本地无损曲库直通目录与外部双语歌词兜底',
    component: UnblockPage,
  });

  ctx.ui.addSongContextMenuItem({
    id: 'unblock-match',
    label: '诊断 / 手动切换音源',
    onSelect: async (song) => {
      if (song) {
        engine.state.dialogOpen = true;
        engine.state.scanningCandidates = true;
        try {
          engine.state.candidates = await engine.scanAllCandidates(song, 'flac');
        } finally {
          engine.state.scanningCandidates = false;
        }
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
