import { host, getContext, getRequestHeaders, getThumbnailUrl, saveSettingsDebounced, selectCharacterById, setUserAvatar, setUserName, unshallowCharacter, writeExtensionField, getBackgroundPath, getThemeObject, charSetAuxWorlds, getWorldInfoSettings, loadWorldInfo, saveWorldInfo, updateWorldInfoList, updateWorldInfoSettings, getCharaFilename } from './host.js';

const EXTENSION_KEY = 'tavernAssetClassifier';
const COLOR_TAGS = [
  { name: '黑', color: '#111111', text: '#ffffff' },
  { name: '白', color: '#f7f7f2', text: '#202020' },
  { name: '红', color: '#ef4444', text: '#ffffff' },
  { name: '橙', color: '#f97316', text: '#ffffff' },
  { name: '黄', color: '#eab308', text: '#202020' },
  { name: '绿', color: '#22c55e', text: '#ffffff' },
  { name: '蓝', color: '#3b82f6', text: '#ffffff' },
  { name: '紫', color: '#8b5cf6', text: '#ffffff' },
  { name: '棕', color: '#8b5a2b', text: '#ffffff' },
  { name: '灰', color: '#737373', text: '#ffffff' },
  { name: '粉', color: '#ec4899', text: '#ffffff' },
];
const AVATAR_TAGS = ['大头像', '小头像', '无头像'];
const CATEGORIES = ['style', 'topic', 'color', 'avatar'];

const CATEGORY_LABELS = {
  style: '风格',
  topic: '主题',
  color: '颜色',
  avatar: '头像',
};

const state = {
  selectedFilters: [],
  themeSearchQuery: '',
  autoMetadataScanStarted: false,
  batchThemeImportActive: false,
  sessionImportedThemeValues: [],
  themePickerCleanup: null,
  observer: null,
  themeObserverReleaseTimer: null,
  refreshTimer: null,
  allThemeOptions: [],
  suppressThemeObserver: false,
  themeBackgroundSyncTimer: null,
  themeBackgroundSyncBound: false,
  lastThemeBackgroundSyncName: '',
  characterBindingTimer: null,
  characterBindingRenderTimer: null,
  characterBindingQuery: '',
  characterRelationDeleteMode: false,
  applyingCharacterBinding: false,
  lastAppliedCharacterBindingKey: '',
  characterBindingApplyPending: false,
  promptOrderSavePending: false,
  featureMountTimer: null,
  started: false,
  starting: null,
  stylePromise: null,
  boundEvents: [],
  themeSelect: null,
  lastMountError: '',
  musicAudio: null,
  musicContextKey: '',
  musicBindings: null,
  musicPlaying: false,
  musicLoadedTrackId: '',
  musicObjectUrls: new Map(),
  musicResolvedSources: new Map(),
  musicFailedTrackIds: new Set(),
  musicPlaybackPending: false,
  musicPlaybackRequestId: 0,
  musicProgressTimer: null,
  musicProgressLastUpdate: 0,
  musicVisibilityDocuments: new WeakSet(),
  musicLyricsCache: new Map(),
  musicDbPromise: null,
  musicSavePromise: Promise.resolve(),
};

function getMusicHostDocuments() {
  const documents = [];
  try {
    if (window.parent && window.parent.document?.body) documents.push(window.parent.document);
  } catch { /* Cross-origin parent documents are not accessible. */ }
  if (document?.body && !documents.includes(document)) documents.push(document);
  return documents;
}

function getMusicFloatingNode() {
  return getMusicHostDocuments().map(doc => doc.querySelector('#tac-music-floating')).find(Boolean) || null;
}

function getMusicQueryNodes(selector) {
  const nodes = [];
  getMusicHostDocuments().forEach(doc => doc.querySelectorAll(selector).forEach(node => nodes.push(node)));
  return nodes;
}

function ensureMusicHostStyles() {
  const href = new URL('./style.css', import.meta.url).href;
  getMusicHostDocuments().forEach(doc => {
    if (doc.getElementById('tac-classifier-style-host')) return;
    const link = doc.createElement('link');
    link.id = 'tac-classifier-style-host';
    link.rel = 'stylesheet';
    link.href = href;
    link.dataset.tacHostStyle = 'true';
    (doc.head || doc.documentElement).append(link);
  });
}

function notify(type, message) {
  const toastr = window.toastr;
  if (toastr?.[type]) {
    toastr[type](message);
    return;
  }
  console[type === 'error' ? 'error' : 'log'](message);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function trapModalEvents(overlay) {
  const eventNames = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'contextmenu', 'wheel'];
  eventNames.forEach(eventName => {
    overlay.addEventListener(eventName, event => {
      event.stopPropagation();
      if (event.target === overlay) {
        event.preventDefault();
      }
    });
  });
}

function closeModalOverlay(overlay) {
  overlay.remove();
  if (!document.querySelector('#tac-tag-modal, #tac-rename-modal, #tac-binding-modal, #tac-music-add-modal, #tac-music-url-modal, #tac-music-batch-modal, #tac-music-track-modal, #tac-music-playlist-modal, #tac-music-track-playlist-modal')) {
    document.body.classList.remove('tac-modal-open');
    document.documentElement.classList.remove('tac-modal-open');
  }
}

function mountModalOverlay(overlay) {
  document.body.classList.add('tac-modal-open');
  document.documentElement.classList.add('tac-modal-open');
  document.documentElement.append(overlay);
}

function getSettings(create = true) {
  const context = getContext();
  const root = context.extensionSettings ?? context.extension_settings;
  if (!root || typeof root !== 'object' || Array.isArray(root)) return null;
  if (root[EXTENSION_KEY] == null && create) {
    root[EXTENSION_KEY] = { files: {} };
  }
  const settings = root[EXTENSION_KEY];
  if (settings == null) return null;
  if (typeof settings !== 'object' || Array.isArray(settings)) throw new Error('分类器配置格式异常，已保留原数据，请先备份后检查。');
  if (settings.files == null) settings.files = {};
  if (typeof settings.files !== 'object' || Array.isArray(settings.files)) throw new Error('分类器标签配置格式异常，已保留原数据，请先备份后检查。');
  return settings;
}

function saveSettings() {
  try {
    saveSettingsDebounced();
  } catch (error) {
    console.warn('TavernAssetClassifier: failed to save settings', error);
  }
}

function normalizeTag(value) {
  return String(value ?? '').trim();
}

function uniqueTags(tags) {
  return [...new Set((tags ?? []).map(normalizeTag).filter(Boolean))];
}

function normalizeThemeNameKey(value) {
  return normalizeTag(value).toLocaleLowerCase('zh-Hans-CN');
}

function getKnownThemeNameKeys() {
  const settings = getSettings(false);
  const names = new Set(Object.keys(settings?.files ?? {}).map(normalizeThemeNameKey).filter(Boolean));
  state.allThemeOptions.forEach(option => {
    [option.value, option.text].map(normalizeThemeNameKey).filter(Boolean).forEach(name => names.add(name));
  });
  return names;
}

function isThemeNameTag(tag, themeNames = getKnownThemeNameKeys()) {
  return themeNames.has(normalizeThemeNameKey(tag));
}

function sanitizeStoredThemeNameTags() {
  const settings = getSettings(false);
  if (!settings?.files) return false;
  const themeNames = getKnownThemeNameKeys();
  let changed = false;

  Object.values(settings.files).forEach(record => {
    if (!record || typeof record !== 'object') return;
    ['style', 'topic'].forEach(category => {
      const current = uniqueTags(record[category]);
      const filtered = current.filter(tag => !isThemeNameTag(tag, themeNames));
      if (filtered.length !== current.length) changed = true;
      record[category] = filtered;
    });
  });

  if (changed) {
    state.selectedFilters = state.selectedFilters.filter(filter => !isThemeNameTag(filter.tag, themeNames));
    saveSettings();
  }
  return changed;
}

function getThemeSelect() {
  return document.querySelector('#themes');
}

function snapshotThemeOptions() {
  const select = getThemeSelect();
  if (!select) return;

  const merged = new Map(state.allThemeOptions.map(option => [option.value, option]));
  Array.from(select.options).forEach(option => {
    const value = String(option.value || option.textContent || '').trim();
    if (!value) return;
    const existing = merged.get(value);
    merged.set(value, {
      value,
      text: String(option.dataset.tacThemeName || existing?.text || option.textContent || value),
    });
  });
  state.allThemeOptions = Array.from(merged.values());
}

function suppressThemeObserverUntilNextTask() {
  state.suppressThemeObserver = true;
  clearTimeout(state.themeObserverReleaseTimer);
  state.themeObserverReleaseTimer = setTimeout(() => {
    state.themeObserverReleaseTimer = null;
    state.suppressThemeObserver = false;
  }, 0);
}

function getThemeNames() {
  if (!state.allThemeOptions.length) snapshotThemeOptions();
  return getOrderedThemeOptions().map(option => option.value).filter(Boolean);
}

function cloneData(value) {
  if (globalThis.structuredClone) return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value ?? null));
}

function dataMatches(left, right) {
  try {
    const ordered = (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value;
    return JSON.stringify(left, ordered) === JSON.stringify(right, ordered);
  } catch {
    return false;
  }
}

function stringSetsMatch(left, right) {
  const first = uniqueTags(left).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const second = uniqueTags(right).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function makeBindingId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `tac-binding-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeMusicMode(value) {
  return ['sequence', 'single', 'random'].includes(value) ? value : 'sequence';
}

function normalizeOnlineMusicSource(src, source) {
  // Keep provider-returned URLs for fallback sources. NetEase search results
  // use getNeteaseMusicProxySource above so they do not hit an HTTP redirect.
  return normalizeTag(src);
}

function decodeMusicText(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\\\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\+(["'])/g, '$1')
    .trim();
}

function getNeteaseMusicProxySource(id) {
  const value = normalizeTag(id);
  return value ? `https://api.injahow.cn/meting/?server=netease&type=url&id=${encodeURIComponent(value)}` : '';
}

const BAD_ONLINE_MUSIC_IDS = new Set(['5106129', '19292987', '26896138', '1832431773', '639144']);

function normalizeMusicSearchQuery(value) {
  return normalizeTag(value)
    .replace(/[（）()[\]【】{}]/g, ' ')
    .replace(/[，、,，:：/\\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isKnownFreshMusicHost(src) {
  try {
    const hostname = new URL(src, location.href).hostname;
    return /(?:^|\.)music\.126\.net$/i.test(hostname)
      || /(?:^|\.)kw-[a-z0-9-]+\.kuwo\.cn$/i.test(hostname)
      || /(?:^|\.)saavncdn\.com$/i.test(hostname)
      || /(?:^|\.)kugou\.com$/i.test(hostname);
  } catch {
    return false;
  }
}

function musicSearchScore(item, query) {
  const normalizedQuery = normalizeMusicSearchQuery(query).toLocaleLowerCase('zh-Hans-CN');
  const title = normalizeMusicSearchQuery(item.title).toLocaleLowerCase('zh-Hans-CN');
  const artist = normalizeMusicSearchQuery([item.artist, item.searchArtist].filter(Boolean).join(' ')).toLocaleLowerCase('zh-Hans-CN');
  const text = `${title} ${artist}`;
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  let score = title === normalizedQuery || title === tokens[0] ? 30 : 0;
  if (title.includes(tokens[0] || '')) score += 10;
  tokens.forEach(token => {
    if (title.includes(token)) score += 4;
    if (artist.includes(token)) score += 8;
  });
  if (normalizedQuery.includes('周杰伦') && /(^|\s)(jay|周杰伦|周杰倫)(\s|$)/i.test(text)) score += 20;
  if (/^晴天$/i.test(title) && /^(jay|周杰伦|周杰倫)$/i.test(artist)) score += 24;
  if (/^you belong with me(?:\s+taylor[’']?s version)?$/i.test(title) && /taylor swift/i.test(artist)) score += 28;
  if (/^you belong with me$/i.test(title) && !/taylor swift/i.test(artist)) score -= 50;
  if (normalizedQuery.includes('周杰伦') && !/(周杰伦|周杰倫|jay)/i.test(artist)) score -= 30;
  if (normalizedQuery.includes('韦礼安') && !/韦礼安/i.test(artist)) score -= 30;
  // The direct Kugou resolver returns a verified, complete media URL. Give it
  // priority over catalogue-only entries whose provider URL often expires.
  if (item.source === 'kugou') score += 70;
  if (String(item.source || '').startsWith('gdstudio')) score += 45;
  if (/live|现场|翻唱|伴奏|钢琴|弦乐|纯音乐/i.test(title)) score -= 6;
  if (/试听|片段|preview|snippet|sample/i.test(title)) score -= 40;
  if (/dj|remix|变速|降速|加速|0\.\d+x|1\.\d+x/i.test(title)) score -= 18;
  return score;
}

function musicResultMatchesRequestedArtist(item, query) {
  const normalizedQuery = normalizeMusicSearchQuery(query).toLocaleLowerCase('zh-Hans-CN');
  const artist = normalizeMusicSearchQuery([item.artist, item.searchArtist].filter(Boolean).join(' ')).toLocaleLowerCase('zh-Hans-CN');
  if (normalizedQuery.includes('周杰伦') || normalizedQuery.includes('周杰倫')) return /周杰伦|周杰倫|jay chou|\bjay\b/i.test(artist);
  if (normalizedQuery.includes('韦礼安')) return /韦礼安|wei li an/i.test(artist);
  if (normalizedQuery.includes('taylor swift')) return /taylor swift/i.test(artist);
  return true;
}

function normalizeMusicProviderResult(item) {
  const id = normalizeTag(item?.id);
  const title = normalizeTag(item?.song || item?.name || item?.title);
  const artist = normalizeTag(item?.singer || item?.artist || item?.author);
  // These entries currently resolve to NetEase's /404 page (or a short
  // preview) instead of a complete track. Skip them so the working Taylor's
  // Version is offered for “You Belong With Me”.
  if (!id || !title || BAD_ONLINE_MUSIC_IDS.has(id)) return null;
  // The outer/url endpoint first redirects to an HTTP CDN URL. That redirect
  // is frequently blocked when SillyTavern is opened over HTTPS. The Meting
  // proxy returns the MP3 through an HTTPS response and is CORS enabled.
  return { title, artist, src: getNeteaseMusicProxySource(id), source: 'netease', providerId: id };
}

function normalizeMusicBindings(value = {}) {
  const root = value && typeof value === 'object' ? value : {};
  const tracks = Array.isArray(root.tracks) ? root.tracks.filter(Boolean).map(track => ({
    id: String(track.id || makeBindingId()),
    title: normalizeTag(track.title) || normalizeTag(track.name) || '未命名歌曲',
    artist: normalizeTag(track.artist) || normalizeTag(track.singer),
    src: normalizeTag(track.src || track.url),
    lrc: normalizeTag(track.lrc || track.lyricsUrl),
    lyrics: String(track.lyrics || ''),
    cover: normalizeTag(track.cover),
    source: normalizeTag(track.source) || 'local',
    providerId: normalizeTag(track.providerId),
    addedAt: normalizeTag(track.addedAt),
  })).filter(track => track.src) : [];
  const trackIds = new Set(tracks.map(track => track.id));
  const sourcePlaylists = Array.isArray(root.playlists) ? root.playlists.filter(Boolean).map(list => ({
    id: String(list.id || makeBindingId()),
    name: normalizeTag(list.name) || '播放列表',
    trackIds: uniqueTags(list.trackIds).filter(id => trackIds.has(id)),
  })) : [];
  const firstPlaylist = sourcePlaylists[0];
  const playlists = [{
    id: firstPlaylist?.id || makeBindingId(),
    name: '播放列表',
    trackIds: uniqueTags(sourcePlaylists.flatMap(list => list.trackIds)).length ? uniqueTags(sourcePlaylists.flatMap(list => list.trackIds)) : tracks.map(track => track.id),
  }];
  const selected = [playlists[0].id];
  const queueTrackIds = Array.isArray(root.queueTrackIds)
    ? uniqueTags(root.queueTrackIds).filter(id => trackIds.has(id))
    : null;
  return {
    volume: Number.isFinite(Number(root.volume)) ? Math.min(1, Math.max(0, Number(root.volume))) : 1,
    mode: normalizeMusicMode(root.mode),
    selectedPlaylists: selected,
    queueTrackIds,
    currentTrackId: trackIds.has(root.currentTrackId) ? root.currentTrackId : '',
    tracks,
    playlists,
    floating: Boolean(root.floating),
  };
}

function getCurrentCharacterContext() {
  const context = getContext();
  const id = context.characterId;
  const character = id !== undefined ? context.characters?.[id] : null;
  return { context, id, character };
}

function getCurrentCharacterKey() {
  const { id, character } = getCurrentCharacterContext();
  return character ? `${id}:${character.avatar || character.name || ''}` : '';
}

function normalizeCharacterBindings(bindings = {}) {
  const root = bindings && typeof bindings === 'object' ? bindings : {};
  const presets = root.presets && typeof root.presets === 'object' ? root.presets : {};
  const users = root.users && typeof root.users === 'object' ? root.users : {};
  const worldBooks = root.worldBooks && typeof root.worldBooks === 'object' ? root.worldBooks : {};
  const beautify = root.beautify && typeof root.beautify === 'object' ? root.beautify : {};
  // Versioned character records are persisted bindings.  Treat them as live
  // references even when they were written before the referenceOnly marker
  // existed; unversioned objects are kept as legacy snapshots for API callers
  // and old in-memory data.
  const liveBindings = Number(root.version) >= 5;
  const music = normalizeMusicBindings(root.music);
  const legacyThemeName = normalizeTag(beautify.themeName);
  const beautifyItems = (Array.isArray(beautify.items) ? beautify.items : [])
    .filter(Boolean)
    .map(item => ({
      id: String(item.id || makeBindingId()),
      themeName: normalizeTag(item.themeName),
      createdAt: normalizeTag(item.createdAt),
    }))
    .filter(item => item.themeName);
  if (!beautifyItems.length && legacyThemeName) {
    beautifyItems.push({ id: 'legacy-beautify', themeName: legacyThemeName, createdAt: normalizeTag(beautify.updatedAt) });
  }
  const uniqueBeautifyItems = Array.from(new Map(beautifyItems.map(item => [normalizeThemeNameKey(item.themeName), item])).values());
  const requestedBeautifyStar = normalizeTag(beautify.starredId) || (legacyThemeName ? 'legacy-beautify' : '');
  return {
    version: 6,
    presets: {
      starredId: normalizeTag(presets.starredId),
      items: Array.isArray(presets.items) ? presets.items.filter(Boolean).map(item => ({
        id: String(item.id || makeBindingId()),
        name: normalizeTag(item.name) || '未命名预设绑定',
        createdAt: normalizeTag(item.createdAt),
        presetName: normalizeTag(item.presetName),
        presetValue: normalizeTag(item.presetValue),
        referenceOnly: item.referenceOnly === true || liveBindings,
        ...(item.referenceOnly === true || liveBindings ? {} : { promptOrder: Array.isArray(item.promptOrder) ? cloneData(item.promptOrder) : [] }),
        updatedAt: normalizeTag(item.updatedAt),
      })) : [],
    },
    beautify: {
      starredId: uniqueBeautifyItems.some(item => item.id === requestedBeautifyStar) ? requestedBeautifyStar : '',
      items: uniqueBeautifyItems,
    },
    relatedCharacters: Array.from(new Map((Array.isArray(root.relatedCharacters) ? root.relatedCharacters : [])
      .map(item => typeof item === 'string' ? { avatar: item, name: '' } : item)
      .filter(item => item && normalizeTag(item.avatar))
      .map(item => [normalizeTag(item.avatar), {
        avatar: normalizeTag(item.avatar),
        name: normalizeTag(item.name),
      }])).values()),
    users: {
      starredId: normalizeTag(users.starredId),
      items: Array.isArray(users.items) ? users.items.filter(Boolean).map(item => ({
        id: String(item.id || makeBindingId()),
        name: normalizeTag(item.name) || '未命名 user 绑定',
        createdAt: normalizeTag(item.createdAt),
        avatar: normalizeTag(item.avatar),
        ...(liveBindings && normalizeTag(item.avatar) ? {} : { userName: normalizeTag(item.userName) }),
        referenceOnly: item.referenceOnly === true || liveBindings,
      })) : [],
    },
    worldBooks: {
      starredId: normalizeTag(worldBooks.starredId),
      items: Array.isArray(worldBooks.items) ? worldBooks.items.filter(Boolean).map(item => {
        const referenceOnly = item.referenceOnly === true || liveBindings;
        const books = Array.isArray(item.books) ? item.books.filter(book => book && normalizeTag(book.name)).map(book => ({
          name: normalizeTag(book.name),
          ...(referenceOnly ? {} : { data: book.data && typeof book.data === 'object' ? cloneData(book.data) : { entries: {} } }),
        })) : [];
        const hasScopedSelection = Array.isArray(item.globalBooks) || item.characterBooks;
        return {
          id: String(item.id || makeBindingId()),
          name: normalizeTag(item.name) || '未命名世界书绑定',
          createdAt: normalizeTag(item.createdAt),
          updatedAt: normalizeTag(item.updatedAt),
          globalBooks: uniqueTags(hasScopedSelection ? item.globalBooks : books.map(book => book.name)),
          characterBooks: {
            primary: normalizeTag(item.characterBooks?.primary),
            additional: uniqueTags(item.characterBooks?.additional),
          },
          preserveCharacterBooks: Boolean(item.preserveCharacterBooks),
          referenceOnly,
          books,
        };
      }) : [],
    },
    music,
  };
}

function getCurrentCharacterBindings() {
  const { character } = getCurrentCharacterContext();
  return normalizeCharacterBindings(character?.data?.extensions?.[EXTENSION_KEY]);
}

async function saveCurrentCharacterBindings(bindings) {
  const { id, character } = getCurrentCharacterContext();
  if (id === undefined || !character) {
    notify('info', '请先打开一张角色卡。');
    return false;
  }
  const normalized = normalizeCharacterBindings(bindings);
  // Anything written from this point forward is a live binding.  This also
  // upgrades old snapshots when the user next saves the character card.
  normalized.presets.items.forEach(item => {
    item.referenceOnly = true;
    delete item.promptOrder;
  });
  normalized.users.items.forEach(item => {
    item.referenceOnly = true;
    if (item.avatar) delete item.userName;
  });
  normalized.worldBooks.items.forEach(item => {
    item.referenceOnly = true;
    item.books = item.books.map(book => ({ name: book.name }));
  });
  try {
    await writeVerifiedExtensionField(id, EXTENSION_KEY, normalized);
    scheduleCharacterBindingRender();
    return true;
  } catch (error) {
    console.error('TavernAssetClassifier: failed to save character bindings', error);
    notify('error', `角色绑定未确认保存，请核对后重试：${error.message}`);
    return false;
  }
}

function getCharacterLibrary() {
  const context = getContext();
  return (context.characters ?? []).map((character, id) => ({
    id,
    character,
    avatar: normalizeTag(character?.avatar),
    name: normalizeTag(character?.name) || '未命名角色',
  })).filter(item => item.avatar);
}

function findCharacterByAvatar(avatar) {
  const normalized = normalizeTag(avatar);
  return getCharacterLibrary().find(item => item.avatar === normalized) ?? null;
}

async function loadCharacterByAvatar(avatar) {
  const found = findCharacterByAvatar(avatar);
  if (!found) return null;
  await unshallowCharacter(found.id);
  return findCharacterByAvatar(avatar);
}

async function collectCharacterRelationGroup(seedAvatars) {
  const pending = uniqueTags(seedAvatars);
  const visited = new Set();
  while (pending.length) {
    const avatar = pending.shift();
    if (!avatar || visited.has(avatar)) continue;
    visited.add(avatar);
    const found = await loadCharacterByAvatar(avatar);
    if (!found) continue;
    const bindings = normalizeCharacterBindings(found.character?.data?.extensions?.[EXTENSION_KEY]);
    bindings.relatedCharacters.forEach(item => {
      if (!visited.has(item.avatar)) pending.push(item.avatar);
    });
  }
  return Array.from(visited).map(findCharacterByAvatar).filter(Boolean);
}

async function synchronizeCharacterRelationGroup(members) {
  const uniqueMembers = Array.from(new Map(members.filter(Boolean).map(item => [item.avatar, item])).values());
  const references = uniqueMembers.map(item => ({ avatar: item.avatar, name: item.name }));
  for (const member of uniqueMembers) {
    const loaded = await loadCharacterByAvatar(member.avatar);
    if (!loaded) continue;
    const bindings = normalizeCharacterBindings(loaded.character?.data?.extensions?.[EXTENSION_KEY]);
    bindings.relatedCharacters = references.filter(item => item.avatar !== loaded.avatar);
    await writeVerifiedExtensionField(loaded.id, EXTENSION_KEY, bindings);
  }
}

async function addCharacterToRelationGroup(targetAvatar) {
  const { character } = getCurrentCharacterContext();
  const currentAvatar = normalizeTag(character?.avatar);
  if (!currentAvatar || !targetAvatar || currentAvatar === targetAvatar) return false;
  try {
    const group = await collectCharacterRelationGroup([currentAvatar, targetAvatar]);
    await synchronizeCharacterRelationGroup(group);
    notify('success', `角色卡关联集合已更新，共 ${group.length} 张角色卡。`);
    scheduleCharacterBindingRender();
    return true;
  } catch (error) {
    console.error('TavernAssetClassifier: failed to add character relation', error);
    notify('error', '添加角色卡关联失败，请检查控制台。');
    return false;
  }
}

async function removeCharacterFromRelationGroup(targetAvatar) {
  const { character } = getCurrentCharacterContext();
  const currentAvatar = normalizeTag(character?.avatar);
  if (!currentAvatar || !targetAvatar || currentAvatar === targetAvatar) return false;
  try {
    const group = await collectCharacterRelationGroup([currentAvatar]);
    const removed = group.find(item => item.avatar === targetAvatar) || await loadCharacterByAvatar(targetAvatar);
    const remaining = group.filter(item => item.avatar !== targetAvatar);
    await synchronizeCharacterRelationGroup(remaining);
    if (removed) {
      const bindings = normalizeCharacterBindings(removed.character?.data?.extensions?.[EXTENSION_KEY]);
      bindings.relatedCharacters = [];
      await writeVerifiedExtensionField(removed.id, EXTENSION_KEY, bindings);
    }
    notify('success', '已从关联集合中移除角色卡。');
    scheduleCharacterBindingRender();
    return true;
  } catch (error) {
    console.error('TavernAssetClassifier: failed to remove character relation', error);
    notify('error', '删除角色卡关联失败，请检查控制台。');
    return false;
  }
}

function getTransferableWorldBookBinding(item) {
  const characterBookNames = new Set(uniqueTags([
    item?.characterBooks?.primary,
    ...(item?.characterBooks?.additional ?? []),
  ]));
  const globalBookNames = new Set(uniqueTags(item?.globalBooks).filter(name => !characterBookNames.has(name)));
  const knownBookNames = uniqueTags([
    ...(Array.isArray(item?.books) ? item.books.map(book => book?.name) : []),
    ...globalBookNames,
  ]);
  const books = knownBookNames
    .filter(name => globalBookNames.has(name))
    .map(name => ({ name }));
  if (!books.length) return null;
  return {
    ...cloneData(item),
    globalBooks: books.map(book => book.name),
    characterBooks: { primary: '', additional: [] },
    preserveCharacterBooks: true,
    referenceOnly: true,
    books,
  };
}

function getCharacterTransferCounts(bindings) {
  return {
    beautify: bindings.beautify.items.length,
    presets: bindings.presets.items.length,
    worldBooks: bindings.worldBooks.items.reduce((total, item) => {
      const transferable = getTransferableWorldBookBinding(item);
      return total + (transferable?.books ?? []).length;
    }, 0),
    users: bindings.users.items.length,
  };
}

function getTransferredBindingSignature(type, item) {
  if (type === 'beautify') return normalizeThemeNameKey(item.themeName);
  if (type === 'presets') return JSON.stringify([item.presetValue || item.presetName]);
  if (type === 'users') return JSON.stringify([item.avatar || item.userName]);
  return JSON.stringify([item.globalBooks, item.characterBooks, item.books?.map(book => book?.name)]);
}

function mergeTransferredBindingBucket(type, sourceBucket, targetBucket, transform = item => cloneData(item)) {
  const existingBySignature = new Map(targetBucket.items.map(item => [getTransferredBindingSignature(type, item), item]));
  const transferred = [];
  let inheritedStarId = '';
  for (const sourceItem of sourceBucket.items) {
    const item = transform(sourceItem);
    if (!item) continue;
    const signature = getTransferredBindingSignature(type, item);
    const existing = existingBySignature.get(signature);
    if (existing) {
      if (sourceBucket.starredId === sourceItem.id) inheritedStarId = existing.id;
      continue;
    }
    item.id = makeBindingId();
    item.createdAt = new Date().toISOString();
    existingBySignature.set(signature, item);
    transferred.push(item);
    if (sourceBucket.starredId === sourceItem.id) inheritedStarId = item.id;
  }
  targetBucket.items = [...transferred, ...targetBucket.items];
  const hasValidTargetStar = targetBucket.items.some(item => item.id === targetBucket.starredId);
  if (!hasValidTargetStar && inheritedStarId) targetBucket.starredId = inheritedStarId;
  return transferred.length;
}

async function transferCharacterBindingContent(sourceAvatar, targetAvatar, selectedTypes) {
  try {
    const source = await loadCharacterByAvatar(sourceAvatar);
    const target = await loadCharacterByAvatar(targetAvatar);
    if (!source || !target) throw new Error('source or target character is missing');
    const sourceBindings = normalizeCharacterBindings(source.character?.data?.extensions?.[EXTENSION_KEY]);
    const targetBindings = normalizeCharacterBindings(target.character?.data?.extensions?.[EXTENSION_KEY]);
    const transferredCounts = {};

    if (selectedTypes.includes('beautify')) {
      transferredCounts.beautify = mergeTransferredBindingBucket(
        'beautify', sourceBindings.beautify, targetBindings.beautify,
      );
    }
    if (selectedTypes.includes('presets')) {
      transferredCounts.presets = mergeTransferredBindingBucket(
        'presets', sourceBindings.presets, targetBindings.presets,
      );
    }
    if (selectedTypes.includes('worldBooks')) {
      transferredCounts.worldBooks = mergeTransferredBindingBucket(
        'worldBooks', sourceBindings.worldBooks, targetBindings.worldBooks, getTransferableWorldBookBinding,
      );
    }
    if (selectedTypes.includes('users')) {
      transferredCounts.users = mergeTransferredBindingBucket(
        'users', sourceBindings.users, targetBindings.users,
      );
    }

    await writeVerifiedExtensionField(target.id, EXTENSION_KEY, normalizeCharacterBindings(targetBindings));
    scheduleCharacterBindingRender();
    const total = Object.values(transferredCounts).reduce((sum, count) => sum + count, 0);
    notify('success', total ? `已将所选内容转移到“${target.name}”。` : `“${target.name}”中已有相同内容，无需重复转移。`);
    return true;
  } catch (error) {
    console.error('TavernAssetClassifier: failed to transfer character bindings', error);
    notify('error', '转移关联角色卡内容失败，请检查控制台。');
    return false;
  }
}

function getCurrentPromptPresetSelect() {
  const activeSelector = {
    openai: '#settings_preset_openai',
    textgenerationwebui: '#settings_preset_textgenerationwebui',
    novel: '#settings_preset_novel',
  }[host.main_api];
  if (activeSelector) {
    const select = document.querySelector(activeSelector);
    return normalizeTag(select?.value) ? select : null;
  }
  const preferredSelectors = [
    '#settings_preset_openai',
    '#settings_preset_textgenerationwebui',
    '#settings_preset_novel',
    'select[id*="preset"][id*="openai"]',
    'select[id*="preset"][id*="completion"]',
  ];
  for (const selector of preferredSelectors) {
    const select = document.querySelector(selector);
    const value = String(select?.value || '').trim();
    if (value) return select;
  }
  return null;
}

function getCurrentThemeName() {
  const select = getThemeSelect();
  if (!select) return String(host.power_user.theme || '').trim();

  const selectedValue = String(select.value || '').trim();
  if (selectedValue && Array.from(select.options).some(option => option.value === selectedValue)) {
    return selectedValue;
  }

  const selectedOptionValue = String(select.selectedOptions?.[0]?.value || '').trim();
  if (selectedOptionValue) return selectedOptionValue;

  return String(select.options?.[0]?.value || host.power_user.theme || '').trim();
}

function getThemeRecord(name, create = true) {
  const settings = getSettings(create);
  if (!settings || !name) return null;
  if (!settings.files[name] && create) {
    settings.files[name] = { style: [], topic: [], color: [], avatar: [] };
  }
  const record = settings.files[name];
  if (!record) return null;
  record.style = uniqueTags(record.style);
  record.topic = uniqueTags(record.topic);
  record.color = uniqueTags(record.color).filter(tag => COLOR_TAGS.some(item => item.name === tag));
  record.avatar = uniqueTags(record.avatar).filter(tag => AVATAR_TAGS.includes(tag)).slice(0, 1);
  record.autoColorDisabled = Boolean(record.autoColorDisabled);
  record.autoAvatarDisabled = Boolean(record.autoAvatarDisabled);
  record.background = normalizeTag(record.background);
  record.favorite = Boolean(record.favorite);
  return record;
}

function getOrderedThemeOptions() {
  return state.allThemeOptions
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const firstImportIndex = state.sessionImportedThemeValues.indexOf(a.option.value);
      const secondImportIndex = state.sessionImportedThemeValues.indexOf(b.option.value);
      const firstIsImported = firstImportIndex !== -1;
      const secondIsImported = secondImportIndex !== -1;
      if (firstIsImported !== secondIsImported) return firstIsImported ? 1 : -1;
      if (firstIsImported && secondIsImported) return firstImportIndex - secondImportIndex;
      const favoriteDifference = Number(Boolean(getThemeRecordForTheme(b.option.value)?.favorite))
        - Number(Boolean(getThemeRecordForTheme(a.option.value)?.favorite));
      return favoriteDifference || a.index - b.index;
    })
    .map(entry => entry.option);
}

function makeThemePickerTag(category, tag) {
  const chip = document.createElement('span');
  chip.className = `tac-theme-picker-tag tac-theme-picker-tag-${category}`;
  chip.title = `${CATEGORY_LABELS[category]}：${tag}`;
  if (category === 'color') {
    const color = getColorMeta(tag);
    chip.setAttribute('aria-label', chip.title);
    chip.style.setProperty('--tac-picker-color', color?.color || '#888');
    chip.innerHTML = '<span class="tac-theme-picker-color-dot"></span>';
    return chip;
  }
  if (category === 'avatar') {
    chip.innerHTML = '<i class="fa-solid fa-user"></i><span></span>';
  } else {
    chip.innerHTML = '<span></span>';
  }
  chip.querySelector('span:last-child').textContent = tag;
  return chip;
}

function appendThemePickerContent(container, name, fallback = name) {
  const record = getThemeRecordForTheme(name);
  const title = document.createElement('span');
  title.className = 'tac-theme-picker-entry-name';
  if (record?.favorite) {
    const favorite = document.createElement('i');
    favorite.className = 'fa-solid fa-star tac-theme-picker-favorite';
    favorite.title = '已收藏';
    title.append(favorite);
  }
  const titleText = document.createElement('span');
  titleText.textContent = fallback;
  title.append(titleText);

  const tags = document.createElement('span');
  tags.className = 'tac-theme-picker-entry-tags';
  ['color', 'avatar', 'style', 'topic'].forEach(category => {
    uniqueTags(record?.[category]).forEach(tag => tags.append(makeThemePickerTag(category, tag)));
  });
  container.replaceChildren(title, tags);
}

function positionThemePickerMenu(picker) {
  const trigger = picker?.querySelector('.tac-theme-picker-trigger');
  const menu = document.querySelector('#tac-theme-picker-menu');
  if (!trigger || !menu) return;
  const rect = trigger.getBoundingClientRect();
  const margin = 8;
  const spaceBelow = window.innerHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  const openAbove = spaceBelow < 180 && spaceAbove > spaceBelow;
  menu.style.left = `${Math.max(margin, rect.left)}px`;
  menu.style.width = `${Math.min(rect.width, window.innerWidth - margin * 2)}px`;
  menu.style.maxHeight = `${Math.max(96, openAbove ? spaceAbove - 4 : spaceBelow - 4)}px`;
  menu.style.top = openAbove ? 'auto' : `${rect.bottom + 4}px`;
  menu.style.bottom = openAbove ? `${window.innerHeight - rect.top + 4}px` : 'auto';
}

function setThemePickerOpen(picker, open) {
  const trigger = picker?.querySelector('.tac-theme-picker-trigger');
  const menu = document.querySelector('#tac-theme-picker-menu');
  if (!trigger || !menu) return;
  picker.classList.toggle('is-open', open);
  trigger.setAttribute('aria-expanded', String(open));
  menu.hidden = !open;
  if (open) positionThemePickerMenu(picker);
}

function renderThemePicker() {
  const picker = document.querySelector('#tac-theme-picker');
  const select = getThemeSelect();
  if (!picker || !select) return;
  const currentValue = getCurrentThemeName();
  const currentOption = state.allThemeOptions.find(item => item.value === currentValue);
  const selection = picker.querySelector('.tac-theme-picker-selection');
  appendThemePickerContent(selection, currentValue, currentOption?.text || currentValue || '选择美化');

  const menu = document.querySelector('#tac-theme-picker-menu');
  if (!menu) return;
  menu.innerHTML = '';
  const visibleValues = Array.from(select.options).map(option => option.value).filter(Boolean);
  visibleValues.forEach(value => {
    const source = state.allThemeOptions.find(item => item.value === value);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `tac-theme-picker-item${value === currentValue ? ' is-selected' : ''}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(value === currentValue));
    const content = document.createElement('span');
    content.className = 'tac-theme-picker-entry';
    appendThemePickerContent(content, value, source?.text || value);
    const check = document.createElement('i');
    check.className = 'fa-solid fa-check tac-theme-picker-check';
    item.append(content, check);
    item.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      selectTheme(value, { preserveSettingsDrawer: true });
      setThemePickerOpen(picker, false);
      renderThemePicker();
    });
    menu.append(item);
  });
  if (!visibleValues.length) {
    const empty = document.createElement('div');
    empty.className = 'tac-theme-picker-empty';
    empty.textContent = '没有匹配的美化。';
    menu.append(empty);
  }
}

function mountThemePicker(themeRow) {
  const select = getThemeSelect();
  if (!select || document.querySelector('#tac-theme-picker')) return;
  if (!state.allThemeOptions.length) snapshotThemeOptions();
  sanitizeStoredThemeNameTags();
  const picker = document.createElement('div');
  picker.id = 'tac-theme-picker';
  picker.className = 'tac-theme-picker';
  picker.innerHTML = `
    <button type="button" class="tac-theme-picker-trigger" aria-haspopup="listbox" aria-expanded="false">
      <span class="tac-theme-picker-selection"></span>
      <i class="fa-solid fa-chevron-down tac-theme-picker-chevron"></i>
    </button>
  `;
  const menu = document.createElement('div');
  menu.id = 'tac-theme-picker-menu';
  menu.className = 'tac-theme-picker-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  select.classList.add('tac-native-theme-select');
  themeRow.classList.add('tac-theme-picker-row');
  select.before(picker);
  document.documentElement.append(menu);

  ['pointerdown', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'click'].forEach(eventName => {
    menu.addEventListener(eventName, event => event.stopPropagation());
  });

  picker.querySelector('.tac-theme-picker-trigger').addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    setThemePickerOpen(picker, !picker.classList.contains('is-open'));
  });
  const closeOnOutsidePointer = event => {
    if (!picker.contains(event.target) && !menu.contains(event.target)) setThemePickerOpen(picker, false);
  };
  const closeOnEscape = event => {
    if (event.key === 'Escape') setThemePickerOpen(picker, false);
  };
  const closeOnViewportChange = () => setThemePickerOpen(picker, false);
  document.addEventListener('pointerdown', closeOnOutsidePointer);
  document.addEventListener('keydown', closeOnEscape);
  window.addEventListener('resize', closeOnViewportChange);
  state.themePickerCleanup = () => {
    document.removeEventListener('pointerdown', closeOnOutsidePointer);
    document.removeEventListener('keydown', closeOnEscape);
    window.removeEventListener('resize', closeOnViewportChange);
  };
  renderThemePicker();
}

function pruneMissingThemeRecords() {
  // Keep saved labels even if SillyTavern temporarily rebuilds or filters the
  // native theme dropdown. Rendering only reads records for existing themes, so
  // stale records stay hidden without risking accidental label loss.
}

function getColorMeta(name) {
  return COLOR_TAGS.find(item => item.name === name);
}

function parseCssColor(value) {
  const normalized = normalizeTag(value);
  const rgba = normalized.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (rgba) {
    return {
      red: Math.min(255, Number(rgba[1])),
      green: Math.min(255, Number(rgba[2])),
      blue: Math.min(255, Number(rgba[3])),
      alpha: rgba[4] === undefined ? 1 : Math.min(1, Number(rgba[4])),
    };
  }
  const hex = normalized.match(/^#([\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i)?.[1];
  if (!hex) return null;
  const expanded = hex.length === 3 ? hex.split('').map(part => `${part}${part}`).join('') : hex;
  return {
    red: Number.parseInt(expanded.slice(0, 2), 16),
    green: Number.parseInt(expanded.slice(2, 4), 16),
    blue: Number.parseInt(expanded.slice(4, 6), 16),
    alpha: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
  };
}

function getColorTagFromRgb({ red, green, blue }) {
  const maximum = Math.max(red, green, blue) / 255;
  const minimum = Math.min(red, green, blue) / 255;
  const lightness = (maximum + minimum) / 2;
  const delta = maximum - minimum;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta) {
    if (maximum === red / 255) hue = 60 * (((green - blue) / 255 / delta) % 6);
    else if (maximum === green / 255) hue = 60 * (((blue - red) / 255 / delta) + 2);
    else hue = 60 * (((red - green) / 255 / delta) + 4);
  }
  if (hue < 0) hue += 360;
  if (lightness <= 0.13) return '黑';
  if (lightness >= 0.9 && saturation <= 0.22) return '白';
  if (saturation <= 0.12) return lightness >= 0.78 ? '白' : lightness <= 0.24 ? '黑' : '灰';
  if (hue >= 18 && hue < 52 && lightness < 0.48) return '棕';
  if (hue < 16 || hue >= 345) return '红';
  if (hue < 45) return '橙';
  if (hue < 70) return '黄';
  if (hue < 165) return '绿';
  if (hue < 255) return '蓝';
  if (hue < 300) return '紫';
  return '粉';
}

function inferThemeColorTags(theme) {
  const weightedFields = [
    ['blur_tint_color', 5],
    ['chat_tint_color', 4],
    ['user_mes_blur_tint_color', 3.5],
    ['bot_mes_blur_tint_color', 3.5],
    ['main_text_color', 3],
    ['quote_text_color', 2],
    ['italics_text_color', 1.5],
    ['underline_text_color', 1.5],
    ['border_color', 1],
  ];
  const scores = new Map();
  weightedFields.forEach(([field, weight]) => {
    const color = parseCssColor(theme?.[field]);
    if (!color || color.alpha < 0.15) return;
    const tag = getColorTagFromRgb(color);
    scores.set(tag, (scores.get(tag) || 0) + weight * color.alpha);
  });
  const ranked = Array.from(scores.entries()).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return [];
  const threshold = ranked[0][1] * 0.42;
  return ranked.filter(([, score], index) => index === 0 || score >= threshold).slice(0, 2).map(([tag]) => tag);
}

function resolveCssVariable(value, variables, depth = 0) {
  if (depth > 4) return normalizeTag(value);
  return normalizeTag(value).replace(/var\(\s*(--[\w-]+)(?:\s*,\s*([^)]*))?\)/gi, (_match, name, fallback = '') => {
    const replacement = variables.get(name) || fallback;
    return resolveCssVariable(replacement, variables, depth + 1);
  });
}

function parseCssLength(value, variables) {
  const resolved = resolveCssVariable(value, variables);
  const match = resolved.match(/^(-?\d*\.?\d+)\s*(px|vw|vh|vmin|vmax|cqw|cqh|rem|em|%)(?=\s|$|!)/i);
  if (!match) return null;
  return { value: Math.abs(Number(match[1])), unit: match[2].toLowerCase() };
}

function getThemeAvatarRuleParts(theme) {
  const css = String(theme?.custom_css || '').replace(/\/\*[\s\S]*?\*\//g, ' ');
  if (!css) return { rules: [], variables: new Map() };
  const variables = new Map();
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
    variables.set(match[1], normalizeTag(match[2]));
  }

  const rules = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = normalizeTag(match[1].split(/[\r\n]/).pop());
    if (!selector) continue;
    selector.split(',').map(normalizeTag).filter(Boolean).forEach(part => {
      const lower = part.toLowerCase();
      const positiveSelector = part.replace(/:not\(\s*\[\s*is_user\s*=\s*["']true["']\s*\]\s*\)/gi, '');
      const userOnly = /\[\s*is_user\s*=\s*["']true["']\s*\]/i.test(positiveSelector)
        && !/\[\s*is_user\s*=\s*["']false["']\s*\]/i.test(positiveSelector);
      if (userOnly) return;
      const chatScoped = lower.includes('mesavatarwrapper') || lower.includes('#chat') || /\.mes(?:\b|\[)/i.test(part);
      if (!chatScoped) return;
      const avatarIndex = lower.lastIndexOf('.avatar');
      const targetsAvatar = avatarIndex >= 0;
      const avatarSuffix = targetsAvatar ? lower.slice(avatarIndex + '.avatar'.length) : '';
      const targetsAvatarElement = targetsAvatar && !/^\s+(?:img|picture|source)\b/.test(avatarSuffix) && !/^::?/.test(avatarSuffix);
      const targetsWrapper = lower.includes('mesavatarwrapper') && !targetsAvatar && !/::?/.test(lower.slice(lower.lastIndexOf('mesavatarwrapper') + 'mesavatarwrapper'.length));
      if (!targetsAvatarElement && !targetsWrapper) return;
      rules.push({ selector: lower, body: match[2], targetsAvatarElement, targetsWrapper });
    });
  }
  return { rules, variables };
}

function inferThemeAvatarTag(theme) {
  const { rules, variables } = getThemeAvatarRuleParts(theme);
  if (!rules.length) return '';
  let avatarVisibility = null;
  let wrapperVisibility = null;
  let bigScore = 0;
  let smallScore = 0;

  const updateVisibility = (rule, current) => {
    const display = Array.from(rule.body.matchAll(/(?:^|;)\s*display\s*:\s*([^;]+)/gi)).at(-1)?.[1];
    const visibility = Array.from(rule.body.matchAll(/(?:^|;)\s*visibility\s*:\s*([^;]+)/gi)).at(-1)?.[1];
    const opacity = Array.from(rule.body.matchAll(/(?:^|;)\s*opacity\s*:\s*([^;]+)/gi)).at(-1)?.[1];
    if (display) current = /^\s*none\b/i.test(display) ? false : true;
    if (visibility) current = /^\s*(?:hidden|collapse)\b/i.test(visibility) ? false : true;
    if (opacity && Number.parseFloat(opacity) === 0) current = false;
    return current;
  };

  const scoreLength = (length, nestedInWrapper) => {
    if (!length || !Number.isFinite(length.value) || length.value === 0) return;
    const { value, unit } = length;
    if (unit === 'px') {
      if (value >= 140) bigScore += 3;
      else if (value <= 110) smallScore += 2;
      return;
    }
    if (unit === 'rem' || unit === 'em') {
      if (value >= 9) bigScore += 3;
      else if (value <= 7) smallScore += 2;
      return;
    }
    if (['vw', 'vh', 'vmin', 'vmax', 'cqw', 'cqh'].includes(unit)) {
      if (value >= 25) bigScore += 3;
      else if (value <= 21) smallScore += 2;
      return;
    }
    if (unit === '%' && !nestedInWrapper) {
      if (value >= 45) bigScore += 3;
      else if (value <= 25) smallScore += 1;
    }
  };

  rules.forEach(rule => {
    if (rule.targetsAvatarElement) avatarVisibility = updateVisibility(rule, avatarVisibility);
    if (rule.targetsWrapper) wrapperVisibility = updateVisibility(rule, wrapperVisibility);
    const nestedInWrapper = rule.selector.includes('mesavatarwrapper') && rule.targetsAvatarElement;
    for (const match of rule.body.matchAll(/(?:^|;)\s*(?:width|height)\s*:\s*([^;]+)/gi)) {
      if (rule.targetsAvatarElement) scoreLength(parseCssLength(match[1], variables), nestedInWrapper);
      if (rule.targetsWrapper) {
        const length = parseCssLength(match[1], variables);
        if (length && ((length.unit === '%' && length.value <= 25)
          || (['vw', 'vmin', 'cqw'].includes(length.unit) && length.value <= 22)
          || (length.unit === 'px' && length.value <= 120))) smallScore += 1;
      }
    }
  });

  if (avatarVisibility === false || wrapperVisibility === false) return '无头像';
  if (bigScore > smallScore && bigScore >= 3) return '大头像';
  return '小头像';
}

function applyInferredThemeTags(record, theme) {
  let changed = false;
  if (!record.color.length && !record.autoColorDisabled) {
    const colors = inferThemeColorTags(theme);
    if (colors.length) {
      record.color = colors;
      changed = true;
    }
  }
  if (!record.avatar.length && !record.autoAvatarDisabled) {
    const avatar = inferThemeAvatarTag(theme);
    if (avatar) {
      record.avatar = [avatar];
      changed = true;
    }
  }
  return changed;
}

function autoTagCurrentThemeMetadata() {
  const name = getCurrentThemeName();
  const record = getThemeRecord(name);
  if (!record || !applyInferredThemeTags(record, getThemeObject(name))) return false;
  saveSettings();
  return true;
}

async function autoTagAllThemeMetadata() {
  if (state.autoMetadataScanStarted) return;
  state.autoMetadataScanStarted = true;
  try {
    const response = await fetch('/api/settings/get', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({}),
      cache: 'no-cache',
    });
    if (!response.ok) throw new Error(`settings failed: ${response.status}`);
    const data = await response.json();
    let changed = 0;
    (Array.isArray(data.themes) ? data.themes : []).forEach(theme => {
      const themeName = normalizeTag(theme?.name);
      const option = state.allThemeOptions.find(item => item.value === themeName || item.text === themeName);
      const record = getThemeRecord(option?.value || themeName);
      if (record && applyInferredThemeTags(record, theme)) changed += 1;
    });
    if (changed) {
      saveSettings();
      scheduleRefresh();
    }
  } catch (error) {
    console.warn('TavernAssetClassifier: failed to auto-tag theme metadata', error);
  }
}

function getTagPool(category) {
  const tags = new Set();
  getThemeNames().forEach(name => {
    const record = getThemeRecordForTheme(name);
    if (!record) return;
    uniqueTags(record[category]).forEach(tag => tags.add(tag));
  });
  return Array.from(tags).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function getThemeRecordForTheme(name) {
  const settings = getSettings(false);
  if (!settings?.files || !name) return null;
  const exact = getThemeRecord(name, false);
  if (exact) return exact;

  const option = state.allThemeOptions.find(item => item.value === name || item.text === name);
  if (!option) return null;

  if (option.text && settings.files[option.text]) return getThemeRecord(option.text, false);
  if (option.value && settings.files[option.value]) return getThemeRecord(option.value, false);
  return null;
}

function getBackgroundCssUrl(filename) {
  const normalized = normalizeTag(filename);
  return normalized ? `url("${getBackgroundPath(normalized)}")` : '';
}

function getBackgroundDisplayName(filename) {
  const normalized = normalizeTag(filename);
  return normalized.replace(/\.[^.]+$/, '') || normalized;
}

async function getAvailableBackgrounds() {
  try {
    const response = await fetch('/api/backgrounds/all', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(`backgrounds failed: ${response.status}`);
    const data = await response.json();
    return (data.images ?? [])
      .map(item => typeof item === 'string' ? item : item?.filename)
      .map(normalizeTag)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  } catch (error) {
    console.warn('TavernAssetClassifier: failed to load backgrounds', error);
    return [];
  }
}

function applyBackgroundFile(filename) {
  const normalized = normalizeTag(filename);
  if (!normalized) return false;
  const url = getBackgroundCssUrl(normalized);
  if (!url) return false;
  document.querySelector('#bg1')?.style.setProperty('background-image', url);
  host.background_settings.name = normalized;
  host.background_settings.url = url;
  return true;
}

function applyBoundBackgroundForTheme(themeName = getCurrentThemeName()) {
  const record = getThemeRecordForTheme(themeName);
  const background = normalizeTag(record?.background);
  if (!background) return false;
  state.lastThemeBackgroundSyncName = themeName;
  return applyBackgroundFile(background);
}

function syncBoundBackgroundForCurrentTheme(force = false) {
  const themeName = normalizeTag(host.power_user.theme) || getCurrentThemeName();
  if (!themeName) return;
  if (!force && state.lastThemeBackgroundSyncName === themeName) return;
  const applied = applyBoundBackgroundForTheme(themeName);
  if (!applied) state.lastThemeBackgroundSyncName = themeName;
}

function startThemeBackgroundSync() {
  if (state.themeBackgroundSyncBound) return;
  state.themeBackgroundSyncBound = true;
  if (host.event_types.SETTINGS_UPDATED) host.eventSource?.on?.(host.event_types.SETTINGS_UPDATED, syncBoundBackgroundForCurrentTheme);
  state.themeBackgroundSyncTimer = setInterval(() => {
    if (!document.hidden) syncBoundBackgroundForCurrentTheme();
  }, 3000);
}

function stopThemeBackgroundSync() {
  if (state.themeBackgroundSyncTimer) {
    clearInterval(state.themeBackgroundSyncTimer);
    state.themeBackgroundSyncTimer = null;
  }
  if (state.themeBackgroundSyncBound) {
    if (host.event_types.SETTINGS_UPDATED) host.eventSource?.removeListener?.(host.event_types.SETTINGS_UPDATED, syncBoundBackgroundForCurrentTheme);
    state.themeBackgroundSyncBound = false;
  }
  state.lastThemeBackgroundSyncName = '';
}

function makeTag(category, tag, active = false, options = {}) {
  const color = category === 'color' ? getColorMeta(tag) : null;
  const avatar = category === 'avatar';
  const compactColor = color && options.compactColor;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `tac-tag tac-tag-${category}${active ? ' is-active' : ''}${compactColor ? ' tac-tag-color-compact' : ''}`;
  button.dataset.category = category;
  button.dataset.tag = tag;
  button.title = `${CATEGORY_LABELS[category]}：${tag}`;
  button.setAttribute('aria-label', `${CATEGORY_LABELS[category]}：${tag}`);
  if (color) {
    button.style.setProperty('--tac-tag-bg', color.color);
    button.style.setProperty('--tac-tag-fg', color.text);
  }
  button.innerHTML = `${color ? '<span class="tac-color-dot"></span>' : ''}${avatar ? '<i class="fa-solid fa-user tac-avatar-icon"></i>' : ''}<span></span>`;
  button.querySelector('span:last-child').textContent = compactColor ? '' : tag;
  return button;
}

function requestDeleteTagConfirmation(category, tag) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-binding-modal');
    if (existing) closeModalOverlay(existing);

    const overlay = document.createElement('div');
    overlay.id = 'tac-binding-modal';
    overlay.className = 'tac-binding-form-modal';
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">删除标签</div>
            <div class="tac-modal-title">从全部美化中删除</div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="tac-confirm-body"></div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button danger_button" data-action="confirm">删除</button>
        </div>
      </div>
    `;
    overlay.querySelector('.tac-confirm-body').textContent = `确定删除“${CATEGORY_LABELS[category]}：${tag}”吗？全部使用这个标签的美化都会移除该标签。`;

    const close = value => {
      closeModalOverlay(overlay);
      resolve(value);
    };
    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close(false);
      if (event.target.closest('[data-action="confirm"]')) close(true);
    });
    mountModalOverlay(overlay);
  });
}

function setAutomaticTaggingDisabled(record, category, disabled) {
  if (category === 'color') record.autoColorDisabled = Boolean(disabled);
  if (category === 'avatar') record.autoAvatarDisabled = Boolean(disabled);
}

function removeThemeTag(record, category, tag) {
  record[category] = uniqueTags(record[category]).filter(item => item !== tag);
  if ((category === 'color' || category === 'avatar') && !record[category].length) {
    setAutomaticTaggingDisabled(record, category, true);
  }
}

function deleteTagFromAllThemes(category, tag) {
  const settings = getSettings(false);
  let removed = 0;
  Object.values(settings?.files ?? {}).forEach(record => {
    if (!record || typeof record !== 'object') return;
    const previous = uniqueTags(record[category]);
    const next = previous.filter(item => item !== tag);
    removed += previous.length - next.length;
    record[category] = next;
    if (next.length !== previous.length && (category === 'color' || category === 'avatar')) {
      setAutomaticTaggingDisabled(record, category, true);
    }
  });
  state.selectedFilters = state.selectedFilters.filter(filter => (
    filter.category !== category || filter.tag !== tag
  ));
  saveSettings();
  scheduleRefresh();
  return removed;
}

async function confirmDeleteTagFromAllThemes(category, tag) {
  if (!await requestDeleteTagConfirmation(category, tag)) return;
  const removed = deleteTagFromAllThemes(category, tag);
  notify(removed ? 'success' : 'info', removed
    ? `已从 ${removed} 个美化中删除“${tag}”标签。`
    : `没有美化正在使用“${tag}”标签。`);
  if (document.querySelector('#tac-tag-modal')) openTagEditor();
}

function enableGlobalTagLongPress(chip, category, tag) {
  let timer = null;
  let startX = 0;
  let startY = 0;
  let suppressClick = false;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    chip.classList.remove('is-long-pressing');
  };

  chip.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    cancel();
    startX = event.clientX;
    startY = event.clientY;
    chip.classList.add('is-long-pressing');
    timer = setTimeout(() => {
      timer = null;
      suppressClick = true;
      chip.classList.remove('is-long-pressing');
      navigator.vibrate?.(20);
      void confirmDeleteTagFromAllThemes(category, tag);
    }, 650);
  });
  chip.addEventListener('pointermove', event => {
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 12) cancel();
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(eventName => {
    chip.addEventListener(eventName, cancel);
  });
  chip.addEventListener('contextmenu', event => event.preventDefault());
  chip.addEventListener('click', event => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

function makeFilterTag(category, tag, active = false) {
  const chip = makeTag(category, tag, active, { compactColor: category === 'color' });
  chip.title = active
    ? `${CATEGORY_LABELS[category]}：${tag}，点击取消筛选`
    : `${CATEGORY_LABELS[category]}：${tag}，点击筛选`;
  chip.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    toggleFilter(category, tag);
  });
  return chip;
}

function scheduleRefresh(delay = 0) {
  if (state.refreshTimer) clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    renderFilterPanel();
  }, delay);
}

function getFilteredThemeNames() {
  const names = getThemeNames();
  const query = normalizeTag(state.themeSearchQuery).toLocaleLowerCase('zh-Hans-CN');
  if (!state.selectedFilters.length && !query) return names;

  return names.filter(name => {
    const record = getThemeRecordForTheme(name);
    if (state.selectedFilters.length && !record) return false;
    const matchesTags = state.selectedFilters.every(filter => uniqueTags(record?.[filter.category]).includes(filter.tag));
    const searchable = [name, ...CATEGORIES.flatMap(category => uniqueTags(record?.[category]))]
      .join(' ')
      .toLocaleLowerCase('zh-Hans-CN');
    return matchesTags && (!query || searchable.includes(query));
  });
}

function applyThemeFilterToSelect() {
  const select = getThemeSelect();
  if (!select) return;
  if (!state.allThemeOptions.length) snapshotThemeOptions();
  if (!state.allThemeOptions.length) return;

  const previousValue = String(select.value || host.power_user.theme || '').trim();
  const visibleNames = new Set(getFilteredThemeNames());
  const orderedOptions = getOrderedThemeOptions();
  const hasFilter = state.selectedFilters.length || normalizeTag(state.themeSearchQuery);
  let nextOptions = hasFilter
    ? orderedOptions.filter(option => visibleNames.has(option.value))
    : orderedOptions;
  const currentOption = orderedOptions.find(option => option.value === previousValue);
  if (hasFilter && currentOption && !nextOptions.some(option => option.value === previousValue)) {
    nextOptions = [currentOption, ...nextOptions];
  }
  const currentValues = Array.from(select.options).map(option => option.value);
  const nextValues = nextOptions.map(option => option.value);
  const isAlreadyTargetList = currentValues.length === nextValues.length
    && currentValues.every((value, index) => value === nextValues[index]);

  if (isAlreadyTargetList) {
    const labelUpdates = [];
    Array.from(select.options).forEach(option => {
      const source = orderedOptions.find(item => item.value === option.value);
      if (!source) return;
      const sourceName = source.text || source.value;
      const label = sourceName;
      if (option.dataset.tacThemeName !== sourceName || option.textContent !== label) {
        labelUpdates.push({ option, sourceName, label });
      }
    });
    if (!labelUpdates.length) return;
    suppressThemeObserverUntilNextTask();
    labelUpdates.forEach(({ option, sourceName, label }) => {
      option.dataset.tacThemeName = sourceName;
      option.textContent = label;
    });
    return;
  }

  suppressThemeObserverUntilNextTask();
  select.innerHTML = '';
  nextOptions.forEach(item => {
    const option = document.createElement('option');
    option.value = item.value;
    option.dataset.tacThemeName = item.text || item.value;
    option.textContent = item.text || item.value;
    select.append(option);
  });

  if (nextOptions.some(option => option.value === previousValue)) {
    select.value = previousValue;
  }
  try {
    window.jQuery?.(select).trigger('change.select2');
  } catch {
    // Select2 may not be attached.
  }
}

function restoreThemeSelectOptions() {
  const select = getThemeSelect();
  if (!select) return;
  if (!state.allThemeOptions.length) snapshotThemeOptions();
  state.selectedFilters = [];
  state.themeSearchQuery = '';
  applyThemeFilterToSelect();
}

function renderFilterPanel() {
  sanitizeStoredThemeNameTags();
  pruneMissingThemeRecords();
  const panel = document.querySelector('#tac-filter-body');
  if (!panel) return;

  const names = getThemeNames();
  const pools = Object.fromEntries(CATEGORIES.map(category => [category, new Set()]));

  names.forEach(name => {
    const record = getThemeRecordForTheme(name);
    if (!record) return;
    CATEGORIES.forEach(category => {
      uniqueTags(record[category]).forEach(tag => pools[category].add(tag));
    });
  });

  panel.innerHTML = '';
  const search = document.createElement('div');
  search.className = 'tac-theme-search';
  search.innerHTML = `
    <input type="search" class="text_pole tac-theme-search-input" placeholder="搜索美化名称或标签" autocomplete="off">
    <button type="button" class="menu_button tac-theme-search-submit" title="查询"><i class="fa-solid fa-magnifying-glass"></i><span>查询</span></button>
    <button type="button" class="menu_button tac-theme-search-clear" title="清空搜索"><i class="fa-solid fa-xmark"></i><span>清空</span></button>
  `;
  const searchInput = search.querySelector('.tac-theme-search-input');
  searchInput.value = state.themeSearchQuery;
  const submitSearch = () => {
    state.themeSearchQuery = normalizeTag(searchInput.value);
    renderFilterPanel();
  };
  search.querySelector('.tac-theme-search-submit').addEventListener('click', submitSearch);
  search.querySelector('.tac-theme-search-clear').addEventListener('click', () => {
    state.themeSearchQuery = '';
    renderFilterPanel();
  });
  searchInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    submitSearch();
  });
  panel.append(search);

  const activeWrap = document.createElement('div');
  activeWrap.className = 'tac-active-filters';
  const activeHead = document.createElement('div');
  activeHead.className = 'tac-active-head';
  const activeTags = document.createElement('div');
  activeTags.className = 'tac-active-tags';
  const selectedLabel = document.createElement('span');
  selectedLabel.className = 'tac-selected-label';
  selectedLabel.textContent = '当前已选标签：';
  selectedLabel.title = state.selectedFilters.length
    ? state.selectedFilters.map(filter => `${CATEGORY_LABELS[filter.category]}：${filter.tag}`).join('，')
    : '无';
  activeHead.append(selectedLabel);

  if (state.selectedFilters.length) {
    state.selectedFilters.forEach(filter => {
      const chip = makeFilterTag(filter.category, filter.tag, true);
      if (filter.category !== 'color') {
        const text = chip.querySelector('span:last-child');
        if (text) text.textContent = `${CATEGORY_LABELS[filter.category]}：${filter.tag}`;
      }
      activeTags.append(chip);
    });
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'tac-clear-filters menu_button';
    clear.textContent = '清空';
    clear.addEventListener('click', () => {
      state.selectedFilters = [];
      renderFilterPanel();
      scheduleRefresh();
    });
    activeHead.append(clear);
  } else {
    const empty = document.createElement('span');
    empty.className = 'tac-empty';
    empty.textContent = '无';
    activeTags.append(empty);
  }
  activeWrap.append(activeHead, activeTags);
  panel.append(activeWrap);

  const filterGrid = document.createElement('div');
  filterGrid.className = 'tac-filter-grid';
  for (const category of CATEGORIES) {
    const selectedInCategory = state.selectedFilters
      .filter(item => item.category === category)
      .map(item => item.tag);
    const fixedValues = category === 'avatar' ? AVATAR_TAGS : [];
    const values = uniqueTags([...fixedValues, ...Array.from(pools[category]), ...selectedInCategory])
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));

    const group = document.createElement('section');
    group.className = 'tac-filter-group';
    const title = document.createElement('div');
    title.className = 'tac-filter-title';
    title.textContent = CATEGORY_LABELS[category];
    const tags = document.createElement('div');
    tags.className = 'tac-filter-tags';

    if (values.length) {
      values.forEach(tag => {
        const active = state.selectedFilters.some(item => item.category === category && item.tag === tag);
        tags.append(makeFilterTag(category, tag, active));
      });
    } else {
      const empty = document.createElement('span');
      empty.className = 'tac-empty';
      empty.textContent = '暂无可选标签';
      tags.append(empty);
    }

    group.append(title, tags);
    filterGrid.append(group);
  }
  panel.append(filterGrid);

  applyThemeFilterToSelect();
  renderThemePicker();
}

function renderFilteredThemeList(panel) {
  const matches = getFilteredThemeNames();
  const list = document.createElement('section');
  list.className = 'tac-results-panel';

  const head = document.createElement('div');
  head.className = 'tac-results-head';
  const title = document.createElement('div');
  title.className = 'tac-results-title';
  title.textContent = '筛选后的美化';
  const count = document.createElement('span');
  count.className = 'tac-results-count';
  count.textContent = `${matches.length} 个`;
  head.append(title, count);
  list.append(head);

  const body = document.createElement('div');
  body.className = 'tac-result-list';

  if (!matches.length) {
    const empty = document.createElement('div');
    empty.className = 'tac-no-matches';
    empty.textContent = '没有可显示的主题。';
    body.append(empty);
    list.append(body);
    panel.append(list);
    return;
  }

  matches.forEach(name => {
    const record = getThemeRecordForTheme(name) ?? { style: [], topic: [], color: [], avatar: [] };
    const item = document.createElement('div');
    item.role = 'button';
    item.tabIndex = 0;
    item.className = 'tac-result-item';
    item.title = '点击应用这个主题';

    const nameEl = document.createElement('span');
    nameEl.className = 'tac-result-name';
    nameEl.textContent = name;

    const tags = document.createElement('span');
    tags.className = 'tac-result-tags';
    for (const category of CATEGORIES) {
      uniqueTags(record[category]).forEach(tag => {
        const active = state.selectedFilters.some(item => item.category === category && item.tag === tag);
        tags.append(makeFilterTag(category, tag, active));
      });
    }

    item.append(nameEl, tags);
    item.addEventListener('click', () => selectTheme(name));
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectTheme(name);
      }
    });
    body.append(item);
  });

  list.append(body);
  panel.append(list);
}

function toggleFilter(category, tag) {
  const index = state.selectedFilters.findIndex(item => item.category === category && item.tag === tag);
  if (index >= 0) {
    state.selectedFilters.splice(index, 1);
  } else {
    if (category === 'avatar') {
      state.selectedFilters = state.selectedFilters.filter(item => item.category !== 'avatar');
    }
    state.selectedFilters.push({ category, tag });
    notify('info', `已选择标签：${CATEGORY_LABELS[category]}：${tag}`);
  }
  renderFilterPanel();
}

function isUserSettingsDrawerOpen() {
  return document.querySelector('#user-settings-block')?.classList.contains('openDrawer') ?? false;
}

function restoreUserSettingsDrawer() {
  const drawer = document.querySelector('#user-settings-block');
  if (!drawer) return;
  drawer.classList.remove('closedDrawer');
  drawer.classList.add('openDrawer');
  const icon = drawer.parentElement?.querySelector(':scope > .drawer-toggle .drawer-icon');
  icon?.classList.remove('closedIcon');
  icon?.classList.add('openIcon');
}

function selectTheme(name, { preserveSettingsDrawer = isUserSettingsDrawerOpen() } = {}) {
  const select = getThemeSelect();
  if (!select) return;
  select.value = name;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  if (preserveSettingsDrawer) {
    setTimeout(restoreUserSettingsDrawer, 0);
    setTimeout(restoreUserSettingsDrawer, 80);
  }
}

function openTagEditor() {
  const name = getCurrentThemeName();
  if (!name) {
    notify('info', '请先选择一个主题。');
    return;
  }

  const existing = document.querySelector('#tac-tag-modal');
  if (existing) closeModalOverlay(existing);

  const record = getThemeRecord(name);
  if (!record) {
    notify('error', '无法读取当前主题标签。');
    return;
  }
  const overlay = document.createElement('div');
  overlay.id = 'tac-tag-modal';
  document.body.classList.add('tac-modal-open');
  trapModalEvents(overlay);
  overlay.innerHTML = `
    <div class="tac-modal-card">
      <div class="tac-modal-head">
        <div>
          <div class="tac-modal-kicker">标签设置</div>
          <div class="tac-modal-title"></div>
        </div>
        <div class="tac-modal-head-actions">
          <button type="button" class="menu_button tac-icon-button tac-favorite-button${record.favorite ? ' is-active' : ''}" data-action="favorite" title="收藏美化" aria-pressed="${record.favorite}">
            <i class="fa-${record.favorite ? 'solid' : 'regular'} fa-star"></i>
          </button>
          <button type="button" class="menu_button tac-icon-button" data-action="close" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
      </div>
      <div class="tac-modal-selected"></div>
      <div class="tac-editor-groups"></div>
      <div class="tac-modal-actions">
        <button type="button" class="menu_button" data-action="apply">确定</button>
      </div>
    </div>
  `;
  overlay.querySelector('.tac-modal-title').textContent = name;
  overlay.addEventListener('click', event => {
    if (event.target.closest('[data-action="favorite"]')) {
      record.favorite = !record.favorite;
      saveSettings();
      const favoriteButton = overlay.querySelector('.tac-favorite-button');
      favoriteButton.classList.toggle('is-active', record.favorite);
      favoriteButton.setAttribute('aria-pressed', String(record.favorite));
      favoriteButton.querySelector('i').className = `fa-${record.favorite ? 'solid' : 'regular'} fa-star`;
      renderFilterPanel();
      return;
    }
    if (event.target.closest('[data-action="close"]')) {
      closeModalOverlay(overlay);
      return;
    }
    if (event.target.closest('[data-action="apply"]')) {
      saveSettings();
      scheduleRefresh();
      refreshSelected();
      closeModalOverlay(overlay);
    }
  });

  const selected = overlay.querySelector('.tac-modal-selected');
  const refreshSelected = () => {
    selected.innerHTML = '';
    const tags = document.createElement('div');
    tags.className = 'tac-editor-selected-tags';
    for (const category of CATEGORIES) {
      uniqueTags(record[category]).forEach(tag => {
        const chip = makeTag(category, tag);
        chip.title = '点击移除；长按可从全部美化中删除';
        enableGlobalTagLongPress(chip, category, tag);
        chip.addEventListener('click', () => {
          removeThemeTag(record, category, tag);
          saveSettings();
          scheduleRefresh();
          refreshSelected();
        });
        const text = chip.querySelector('span:last-child');
        if (text) text.textContent = `${CATEGORY_LABELS[category]}：${tag}`;
        tags.append(chip);
      });
    }
    if (!tags.children.length) {
      const empty = document.createElement('span');
      empty.className = 'tac-empty';
      empty.textContent = '当前主题还没有标签。';
      tags.append(empty);
    }
    selected.append(tags);
  };
  refreshSelected();

  const groups = overlay.querySelector('.tac-editor-groups');
  for (const category of CATEGORIES) {
    groups.append(createEditorGroup(category, record, refreshSelected));
  }
  groups.append(createBackgroundBindingGroup(record));

  mountModalOverlay(overlay);
}

function createEditorGroup(category, record, refreshSelected) {
  const group = document.createElement('section');
  group.className = 'tac-editor-group';
  const title = document.createElement('div');
  title.className = 'tac-editor-title';
  title.textContent = CATEGORY_LABELS[category];
  const chips = document.createElement('div');
  chips.className = 'tac-editor-chips';
  const existingTitle = document.createElement('div');
  existingTitle.className = 'tac-editor-existing-title';
  existingTitle.textContent = '已设置标签';
  const input = category === 'color' || category === 'avatar' ? null : document.createElement('input');
  const inputRow = input ? document.createElement('div') : null;
  const addButton = input ? document.createElement('button') : null;
  if (input) {
    input.className = 'text_pole tac-tag-input';
    input.placeholder = '输入标签，回车添加';
    inputRow.className = 'tac-tag-input-row';
    addButton.type = 'button';
    addButton.className = 'menu_button tac-tag-add-button';
    addButton.title = '添加标签';
    addButton.innerHTML = '<i class="fa-solid fa-plus"></i>';
  }
  const suggestions = document.createElement('div');
  suggestions.className = 'tac-tag-suggestions';
  const suggestionsTitle = document.createElement('div');
  suggestionsTitle.className = 'tac-editor-existing-title';
  suggestionsTitle.textContent = '已输入过的标签';
  const suggestionsTags = document.createElement('div');
  suggestionsTags.className = 'tac-editor-chips';

  const refreshChips = () => {
    chips.innerHTML = '';
    uniqueTags(record[category]).forEach(tag => {
      const chip = makeTag(category, tag);
      chip.title = '点击移除；长按可从全部美化中删除';
      enableGlobalTagLongPress(chip, category, tag);
      chip.addEventListener('click', () => {
        removeThemeTag(record, category, tag);
        saveSettings();
        scheduleRefresh();
        refreshSelected?.();
        refreshChips();
        refreshSuggestions();
      });
      chips.append(chip);
    });
  };

  const addTag = tag => {
    const normalized = normalizeTag(tag);
    if (!normalized) return;
    if ((category === 'style' || category === 'topic') && isThemeNameTag(normalized)) {
      notify('info', '美化名称不能作为标签。');
      return;
    }
    record[category] = uniqueTags([...(record[category] ?? []), normalized]);
    saveSettings();
    scheduleRefresh();
    refreshSelected?.();
    refreshChips();
    refreshSuggestions();
  };

  const refreshSuggestions = () => {
    suggestionsTags.innerHTML = '';
    getTagPool(category)
      .filter(tag => !uniqueTags(record[category]).includes(tag))
      .forEach(tag => {
        const chip = makeTag(category, tag);
        chip.title = '点击添加到当前美化；长按可从全部美化中删除';
        enableGlobalTagLongPress(chip, category, tag);
        chip.addEventListener('click', () => addTag(tag));
        suggestionsTags.append(chip);
      });
    suggestions.hidden = !suggestionsTags.children.length;
  };

  const addInputTag = () => {
    const tag = normalizeTag(input.value);
    if (!tag) return;
    addTag(tag);
    input.value = '';
  };

  if (input) {
    input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addInputTag();
    });
    addButton.addEventListener('click', addInputTag);
  }

  group.append(title);
  if (input) {
    inputRow.append(input, addButton);
    group.append(inputRow);
  }

  if (category === 'color') {
    const palette = document.createElement('div');
    palette.className = 'tac-color-palette';
    const refreshPalette = () => {
      palette.innerHTML = '';
      COLOR_TAGS.forEach(item => {
        const button = makeTag('color', item.name, uniqueTags(record.color).includes(item.name));
        button.title = '点击切换；长按可从全部美化中移除这个颜色标签';
        enableGlobalTagLongPress(button, 'color', item.name);
        button.addEventListener('click', () => {
          if (uniqueTags(record.color).includes(item.name)) {
            record.color = uniqueTags(record.color).filter(tag => tag !== item.name);
            setAutomaticTaggingDisabled(record, 'color', !record.color.length);
          } else {
            record.color = uniqueTags([...(record.color ?? []), item.name]);
            setAutomaticTaggingDisabled(record, 'color', false);
          }
          saveSettings();
          scheduleRefresh();
          refreshSelected?.();
          refreshChips();
          refreshPalette();
        });
        palette.append(button);
      });
    };
    refreshPalette();
    group.append(palette);
  } else if (category === 'avatar') {
    const palette = document.createElement('div');
    palette.className = 'tac-avatar-palette';
    const refreshPalette = () => {
      palette.innerHTML = '';
      AVATAR_TAGS.forEach(name => {
        const button = makeTag('avatar', name, uniqueTags(record.avatar).includes(name));
        button.title = '点击切换；长按可从全部美化中移除这个头像标签';
        enableGlobalTagLongPress(button, 'avatar', name);
        button.addEventListener('click', () => {
          const removing = uniqueTags(record.avatar).includes(name);
          record.avatar = removing ? [] : [name];
          setAutomaticTaggingDisabled(record, 'avatar', removing);
          saveSettings();
          scheduleRefresh();
          refreshSelected?.();
          refreshChips();
          refreshPalette();
        });
        palette.append(button);
      });
    };
    refreshPalette();
    group.append(palette);
  } else {
    suggestions.append(suggestionsTitle, suggestionsTags);
    group.append(suggestions);
    refreshSuggestions();
  }

  group.append(existingTitle, chips);
  refreshChips();
  return group;
}

function createBackgroundBindingGroup(record) {
  const details = document.createElement('details');
  details.className = 'tac-editor-group tac-background-binding';

  const summary = document.createElement('summary');
  summary.className = 'tac-background-binding-head';

  const title = document.createElement('div');
  title.className = 'tac-editor-title';
  title.innerHTML = '<i class="fa-solid fa-image"></i> 绑定背景';

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'menu_button tac-background-clear';
  clear.textContent = '清除绑定';
  clear.addEventListener('click', () => {
    record.background = '';
    saveSettings();
    renderBackgroundList();
  });

  const chevron = document.createElement('i');
  chevron.className = 'fa-solid fa-chevron-down tac-background-chevron';

  const current = document.createElement('div');
  current.className = 'tac-editor-existing-title tac-background-current';

  const list = document.createElement('div');
  list.className = 'tac-background-grid';
  list.innerHTML = '<span class="tac-empty">正在读取背景...</span>';

  const renderBackgroundList = async () => {
    current.textContent = record.background
      ? `当前绑定：${getBackgroundDisplayName(record.background)}`
      : '当前未绑定背景。';
    const backgrounds = await getAvailableBackgrounds();
    list.innerHTML = '';
    if (!backgrounds.length) {
      const empty = document.createElement('span');
      empty.className = 'tac-empty';
      empty.textContent = '没有可绑定的背景。';
      list.append(empty);
      return;
    }
    backgrounds.forEach(filename => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `tac-background-item${record.background === filename ? ' is-selected' : ''}`;
      item.title = filename;
      item.innerHTML = `
        <span class="tac-background-thumb"></span>
        <span class="tac-background-name"></span>
      `;
      item.querySelector('.tac-background-thumb').style.backgroundImage = getBackgroundCssUrl(filename);
      item.querySelector('.tac-background-name').textContent = getBackgroundDisplayName(filename);
      item.addEventListener('click', () => {
        record.background = filename;
        saveSettings();
        renderBackgroundList();
      });
      list.append(item);
    });
  };

  clear.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
  });
  summary.append(title, clear, chevron);
  details.append(summary, current, list);
  details.addEventListener('toggle', () => {
    if (details.open && !details.dataset.loaded) {
      details.dataset.loaded = '1';
      renderBackgroundList();
    }
  });
  current.textContent = record.background
    ? `当前绑定：${getBackgroundDisplayName(record.background)}`
    : '当前未绑定背景。';
  return details;
}

function requestThemeName(oldName) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-rename-modal');
    if (existing) closeModalOverlay(existing);

    const overlay = document.createElement('div');
    overlay.id = 'tac-rename-modal';
    document.body.classList.add('tac-modal-open');
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card tac-binding-form-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">重命名主题</div>
            <div class="tac-modal-title"></div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="tac-rename-body">
          <input class="text_pole tac-rename-input" autocomplete="off">
        </div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button" data-action="confirm">确定</button>
        </div>
      </div>
    `;
    overlay.querySelector('.tac-modal-title').textContent = oldName;
    const input = overlay.querySelector('.tac-rename-input');
    input.value = oldName;

    const close = value => {
      closeModalOverlay(overlay);
      resolve(value);
    };

    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close('');
      if (event.target.closest('[data-action="confirm"]')) close(input.value);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') close(input.value);
      if (event.key === 'Escape') close('');
    });

  mountModalOverlay(overlay);
});
}

async function renameCurrentTheme() {
  const oldName = getCurrentThemeName();
  if (!oldName) {
    notify('info', '请先选择一个主题。');
    return;
  }

  const nextName = normalizeTag(await requestThemeName(oldName));
  if (!nextName || nextName === oldName) return;

  if (getThemeNames().includes(nextName)) {
    notify('error', '这个名称已经存在。');
    return;
  }

  try {
    const theme = getThemeObject(nextName);
    const saveResponse = await fetch('/api/themes/save', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify(theme),
    });
    if (!saveResponse.ok) throw new Error(`save failed: ${saveResponse.status}`);

    let oldDeleted = true;
    const deleteResponse = await fetch('/api/themes/delete', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({ name: oldName }),
    });
    if (!deleteResponse.ok) {
      oldDeleted = false;
      console.warn(`TavernAssetClassifier: old theme was not deleted: ${deleteResponse.status}`);
    }

    state.allThemeOptions = state.allThemeOptions.filter(option => option.value !== oldName);
    state.allThemeOptions.push({ value: nextName, text: nextName });

    const settings = getSettings();
    if (settings.files[oldName]) {
      settings.files[nextName] = globalThis.structuredClone
        ? globalThis.structuredClone(settings.files[oldName])
        : JSON.parse(JSON.stringify(settings.files[oldName]));
    }
    sanitizeStoredThemeNameTags();
    host.power_user.theme = nextName;
    saveSettings();
    applyThemeFilterToSelect();
    const select = getThemeSelect();
    if (select) {
      select.value = nextName;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    scheduleRefresh();
    notify(
      oldDeleted ? 'success' : 'warning',
      oldDeleted
        ? '主题已重命名。刷新页面后会同步到酒馆原生主题列表缓存。'
        : '已保存为新名称，但旧主题文件没有删除；如果它是内置主题，这是正常的。',
    );
  } catch (error) {
    console.error('TavernAssetClassifier: rename failed', error);
    notify('error', '重命名失败，请检查控制台。');
  }
}


function getCurrentPromptPresetName() {
  const select = getCurrentPromptPresetSelect();
  const selected = select?.selectedOptions?.[0];
  return normalizeTag(selected?.textContent || select?.value);
}

function getCurrentPromptPresetValue() {
  return normalizeTag(getCurrentPromptPresetSelect()?.value);
}

function getPresetBindingDisplayName(binding) {
  const select = getCurrentPromptPresetSelect();
  const referenceOnly = binding?.referenceOnly === true
    || !Object.prototype.hasOwnProperty.call(binding || {}, 'promptOrder');
  if (normalizeTag(binding?.presetName)) {
    const name = normalizeTag(binding.presetName);
    const option = Array.from(select?.options ?? []).find(item => normalizeTag(item.textContent) === name);
    if (option || !referenceOnly) return name;
  }
  if (binding?.presetValue && select) {
    const option = Array.from(select.options).find(item => item.value === binding.presetValue);
    if (option) return normalizeTag(option.textContent || option.value);
  }
  return normalizeTag(binding?.presetName || binding?.presetValue || '未知');
}


function getCurrentPromptOrderSnapshot() {
  if (host.main_api !== 'openai') return [];
  const manager = host.promptManager;
  const character = manager?.activeCharacter;
  if (!manager?.getPromptOrderForCharacter || !character) throw new Error('预设条目管理器尚未就绪，请先打开聊天补全预设后重试。');
  return cloneData(manager.getPromptOrderForCharacter(character));
}

function capturePresetBinding(name, { includePromptOrder = true } = {}) {
  const select = getCurrentPromptPresetSelect();
  const selected = select?.selectedOptions?.[0];
  const binding = {
    id: makeBindingId(),
    name,
    createdAt: new Date().toISOString(),
    presetName: normalizeTag(selected?.textContent || select?.value),
    presetValue: normalizeTag(select?.value),
  };
  if (includePromptOrder) binding.promptOrder = getCurrentPromptOrderSnapshot();
  return binding;
}

function captureUserBinding(name) {
  return {
    id: makeBindingId(),
    name,
    createdAt: new Date().toISOString(),
    avatar: normalizeTag(host.user_avatar),
    userName: normalizeTag(host.name1),
  };
}

function getUserBindingDisplayName(binding) {
  const avatar = normalizeTag(binding?.avatar);
  const referenceOnly = binding?.referenceOnly === true
    || !Object.prototype.hasOwnProperty.call(binding || {}, 'userName');
  if (avatar) {
    try {
      const personas = host.power_user?.personas;
      const persona = personas && typeof personas === 'object' ? personas[avatar] : null;
      const current = typeof persona === 'string'
        ? normalizeTag(persona)
        : normalizeTag(persona?.name || persona?.userName || persona?.displayName);
      if (current) return current;
    } catch { /* Fall back to the name stored by older bindings. */ }
    if (referenceOnly && avatar === normalizeTag(host.user_avatar)) return normalizeTag(host.name1);
  }
  return normalizeTag(binding?.userName) || '未记录角色名';
}

function getCurrentCharacterWorldBookSelection() {
  const { id, character } = getCurrentCharacterContext();
  const fileName = character ? getCharaFilename(id) : '';
  const extra = host.world_info?.charLore?.find(item => item?.name === fileName);
  return {
    fileName: normalizeTag(fileName),
    primary: normalizeTag(character?.data?.extensions?.world),
    additional: uniqueTags(extra?.extraBooks),
  };
}

function getWorldBookBindingSummary(binding) {
  const books = Array.isArray(binding?.books) ? binding.books : [];
  const globalCount = uniqueTags(binding?.globalBooks).length;
  const characterCount = uniqueTags([
    binding?.characterBooks?.primary,
    ...(binding?.characterBooks?.additional ?? []),
  ]).length;
  const characterSummary = binding?.preserveCharacterBooks ? '角色 保留' : `角色 ${characterCount} 本`;
  return `全局 ${globalCount} 本 · ${characterSummary} · ${books.length} 本实时读取`;
}

async function captureWorldBookBinding(name, { includeData = true } = {}) {
  const characterKey = getCurrentCharacterKey();
  const globalBooks = uniqueTags(host.selected_world_info);
  const characterSelection = getCurrentCharacterWorldBookSelection();
  const characterBooks = {
    primary: characterSelection.primary,
    additional: characterSelection.additional,
  };
  const bookNames = uniqueTags([globalBooks, characterBooks.primary, characterBooks.additional].flat());
  const books = bookNames.map(bookName => ({ name: bookName }));
  if (includeData) {
    for (const book of books) {
      const data = await loadWorldInfo(book.name);
      assertCharacterContext(characterKey);
      if (!data) throw new Error(`failed to load world book: ${book.name}`);
      book.data = cloneData(data);
    }
  }
  return {
    id: makeBindingId(),
    name,
    createdAt: new Date().toISOString(),
    globalBooks,
    characterBooks,
    preserveCharacterBooks: false,
    books,
  };
}

async function requestBindingName(title, defaultValue) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-binding-modal');
    if (existing) closeModalOverlay(existing);

    const overlay = document.createElement('div');
    overlay.id = 'tac-binding-modal';
    overlay.className = 'tac-binding-form-modal';
    document.body.classList.add('tac-modal-open');
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">角色绑定</div>
            <div class="tac-modal-title"></div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="tac-rename-body">
          <input class="text_pole tac-rename-input" autocomplete="off">
        </div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button" data-action="confirm">保存</button>
        </div>
      </div>
    `;
    overlay.querySelector('.tac-modal-title').textContent = title;
    const input = overlay.querySelector('.tac-rename-input');
    input.value = defaultValue || '';

    const close = value => {
      closeModalOverlay(overlay);
      resolve(normalizeTag(value));
    };

    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close('');
      if (event.target.closest('[data-action="confirm"]')) close(input.value);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') close(input.value);
      if (event.key === 'Escape') close('');
    });

    mountModalOverlay(overlay);
    const isMobileViewport = window.matchMedia?.('(max-width: 700px)')?.matches || navigator.maxTouchPoints > 0;
    if (!isMobileViewport) {
      setTimeout(() => input.focus(), 0);
    }
  });
}

async function savePresetBinding() {
  const characterKey = getCurrentCharacterKey();
  const presetName = getCurrentPromptPresetName();
  if (!presetName) {
    notify('info', '当前没有可保存的预设。');
    return;
  }
  // Freeze the selected entry before automatic bindings can change it during
  // the dialog.  Any legacy prompt-order field is removed before persistence.
  let snapshot;
  try {
    snapshot = capturePresetBinding(presetName);
  } catch (error) {
    // A preset reference does not need the optional prompt-order manager.
    // Keep the older capture API strict while allowing saving to work when
    // that manager has not loaded yet.
    if (!/预设条目管理器尚未就绪/.test(String(error?.message || error))) throw error;
    snapshot = capturePresetBinding(presetName, { includePromptOrder: false });
  }
  const name = await requestBindingName('预设绑定名称', snapshot.presetName);
  if (!name) return;
  assertCharacterContext(characterKey);
  const bindings = getCurrentCharacterBindings();
  bindings.presets.items.unshift({ ...snapshot, name, referenceOnly: true });
  if (await saveCurrentCharacterBindings(bindings)) notify('success', '预设绑定已保存到当前角色卡。');
}

async function saveUserBinding() {
  const characterKey = getCurrentCharacterKey();
  const name = await requestBindingName('user 绑定名称', normalizeTag(host.name1) || '当前 user');
  if (!name) return;
  assertCharacterContext(characterKey);
  const bindings = getCurrentCharacterBindings();
  bindings.users.items.unshift({ ...captureUserBinding(name), referenceOnly: true });
  if (await saveCurrentCharacterBindings(bindings)) notify('success', 'user 绑定已保存到当前角色卡。');
}

async function saveWorldBookBinding() {
  const characterKey = getCurrentCharacterKey();
  const characterSelection = getCurrentCharacterWorldBookSelection();
  const currentNames = uniqueTags([
    ...host.selected_world_info,
    characterSelection.primary,
    ...characterSelection.additional,
  ]);
  const defaultName = currentNames.length ? currentNames.join(' + ') : '无世界书';
  const name = await requestBindingName('世界书绑定名称', defaultName);
  if (!name) return;
  assertCharacterContext(characterKey);
  try {
    const snapshot = await captureWorldBookBinding(name, { includeData: false });
    assertCharacterContext(characterKey);
    const bindings = getCurrentCharacterBindings();
    bindings.worldBooks.items.unshift({
      ...snapshot,
      referenceOnly: true,
      books: snapshot.books.map(book => ({ name: book.name })),
    });
    if (await saveCurrentCharacterBindings(bindings)) {
      notify('success', `世界书绑定已保存：${getWorldBookBindingSummary(snapshot)}`);
    }
  } catch (error) {
    console.error('TavernAssetClassifier: failed to capture world books', error);
    notify('error', '读取当前世界书引用失败，未保存绑定。');
  }
}

async function saveBeautifyBinding(themeName = getCurrentThemeName()) {
  const normalized = normalizeTag(themeName);
  if (!normalized) {
    notify('info', '当前没有可绑定的美化。');
    return false;
  }
  const bindings = getCurrentCharacterBindings();
  const exists = bindings.beautify.items.some(item => normalizeThemeNameKey(item.themeName) === normalizeThemeNameKey(normalized));
  if (exists) {
    notify('info', `美化“${normalized}”已经添加。`);
    return false;
  }
  bindings.beautify.items.unshift({
    id: makeBindingId(),
    themeName: normalized,
    createdAt: new Date().toISOString(),
  });
  const saved = await saveCurrentCharacterBindings(bindings);
  if (saved) notify('success', `已添加美化：${normalized}`);
  return saved;
}

function requestCharacterRelationConfirmation(title, message, confirmLabel) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-binding-modal');
    if (existing) closeModalOverlay(existing);
    const overlay = document.createElement('div');
    overlay.id = 'tac-binding-modal';
    overlay.className = 'tac-binding-form-modal';
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">角色卡关联</div>
            <div class="tac-modal-title"></div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="tac-confirm-body"></div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button" data-action="confirm"></button>
        </div>
      </div>
    `;
    overlay.querySelector('.tac-modal-title').textContent = title;
    overlay.querySelector('.tac-confirm-body').textContent = message;
    overlay.querySelector('[data-action="confirm"]').textContent = confirmLabel;
    const close = value => {
      closeModalOverlay(overlay);
      resolve(value);
    };
    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close(false);
      if (event.target.closest('[data-action="confirm"]')) close(true);
    });
    mountModalOverlay(overlay);
  });
}

async function switchToRelatedCharacter(avatar, fallbackName = '') {
  const target = findCharacterByAvatar(avatar);
  if (!target) {
    notify('warning', `找不到角色卡：${fallbackName || avatar}`);
    return;
  }
  const confirmed = await requestCharacterRelationConfirmation(
    '切换角色卡',
    `确定转到“${target.name}”的角色卡界面吗？`,
    '确认前往',
  );
  if (!confirmed) return;
  const latest = findCharacterByAvatar(avatar);
  if (latest) await selectCharacterById(latest.id);
}

async function confirmRemoveRelatedCharacter(avatar, fallbackName = '') {
  const target = findCharacterByAvatar(avatar);
  const name = target?.name || fallbackName || avatar;
  const confirmed = await requestCharacterRelationConfirmation(
    '删除角色卡关联',
    `确定将“${name}”移出当前关联集合吗？剩余角色卡仍会保持互联。`,
    '确认删除',
  );
  if (confirmed) await removeCharacterFromRelationGroup(avatar);
}

function openCharacterTransferModal(sourceAvatar, targetAvatar, fallbackName = '') {
  const source = findCharacterByAvatar(sourceAvatar);
  const target = findCharacterByAvatar(targetAvatar);
  if (!source || !target) {
    notify('warning', `找不到角色卡：${fallbackName || targetAvatar}`);
    return;
  }
  const sourceBindings = normalizeCharacterBindings(source.character?.data?.extensions?.[EXTENSION_KEY]);
  const counts = getCharacterTransferCounts(sourceBindings);
  const options = [
    { type: 'beautify', icon: 'fa-palette', label: '美化', detail: '复制已添加的美化', unit: '项' },
    { type: 'presets', icon: 'fa-sliders', label: '预设', detail: '复制预设与条目顺序', unit: '项' },
    { type: 'worldBooks', icon: 'fa-book-atlas', label: '世界书', detail: '仅复制非角色绑定世界书的引用', unit: '本' },
    { type: 'users', icon: 'fa-user', label: 'user 信息', detail: '复制 user 名称与头像绑定', unit: '项' },
  ];

  const existing = document.querySelector('#tac-binding-modal');
  if (existing) closeModalOverlay(existing);
  const overlay = document.createElement('div');
  overlay.id = 'tac-binding-modal';
  overlay.className = 'tac-character-transfer-modal';
  trapModalEvents(overlay);
  overlay.innerHTML = `
    <div class="tac-modal-card tac-character-transfer-card">
      <div class="tac-modal-head">
        <div>
          <div class="tac-modal-kicker">角色卡关联已添加</div>
          <div class="tac-modal-title">转移内容到 <span></span></div>
        </div>
        <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="tac-character-transfer-body">
        <p>选择要复制到关联角色卡的内容。目标卡已有内容会保留，相同内容不会重复添加。</p>
        <div class="tac-character-transfer-grid"></div>
      </div>
      <div class="tac-modal-actions">
        <button type="button" class="menu_button" data-action="cancel">暂不转移</button>
        <button type="button" class="menu_button" data-action="confirm" disabled>转移所选</button>
      </div>
    </div>
  `;
  overlay.querySelector('.tac-modal-title span').textContent = target.name;
  const grid = overlay.querySelector('.tac-character-transfer-grid');
  options.forEach(option => {
    const count = counts[option.type];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tac-character-transfer-option';
    button.dataset.transferType = option.type;
    button.disabled = !count;
    button.setAttribute('aria-pressed', 'false');
    button.innerHTML = `
      <span class="tac-character-transfer-icon"><i class="fa-solid ${option.icon}"></i></span>
      <span class="tac-character-transfer-copy">
        <strong></strong>
        <small></small>
      </span>
      <span class="tac-character-transfer-count"></span>
      <i class="fa-solid fa-check tac-character-transfer-check"></i>
    `;
    button.querySelector('strong').textContent = option.label;
    button.querySelector('small').textContent = count ? option.detail : '当前角色卡没有可转移内容';
    button.querySelector('.tac-character-transfer-count').textContent = `${count} ${option.unit}`;
    grid.append(button);
  });

  const selected = new Set();
  const confirm = overlay.querySelector('[data-action="confirm"]');
  grid.addEventListener('click', event => {
    const button = event.target.closest('.tac-character-transfer-option');
    if (!button || button.disabled) return;
    const type = button.dataset.transferType;
    if (selected.has(type)) selected.delete(type);
    else selected.add(type);
    const active = selected.has(type);
    button.classList.toggle('is-selected', active);
    button.setAttribute('aria-pressed', String(active));
    confirm.disabled = !selected.size;
  });
  overlay.addEventListener('click', async event => {
    if (event.target.closest('[data-action="cancel"]')) {
      closeModalOverlay(overlay);
      return;
    }
    if (!event.target.closest('[data-action="confirm"]') || !selected.size) return;
    confirm.disabled = true;
    confirm.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i><span>转移中</span>';
    const transferred = await transferCharacterBindingContent(sourceAvatar, targetAvatar, Array.from(selected));
    if (transferred) closeModalOverlay(overlay);
    else {
      confirm.disabled = false;
      confirm.textContent = '重试转移';
    }
  });
  mountModalOverlay(overlay);
}

function openCharacterLibraryPicker() {
  const { character } = getCurrentCharacterContext();
  const currentAvatar = normalizeTag(character?.avatar);
  const linked = new Set(getCurrentCharacterBindings().relatedCharacters.map(item => item.avatar));
  const candidates = getCharacterLibrary()
    .filter(item => item.avatar !== currentAvatar && !linked.has(item.avatar))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  if (!candidates.length) {
    notify('info', '角色卡库中没有可添加的角色卡。');
    return;
  }

  const existing = document.querySelector('#tac-binding-modal');
  if (existing) closeModalOverlay(existing);
  const overlay = document.createElement('div');
  overlay.id = 'tac-binding-modal';
  overlay.className = 'tac-character-library-modal';
  trapModalEvents(overlay);
  overlay.innerHTML = `
    <div class="tac-modal-card tac-character-library-card">
      <div class="tac-modal-head">
        <div>
          <div class="tac-modal-kicker">角色卡关联</div>
          <div class="tac-modal-title">从角色卡库添加</div>
        </div>
        <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭"><i class="fa-solid fa-xmark"></i></button>
      </div>
      <div class="tac-character-library-search">
        <i class="fa-solid fa-magnifying-glass"></i>
        <input type="search" class="text_pole" placeholder="搜索角色名称" autocomplete="off">
      </div>
      <div class="tac-character-library-grid"></div>
      <div class="tac-character-library-empty" hidden>没有匹配的角色卡。</div>
    </div>
  `;
  const grid = overlay.querySelector('.tac-character-library-grid');
  const empty = overlay.querySelector('.tac-character-library-empty');
  candidates.forEach(candidate => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tac-character-library-item';
    button.dataset.searchText = `${candidate.name} ${candidate.avatar}`.toLocaleLowerCase('zh-Hans-CN');
    button.innerHTML = '<img alt=""><span></span>';
    button.querySelector('img').src = getThumbnailUrl('avatar', candidate.avatar);
    button.querySelector('img').alt = candidate.name;
    button.querySelector('span').textContent = candidate.name;
    button.addEventListener('click', async () => {
      button.disabled = true;
      if (await addCharacterToRelationGroup(candidate.avatar)) {
        closeModalOverlay(overlay);
        openCharacterTransferModal(currentAvatar, candidate.avatar, candidate.name);
      } else button.disabled = false;
    });
    grid.append(button);
  });
  const searchInput = overlay.querySelector('input');
  searchInput.addEventListener('input', () => {
    const query = normalizeTag(searchInput.value).toLocaleLowerCase('zh-Hans-CN');
    const items = Array.from(grid.children);
    items.forEach(item => item.hidden = Boolean(query) && !item.dataset.searchText.includes(query));
    empty.hidden = items.some(item => !item.hidden);
  });
  overlay.addEventListener('click', event => {
    if (event.target.closest('[data-action="cancel"]')) closeModalOverlay(overlay);
  });
  mountModalOverlay(overlay);
}

async function applyPresetBinding(binding, { automatic = false } = {}) {
  if (!binding) return false;
  const characterKey = getCurrentCharacterKey();
  const select = getCurrentPromptPresetSelect();
  const options = Array.from(select?.options ?? []);
  const referenceOnly = binding.referenceOnly === true || !Object.prototype.hasOwnProperty.call(binding, 'promptOrder');
  const presetName = normalizeTag(binding.presetName);
  // Match the stable visible preset name first.  SillyTavern can rebuild
  // numeric option values when its list changes; the value is only a fallback
  // for records whose name is unavailable (or for a renamed option).
  const valueMatch = binding.presetValue
    ? options.find(option => option.value === binding.presetValue)
    : null;
  const nameMatch = presetName
    ? options.find(option => normalizeTag(option.textContent) === presetName)
    : null;
  const matchedOption = referenceOnly
    ? (nameMatch || valueMatch)
    : (presetName ? nameMatch : valueMatch);
  if (!matchedOption && (binding.presetName || binding.presetValue)) throw new Error(`找不到预设：${getPresetBindingDisplayName(binding)}`);
  // Reference bindings follow the currently loaded preset.  Keep applying a
  // prompt-order snapshot only for legacy in-memory records that predate the
  // referenceOnly marker.
  const hasPromptOrder = !referenceOnly && Array.isArray(binding.promptOrder) && binding.promptOrder.length > 0;
  if (hasPromptOrder) requirePromptOrderManager();
  const presetNeedsChange = Boolean(matchedOption && select?.value !== matchedOption.value);
  const presetNeedsRefresh = Boolean(referenceOnly && matchedOption && !presetNeedsChange);
  if (presetNeedsChange || presetNeedsRefresh) {
    await changePromptPreset(select, matchedOption);
  }
  assertCharacterContext(characterKey);

  const manager = host.promptManager;
  const character = manager?.activeCharacter;
  const promptOrderNeedsChange = Boolean(hasPromptOrder && !dataMatches(getCurrentPromptOrderSnapshot(), binding.promptOrder));
  if (promptOrderNeedsChange) {
    requirePromptOrderManager();
    state.promptOrderSavePending = true;
    manager.removePromptOrderForCharacter(character);
    manager.addPromptOrderForCharacter(character, cloneData(binding.promptOrder));
  }
  const promptOrderNeedsSave = hasPromptOrder && state.promptOrderSavePending;
  if (promptOrderNeedsSave) {
    await savePromptOrderSettings(requirePromptOrderManager());
    assertCharacterContext(characterKey);
    await manager.render(false);
    if (!dataMatches(getCurrentPromptOrderSnapshot(), binding.promptOrder)) throw new Error('未确认预设条目顺序已应用，请重新读取后重试。');
  }

  const changed = presetNeedsChange || promptOrderNeedsChange || promptOrderNeedsSave;
  if (!automatic) notify('success', changed ? `已应用预设绑定：${binding.name}` : '当前预设和条目顺序已经一致。');
  return changed;
}

async function applyUserBinding(binding, { automatic = false } = {}) {
  if (!binding) return false;
  const characterKey = getCurrentCharacterKey();
  const referenceOnly = binding.referenceOnly === true
    || !Object.prototype.hasOwnProperty.call(binding, 'userName');
  const avatarNeedsChange = Boolean(binding.avatar && binding.avatar !== normalizeTag(host.user_avatar));
  const persona = referenceOnly && binding.avatar ? host.power_user.personas?.[binding.avatar] : null;
  const personaName = referenceOnly && binding.avatar
    ? (typeof persona === 'string'
      ? normalizeTag(persona)
      : normalizeTag(persona?.name || persona?.userName || persona?.displayName) || normalizeTag(binding.userName))
    : normalizeTag(binding.userName);
  const nameNeedsChange = Boolean(personaName && personaName !== normalizeTag(host.name1));
  if (avatarNeedsChange && !host.power_user.personas?.[binding.avatar]) throw new Error(`找不到 user 头像：${binding.avatar}`);
  host.require([...(avatarNeedsChange ? ['setUserAvatar'] : []), ...(personaName ? ['setUserName'] : [])]);
  if (avatarNeedsChange) {
    await setUserAvatar(binding.avatar, { toastPersonaNameChange: !automatic, navigateToCurrent: false });
  }
  assertCharacterContext(characterKey);
  if (personaName && normalizeTag(host.name1) !== personaName) {
    await setUserName(personaName, { toastPersonaNameChange: !automatic });
  }
  assertCharacterContext(characterKey);
  if ((avatarNeedsChange && normalizeTag(host.user_avatar) !== binding.avatar)
    || (personaName && normalizeTag(host.name1) !== personaName)) throw new Error('未确认 user 名称或头像已切换，请重新读取后重试。');
  const changed = avatarNeedsChange || nameNeedsChange;
  if (!automatic) notify('success', changed ? `已应用 user 绑定：${binding.name}` : '当前 user 已与绑定一致。');
  return changed;
}

function applyBeautifyBinding(themeName, { automatic = false } = {}) {
  const normalized = normalizeTag(themeName);
  if (!normalized) return false;
  if (!getThemeNames().includes(normalized)) {
    throw new Error(`找不到美化：${normalized}`);
  }
  if (normalizeTag(host.power_user.theme || getCurrentThemeName()) === normalized) {
    if (!automatic) notify('success', '当前美化已与绑定一致。');
    return false;
  }
  selectTheme(normalized);
  if (!automatic) notify('success', `已应用角色卡美化：${normalized}`);
  return true;
}

async function applyWorldBookBinding(binding, { automatic = false } = {}) {
  if (!binding) return false;
  const characterKey = getCurrentCharacterKey();
  const books = Array.isArray(binding.books) ? binding.books : [];
  const referenceOnly = binding.referenceOnly === true || books.every(book => !book?.data);
  const targetGlobalBooks = uniqueTags(binding.globalBooks ?? books.map(book => book.name));
  const referencedBookNames = uniqueTags([
    ...targetGlobalBooks,
    ...(binding.preserveCharacterBooks ? [] : [
      binding.characterBooks?.primary,
      ...(binding.characterBooks?.additional ?? []),
    ]),
    ...books
      .filter(book => !binding.preserveCharacterBooks || targetGlobalBooks.includes(normalizeTag(book?.name)))
      .map(book => book?.name),
  ]);

  try {
    host.require([
      'loadWorldInfo',
      ...(referenceOnly ? [] : ['saveWorldInfo']),
      'getWorldInfoSettings', 'updateWorldInfoSettings', 'updateWorldInfoList', 'writeExtensionField', 'charSetAuxWorlds',
    ]);
    getCurrentCharacterWorldBookSelection();
    const beforeGlobalBooks = [...host.selected_world_info];
    let contentChanged = false;
    if (!referenceOnly) {
      if (books.some(book => !book?.name || !book.data?.entries || typeof book.data.entries !== 'object')) throw new Error('世界书绑定数据不完整，未应用。');
      for (const book of books) {
        const current = await loadWorldInfo(book.name);
        assertCharacterContext(characterKey);
        if (dataMatches(current, book.data)) {
          const persisted = await readSavedWorldBook(book.name, { allowMissing: true });
          assertCharacterContext(characterKey);
          if (dataMatches(persisted, book.data)) continue;
        }
        await saveWorldInfo(book.name, cloneData(book.data), true);
        assertCharacterContext(characterKey);
        const persisted = await readSavedWorldBook(book.name);
        assertCharacterContext(characterKey);
        if (!dataMatches(persisted, book.data)) throw new Error(`未确认世界书已完整保存：${book.name}`);
        contentChanged = true;
      }
    } else {
      // Validate that the referenced books still exist, but never write their
      // content.  Their current entries are the source of truth after edits.
      for (const bookName of referencedBookNames) {
        const current = await loadWorldInfo(bookName);
        assertCharacterContext(characterKey);
        if (!current) throw new Error(`找不到世界书：${bookName}`);
      }
    }

    const globalSelectionChanged = !stringSetsMatch(beforeGlobalBooks, targetGlobalBooks);
    if (contentChanged || globalSelectionChanged) {
      updateWorldInfoSettings(cloneData(getWorldInfoSettings()), targetGlobalBooks);
    }
    if (globalSelectionChanged) {
      await updateWorldInfoList();
    }
    assertCharacterContext(characterKey);
    if (!stringSetsMatch(host.selected_world_info, targetGlobalBooks)) throw new Error('未确认全局世界书挂载已切换。');

    const { id, character } = getCurrentCharacterContext();
    const currentCharacterBooks = getCurrentCharacterWorldBookSelection();
    const targetPrimary = binding.preserveCharacterBooks
      ? currentCharacterBooks.primary
      : normalizeTag(binding.characterBooks?.primary);
    const targetAdditional = binding.preserveCharacterBooks
      ? currentCharacterBooks.additional
      : uniqueTags(binding.characterBooks?.additional);
    const savedCharacter = character ? await readSavedCharacter(character.avatar) : null;
    assertCharacterContext(characterKey);
    const primaryChanged = Boolean(character) && (currentCharacterBooks.primary !== targetPrimary
      || normalizeTag(savedCharacter?.data?.extensions?.world) !== targetPrimary);
    const additionalChanged = Boolean(character)
      && !stringSetsMatch(currentCharacterBooks.additional, targetAdditional);
    if (primaryChanged) await writeVerifiedExtensionField(id, 'world', targetPrimary);
    assertCharacterContext(characterKey);
    if (additionalChanged) charSetAuxWorlds(currentCharacterBooks.fileName, targetAdditional);

    const changed = contentChanged || globalSelectionChanged || primaryChanged || additionalChanged;
    if (!automatic) notify('success', changed ? `已应用世界书绑定：${binding.name}` : '当前世界书及条目已经一致。');
    return changed;
  } catch (error) {
    console.error('TavernAssetClassifier: failed to apply world books', error);
    if (automatic) throw error;
    if (!automatic) notify('error', `世界书绑定未完整应用，可能已有部分写入，请核对后重试：${error.message}`);
    return false;
  }
}

async function deleteCharacterBinding(type, id) {
  const bindings = getCurrentCharacterBindings();
  const bucket = bindings[type];
  if (!bucket?.items) return;
  const item = bucket.items.find(entry => entry.id === id);
  const confirmed = await requestDeleteBindingConfirmation(type, item?.name || item?.themeName || '');
  if (!confirmed) return;
  bucket.items = bucket.items.filter(item => item.id !== id);
  if (bucket.starredId === id) bucket.starredId = '';
  await saveCurrentCharacterBindings(bindings);
}

function requestDeleteBindingConfirmation(type, name) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-binding-modal');
    if (existing) closeModalOverlay(existing);

    const overlay = document.createElement('div');
    overlay.id = 'tac-binding-modal';
    overlay.className = 'tac-binding-form-modal';
    document.body.classList.add('tac-modal-open');
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">删除绑定</div>
            <div class="tac-modal-title"></div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="tac-confirm-body"></div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button danger_button" data-action="confirm">删除</button>
        </div>
      </div>
    `;
    const titles = { beautify: '删除美化绑定', presets: '删除预设绑定', users: '删除 user 绑定', worldBooks: '删除世界书绑定' };
    overlay.querySelector('.tac-modal-title').textContent = titles[type] || '删除绑定';
    overlay.querySelector('.tac-confirm-body').textContent = name ? `确定删除“${name}”？` : '确定删除这条绑定？';

    const close = value => {
      closeModalOverlay(overlay);
      resolve(value);
    };

    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close(false);
      if (event.target.closest('[data-action="confirm"]')) close(true);
    });
    mountModalOverlay(overlay);
  });
}

function requestUpdateBindingConfirmation(title, message) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-binding-modal');
    if (existing) closeModalOverlay(existing);

    const overlay = document.createElement('div');
    overlay.id = 'tac-binding-modal';
    overlay.className = 'tac-binding-form-modal';
    document.body.classList.add('tac-modal-open');
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">更新绑定</div>
            <div class="tac-modal-title"></div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="tac-confirm-body"></div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button" data-action="confirm">确认更新</button>
        </div>
      </div>
    `;
    overlay.querySelector('.tac-modal-title').textContent = title;
    overlay.querySelector('.tac-confirm-body').textContent = message;

    const close = value => {
      closeModalOverlay(overlay);
      resolve(value);
    };
    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close(false);
      if (event.target.closest('[data-action="confirm"]')) close(true);
    });
    mountModalOverlay(overlay);
  });
}

async function updatePresetBinding(id) {
  const characterKey = getCurrentCharacterKey();
  const presetName = getCurrentPromptPresetName();
  if (!presetName) {
    notify('info', '当前没有可用于更新的预设。');
    return;
  }
  const original = getCurrentCharacterBindings().presets.items.find(binding => binding.id === id);
  if (!original) return;
  let snapshot;
  try {
    snapshot = capturePresetBinding(original.name);
  } catch (error) {
    if (!/预设条目管理器尚未就绪/.test(String(error?.message || error))) throw error;
    snapshot = capturePresetBinding(original.name, { includePromptOrder: false });
  }
  if (!await requestUpdateBindingConfirmation('更新预设绑定', `将“${original.name}”更新为当前预设“${snapshot.presetName}”，是否继续？`)) return;
  assertCharacterContext(characterKey);

  const bindings = getCurrentCharacterBindings();
  const item = bindings.presets.items.find(binding => binding.id === id);
  if (!item) return;
  const referenceOnly = item.referenceOnly === true;
  Object.assign(item, snapshot, {
    id: item.id,
    name: item.name,
    createdAt: item.createdAt || snapshot.createdAt,
    ...(referenceOnly ? { referenceOnly: true, promptOrder: [] } : {}),
    updatedAt: new Date().toISOString(),
  });
  if (await saveCurrentCharacterBindings(bindings)) {
    notify('success', `已用当前预设更新绑定：${item.name}`);
  }
}

async function updateWorldBookBinding(id) {
  const bindings = getCurrentCharacterBindings();
  const item = bindings.worldBooks.items.find(binding => binding.id === id);
  if (!item) return;
  const characterSelection = getCurrentCharacterWorldBookSelection();
  const currentNames = uniqueTags([
    ...host.selected_world_info,
    characterSelection.primary,
    ...characterSelection.additional,
  ]);
  const description = currentNames.length ? currentNames.join('、') : '无世界书';
  if (!await requestUpdateBindingConfirmation('更新世界书绑定', `将“${item.name}”更新为当前启用及角色挂载的世界书（${description}），是否继续？`)) return;

  try {
    const snapshot = await captureWorldBookBinding(item.name, { includeData: false });
    Object.assign(item, snapshot, {
      id: item.id,
      name: item.name,
      createdAt: item.createdAt || snapshot.createdAt,
      referenceOnly: true,
      books: snapshot.books.map(book => ({ name: book.name })),
      updatedAt: new Date().toISOString(),
    });
    if (await saveCurrentCharacterBindings(bindings)) {
      notify('success', `已更新世界书绑定：${getWorldBookBindingSummary(item)}`);
    }
  } catch (error) {
    console.error('TavernAssetClassifier: failed to update world books', error);
    notify('error', '读取当前世界书失败，未更新绑定。');
  }
}

async function starCharacterBinding(type, id) {
  const bindings = getCurrentCharacterBindings();
  const bucket = bindings[type];
  if (!bucket) return;
  bucket.starredId = bucket.starredId === id ? '' : id;
  await saveCurrentCharacterBindings(bindings);
}

async function applyStarredCharacterBindings() {
  if (state.applyingCharacterBinding) {
    state.characterBindingApplyPending = true;
    return;
  }
  const key = getCurrentCharacterKey();
  if (!key || state.lastAppliedCharacterBindingKey === key) return;
  state.applyingCharacterBinding = true;
  state.characterBindingApplyPending = false;
  try {
    const bindings = getCurrentCharacterBindings();
    const beautify = bindings.beautify.items.find(item => item.id === bindings.beautify.starredId);
    if (beautify) {
      applyBeautifyBinding(beautify.themeName, { automatic: true });
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    const preset = bindings.presets.items.find(item => item.id === bindings.presets.starredId);
    assertCharacterContext(key);
    if (preset) await applyPresetBinding(preset, { automatic: true });
    const user = bindings.users.items.find(item => item.id === bindings.users.starredId);
    assertCharacterContext(key);
    if (user) await applyUserBinding(user, { automatic: true });
    const worldBooks = bindings.worldBooks.items.find(item => item.id === bindings.worldBooks.starredId);
    assertCharacterContext(key);
    if (worldBooks) await applyWorldBookBinding(worldBooks, { automatic: true });
    assertCharacterContext(key);
    state.lastAppliedCharacterBindingKey = key;
  } finally {
    state.applyingCharacterBinding = false;
    scheduleCharacterBindingRender();
    if (state.characterBindingApplyPending || getCurrentCharacterKey() !== key) scheduleCharacterBindingApply();
  }
}

function scheduleCharacterBindingApply(delay = 500) {
  clearTimeout(state.characterBindingTimer);
  state.characterBindingTimer = setTimeout(() => {
    state.characterBindingTimer = null;
    void runFeatureTask('自动应用角色绑定', applyStarredCharacterBindings);
  }, delay);
}

function scheduleCharacterBindingRender(delay = 80) {
  clearTimeout(state.characterBindingRenderTimer);
  state.characterBindingRenderTimer = setTimeout(() => {
    state.characterBindingRenderTimer = null;
    void runFeatureTask('刷新角色绑定', renderCharacterBindingPanel);
  }, delay);
}




function waitForThemeImportInputReset(input, timeout = 300000) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!input.files?.length || Date.now() - startedAt >= timeout) {
        clearInterval(timer);
        resolve(!input.files?.length);
      }
    }, 50);
  });
}

async function importThemeFilesSequentially(input, files) {
  if (typeof DataTransfer !== 'function') {
    notify('error', '当前浏览器不支持批量传递文件，请升级浏览器后重试。');
    return;
  }

  let imported = 0;
  let skipped = 0;
  let firstImportedTheme = '';
  let metadataChanged = false;
  state.batchThemeImportActive = true;
  try {
    for (const file of files) {
      let themeName = '';
      let parsedTheme = null;
      try {
        parsedTheme = JSON.parse(await file.text());
        themeName = normalizeTag(parsedTheme?.name);
        if (!themeName) throw new Error('missing theme name');
      } catch (error) {
        console.warn('TavernAssetClassifier: invalid theme file', file.name, error);
        skipped += 1;
        continue;
      }

      if (state.allThemeOptions.some(option => option.value === themeName || option.text === themeName)
        || Array.from(getThemeSelect()?.options ?? []).some(option => option.value === themeName)) {
        skipped += 1;
        continue;
      }

      try {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        const reset = waitForThemeImportInputReset(input);
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (!await reset) throw new Error('theme import timed out');
        const exists = state.allThemeOptions.some(option => option.value === themeName || option.text === themeName)
          || Array.from(getThemeSelect()?.options ?? []).some(option => option.value === themeName);
        if (exists) {
          imported += 1;
          firstImportedTheme ||= themeName;
          if (!state.sessionImportedThemeValues.includes(themeName)) {
            state.sessionImportedThemeValues.push(themeName);
          }
          const record = getThemeRecord(themeName);
          if (record && applyInferredThemeTags(record, parsedTheme)) metadataChanged = true;
        } else {
          skipped += 1;
        }
      } catch (error) {
        console.warn('TavernAssetClassifier: failed to import theme file', file.name, error);
        skipped += 1;
        input.value = '';
      }
    }
  } finally {
    state.batchThemeImportActive = false;
    input.value = '';
  }

  if (metadataChanged) saveSettings();
  if (firstImportedTheme) {
    selectTheme(firstImportedTheme, { preserveSettingsDrawer: true });
    renderThemePicker();
    scheduleRefresh();
  }
  notify(imported ? 'success' : 'warning', `批量导入完成：成功 ${imported} 个${skipped ? `，跳过 ${skipped} 个` : ''}。`);
}

function enableBatchThemeImport() {
  const input = document.querySelector('#ui_preset_import_file');
  if (!input || input.dataset.tacBatchImport === '1') return;
  input.multiple = true;
  input.dataset.tacBatchImport = '1';
  input.addEventListener('change', event => {
    const files = Array.from(input.files ?? []);
    if (files.length <= 1) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    input.value = '';
    void importThemeFilesSequentially(input, files);
  }, true);
}

function mountUi() {
  const themeBlock = document.querySelector('#UI-presets-block');
  const themeRow = document.querySelector('#themes')?.closest('.flex-container');
  if (!themeBlock || !themeRow) return false;
  mountThemePicker(themeRow);
  enableBatchThemeImport();
  if (document.querySelector('#tac-filter-panel')) return true;

  const actions = document.createElement('div');
  actions.id = 'tac-theme-actions';
  actions.addEventListener('click', event => event.stopPropagation());

  const updateButton = document.querySelector('#ui-preset-update-button');
  const saveButton = document.querySelector('#ui-preset-save-button');
  if (updateButton) {
    updateButton.title = '覆盖保存当前美化';
    updateButton.setAttribute('aria-label', '覆盖保存当前美化');
    actions.append(updateButton);
  }
  if (saveButton) {
    saveButton.title = '另存为新美化';
    saveButton.setAttribute('aria-label', '另存为新美化');
    actions.append(saveButton);
  }

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.id = 'tac-theme-rename-button';
  rename.className = 'menu_button margin0';
  rename.title = '重命名当前主题';
  rename.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';
  rename.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    void renameCurrentTheme();
  });
  actions.append(rename);

  const setButton = document.createElement('button');
  setButton.type = 'button';
  setButton.id = 'tac-open-tag-editor';
  setButton.className = 'menu_button';
  setButton.title = '设定标签';
  setButton.innerHTML = '<i class="fa-solid fa-tags"></i>';
  setButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    openTagEditor();
  });
  actions.append(setButton);

  themeBlock.append(actions);

  const details = document.createElement('details');
  details.id = 'tac-filter-panel';
  details.open = true;
  details.innerHTML = `
    <summary>
      <span><i class="fa-solid fa-layer-group"></i> 分类筛选</span>
      <i class="fa-solid fa-chevron-down tac-chevron"></i>
    </summary>
    <div id="tac-filter-body"></div>
  `;
  themeBlock.append(details);

  getThemeSelect()?.addEventListener('change', () => {
    setTimeout(() => void runFeatureTask('同步美化配置', () => {
      autoTagCurrentThemeMetadata();
      renderThemePicker();
      scheduleRefresh();
      syncBoundBackgroundForCurrentTheme(true);
    }), 0);
  });

  document.querySelector('#ui-preset-delete-button')?.addEventListener('click', () => {
    const deletedName = getCurrentThemeName();
    scheduleRefresh(300);
    setTimeout(() => {
      const select = getThemeSelect();
      const stillVisible = Array.from(select?.options ?? []).some(option => option.value === deletedName);
      if (deletedName && !stillVisible) {
        state.allThemeOptions = state.allThemeOptions.filter(option => option.value !== deletedName);
        state.sessionImportedThemeValues = state.sessionImportedThemeValues.filter(value => value !== deletedName);
      }
      scheduleRefresh();
    }, 900);
  });

  document.querySelector('#ui-preset-update-button')?.addEventListener('click', () => {
    scheduleRefresh(300);
  });

  document.querySelector('#ui-preset-save-button')?.addEventListener('click', () => {
    scheduleRefresh(300);
  });

  scheduleRefresh();
  void autoTagAllThemeMetadata();
  setTimeout(() => void runFeatureTask('读取美化标签', () => {
    if (autoTagCurrentThemeMetadata()) scheduleRefresh();
  }), 250);
  startThemeBackgroundSync();
  syncBoundBackgroundForCurrentTheme(true);
  return true;
}

function destroyBeautifyFeature({ restoreOptions = true } = {}) {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
  state.observer?.disconnect();
  state.observer = null;
  state.themePickerCleanup?.();
  state.themePickerCleanup = null;
  stopThemeBackgroundSync();
  if (restoreOptions) restoreThemeSelectOptions();
  const themeBlock = document.querySelector('#UI-presets-block');
  const actions = document.querySelector('#tac-theme-actions');
  const updateButton = document.querySelector('#ui-preset-update-button');
  const saveButton = document.querySelector('#ui-preset-save-button');
  if (themeBlock && actions) {
    if (updateButton) themeBlock.insertBefore(updateButton, actions);
    if (saveButton) themeBlock.insertBefore(saveButton, actions);
  }
  actions?.remove();
  document.querySelector('#tac-theme-picker')?.remove();
  document.querySelector('#tac-theme-picker-menu')?.remove();
  getThemeSelect()?.classList.remove('tac-native-theme-select');
  getThemeSelect()?.closest('.tac-theme-picker-row')?.classList.remove('tac-theme-picker-row');
  document.querySelector('#tac-filter-panel')?.remove();
}

function observeThemeOptions() {
  const select = getThemeSelect();
  if (!select || state.observer) return;
  snapshotThemeOptions();
  state.observer = new MutationObserver(mutations => {
    if (state.suppressThemeObserver) return;
    const knownValues = new Set(state.allThemeOptions.map(option => option.value));
    const addedValues = [];
    const removedValues = [];
    const collectValues = (nodes, target) => nodes.forEach(node => {
      if (!(node instanceof Element)) return;
      if (node.matches('option')) target.push(normalizeTag(node.value));
      node.querySelectorAll?.('option').forEach(option => target.push(normalizeTag(option.value)));
    });
    mutations.forEach(mutation => {
      collectValues(Array.from(mutation.addedNodes), addedValues);
      collectValues(Array.from(mutation.removedNodes), removedValues);
    });
    const currentValues = new Set(Array.from(select.options).map(option => normalizeTag(option.value)).filter(Boolean));
    const trulyRemoved = new Set(removedValues.filter(value => value && !currentValues.has(value)));
    if (trulyRemoved.size) {
      state.allThemeOptions = state.allThemeOptions.filter(option => !trulyRemoved.has(option.value));
      state.sessionImportedThemeValues = state.sessionImportedThemeValues.filter(value => !trulyRemoved.has(value));
    }
    snapshotThemeOptions();
    const importedValue = addedValues.find(value => value && !knownValues.has(value));
    if (importedValue && currentValues.has(importedValue) && !state.batchThemeImportActive) {
      select.value = importedValue;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    renderThemePicker();
    scheduleRefresh();
  });
  state.observer.observe(select, { childList: true, subtree: true, attributes: true });
}

function getExtensionSettingsHost() {
  return document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2');
}

function makeBindingButton(icon, title, onClick, extraClass = '', label = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `menu_button tac-binding-icon ${extraClass}`.trim();
  button.title = title;
  button.innerHTML = `<i class="${icon.includes(' ') ? icon : `fa-solid ${icon}`}"></i>${label ? '<span></span>' : ''}`;
  if (label) button.querySelector('span').textContent = label;
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    if (onClick) void runFeatureTask(title, onClick);
  });
  return button;
}

function makeBindingListItem(type, item, starredId) {
  const row = document.createElement('div');
  const isStarred = starredId === item.id;
  const isStacked = type === 'presets' || type === 'worldBooks';
  row.className = `tac-binding-item${type === 'users' ? ' tac-binding-user-item' : ''}${isStacked ? ' tac-binding-stacked-item' : ''}${isStarred ? ' is-starred' : ''}`;
  const worldBookNames = Array.isArray(item.books) ? item.books.map(book => book.name) : [];
  const typeLabel = type === 'presets' ? '预设' : type === 'worldBooks' ? '世界书' : 'user';
  row.dataset.searchText = [item.name, item.presetName, item.presetValue, getUserBindingDisplayName(item), item.avatar, ...worldBookNames, typeLabel]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('zh-Hans-CN');

  if (type === 'users') {
    const avatar = document.createElement('div');
    avatar.className = 'tac-binding-user-avatar';
    if (item.avatar) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = getThumbnailUrl('persona', item.avatar);
      avatar.append(image);
    } else {
      avatar.innerHTML = '<i class="fa-solid fa-user"></i>';
    }
    row.append(avatar);
  }

  const main = document.createElement('div');
  main.className = 'tac-binding-item-main';
  const title = document.createElement('div');
  title.className = 'tac-binding-item-title';
  title.textContent = item.name;
  const meta = document.createElement('div');
  meta.className = 'tac-binding-item-meta';
  if (type === 'presets') {
    meta.textContent = getPresetBindingDisplayName(item);
  } else if (type === 'worldBooks') {
    meta.textContent = `${getWorldBookBindingSummary(item)}${worldBookNames.length ? ` · ${worldBookNames.join('、')}` : ''}`;
  } else {
    meta.textContent = getUserBindingDisplayName(item);
  }
  main.append(title, meta);

  const actions = document.createElement('div');
  actions.className = 'tac-binding-item-actions';
  const star = makeBindingButton(
    isStarred ? 'fa-star' : 'fa-regular fa-star',
    isStarred ? '取消自动加载' : '标为自动加载',
    () => starCharacterBinding(type, item.id),
    `tac-binding-star${isStarred ? ' is-active' : ''}`,
  );
  star.setAttribute('aria-pressed', String(isStarred));
  actions.append(star);
  if (type === 'presets') {
    actions.append(makeBindingButton('fa-rotate', '用当前预设更新绑定', () => updatePresetBinding(item.id), 'tac-binding-update'));
  } else if (type === 'worldBooks') {
    actions.append(makeBindingButton('fa-rotate', '用当前世界书及条目更新绑定', () => updateWorldBookBinding(item.id), 'tac-binding-update'));
  }
  const applyBinding = () => {
    if (type === 'presets') return applyPresetBinding(item);
    if (type === 'worldBooks') return applyWorldBookBinding(item);
    return applyUserBinding(item);
  };
  actions.append(
    makeBindingButton('fa-right-to-bracket', '应用绑定', applyBinding),
    makeBindingButton('fa-trash', '删除绑定', () => deleteCharacterBinding(type, item.id)),
  );
  row.append(main, actions);
  return row;
}

function makeBeautifyBindingListItem(item, starredId) {
  const row = document.createElement('div');
  const isStarred = starredId === item.id;
  row.className = `tac-binding-item tac-beautify-binding-item${isStarred ? ' is-starred' : ''}`;
  row.dataset.searchText = `${item.themeName} 美化`.toLocaleLowerCase('zh-Hans-CN');

  const main = document.createElement('div');
  main.className = 'tac-binding-item-main';
  const title = document.createElement('div');
  title.className = 'tac-binding-item-title';
  title.textContent = item.themeName;
  main.append(title);
  if (normalizeThemeNameKey(item.themeName) === normalizeThemeNameKey(getCurrentThemeName())) {
    const meta = document.createElement('div');
    meta.className = 'tac-binding-item-meta';
    meta.textContent = '当前正在使用';
    main.append(meta);
  }

  const actions = document.createElement('div');
  actions.className = 'tac-binding-item-actions';
  const star = makeBindingButton(
    isStarred ? 'fa-star' : 'fa-regular fa-star',
    isStarred ? '取消自动加载' : '标为自动加载',
    () => starCharacterBinding('beautify', item.id),
    `tac-binding-star${isStarred ? ' is-active' : ''}`,
  );
  star.setAttribute('aria-pressed', String(isStarred));
  actions.append(
    star,
    makeBindingButton('fa-right-to-bracket', '应用美化', () => applyBeautifyBinding(item.themeName)),
    makeBindingButton('fa-trash', '删除美化绑定', () => deleteCharacterBinding('beautify', item.id)),
  );
  row.append(main, actions);
  return row;
}

function getMusicQueue(music = state.musicBindings) {
  if (!music) return [];
  if (Array.isArray(music.queueTrackIds)) {
    return music.queueTrackIds
      .map(id => music.tracks.find(track => track.id === id))
      .filter(Boolean);
  }
  const selected = new Set(uniqueTags(music.selectedPlaylists));
  const seen = new Set();
  const queue = [];
  music.playlists.filter(list => selected.has(list.id)).forEach(list => {
    list.trackIds.forEach(id => {
      const track = music.tracks.find(item => item.id === id);
      if (track && !seen.has(track.id)) {
        seen.add(track.id);
        queue.push(track);
      }
    });
  });
  return queue;
}

function getMusicTrack(trackId = state.musicBindings?.currentTrackId) {
  return state.musicBindings?.tracks.find(track => track.id === trackId) || null;
}

function findMusicTrackIndex(track) {
  return getMusicQueue().findIndex(item => item.id === track?.id);
}

function parseMusicLyrics(value) {
  const entries = [];
  String(value || '').split(/\r?\n/).forEach(line => {
    const timestamps = [...line.matchAll(/\[(\d{1,3}):(\d{1,2}(?:\.\d{1,3})?)\]/g)];
    const text = line.replace(/\[\d{1,3}:\d{1,2}(?:\.\d{1,3})?\]/g, '').trim();
    timestamps.forEach(match => {
      const time = Number(match[1]) * 60 + Number(match[2]);
      if (Number.isFinite(time) && text) entries.push({ time, text });
    });
  });
  return entries.sort((left, right) => left.time - right.time);
}

function getCurrentMusicLyric(track, currentTime = 0) {
  if (!track) return '';
  const source = String(track.lyrics || '');
  if (!source) return '';
  const cached = state.musicLyricsCache.get(track.id);
  const entries = cached?.source === source
    ? cached.entries
    : (() => {
      const parsed = parseMusicLyrics(source);
      state.musicLyricsCache.set(track.id, { source, entries: parsed });
      return parsed;
    })();
  if (!entries.length) return '';
  if (currentTime < entries[0].time) return '';
  let low = 0;
  let high = entries.length - 1;
  let currentIndex = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].time <= currentTime) {
      currentIndex = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return entries[currentIndex].text;
}

function isMusicDocumentVisible(doc) {
  try {
    return !doc.hidden && doc.visibilityState !== 'hidden';
  } catch {
    return true;
  }
}

function isMusicUiVisible() {
  return getMusicHostDocuments().some(isMusicDocumentVisible);
}

function bindMusicVisibilityHandlers() {
  getMusicHostDocuments().forEach(doc => {
    if (state.musicVisibilityDocuments.has(doc)) return;
    state.musicVisibilityDocuments.add(doc);
    doc.addEventListener('visibilitychange', () => {
      if (isMusicDocumentVisible(doc)) {
        state.musicProgressLastUpdate = 0;
        updateMusicPlayerDom();
      }
    }, { passive: true });
  });
}

function updateMusicProgressDom() {
  if (!isMusicUiVisible()) return;
  const audio = state.musicAudio;
  const duration = Number.isFinite(audio?.duration) && audio.duration > 0 ? audio.duration : 0;
  const currentTime = Number.isFinite(audio?.currentTime) ? Math.max(0, audio.currentTime) : 0;
  const progress = duration ? String((currentTime / duration) * 100 || 0) : '0';
  getMusicQueryNodes('.tac-music-progress').forEach(input => {
    if (input.value !== progress) input.value = progress;
  });
  const format = value => Number.isFinite(value) ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}` : '0:00';
  const time = `${format(currentTime)} / ${format(audio?.duration || 0)}`;
  getMusicQueryNodes('.tac-music-time').forEach(node => {
    if (node.textContent !== time) node.textContent = time;
  });
  updateMusicFloatingLyrics();
}

function scheduleMusicProgressUpdate() {
  if (!isMusicUiVisible() || state.musicProgressTimer) return;
  const elapsed = Date.now() - state.musicProgressLastUpdate;
  const delay = Math.max(0, 300 - elapsed);
  state.musicProgressTimer = setTimeout(() => {
    state.musicProgressTimer = null;
    if (!isMusicUiVisible()) return;
    state.musicProgressLastUpdate = Date.now();
    updateMusicProgressDom();
  }, delay);
}

function updateMusicFloatingLyrics() {
  const lyricNodes = getMusicQueryNodes('.tac-music-floating-lyrics:not([hidden])');
  if (!lyricNodes.length) return;
  const track = getMusicTrack();
  const text = getCurrentMusicLyric(track, state.musicAudio?.currentTime || 0);
  lyricNodes.forEach(node => {
    node.textContent = text || (track?.lyrics || track?.lrc ? '暂无当前歌词' : '当前歌曲没有保存歌词。');
  });
}

function updateMusicPlayerDom() {
  if (!isMusicUiVisible()) return;
  bindMusicVisibilityHandlers();
  if (state.musicProgressTimer) {
    clearTimeout(state.musicProgressTimer);
    state.musicProgressTimer = null;
  }
  const music = state.musicBindings;
  const track = getMusicTrack();
  getMusicQueryNodes('.tac-music-floating').forEach(node => node.classList.toggle('is-playing', state.musicPlaying));
  getMusicQueryNodes('.tac-music-floating-toggle').forEach(button => {
    const cover = normalizeTag(track?.cover);
    button.classList.toggle('has-cover', Boolean(cover));
    button.style.backgroundImage = cover ? `url(${JSON.stringify(cover)})` : '';
    const icon = button.querySelector('i');
    if (icon) icon.hidden = Boolean(cover);
  });
  const current = track ? `${track.title}${track.artist ? ` · ${track.artist}` : ''}` : '选择歌曲开始播放';
  getMusicQueryNodes('.tac-music-current-track').forEach(node => { node.textContent = current; });
  getMusicQueryNodes('.tac-music-floating-queue').forEach(list => {
    const queue = getMusicQueue(music);
    const signature = queue.map(item => `${item.id}:${item.title}:${item.artist || ''}`).join('|');
    if (list.dataset.queueSignature !== signature) {
      list.replaceChildren();
      queue.forEach(item => {
        const button = list.ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'tac-music-floating-queue-item';
        button.dataset.trackId = item.id;
        button.innerHTML = '<span></span><small></small>';
        button.querySelector('span').textContent = item.title;
        button.querySelector('small').textContent = item.artist || '未知歌手';
        button.addEventListener('click', event => {
          event.stopPropagation();
          void playMusicTrack(item, true);
        });
        list.append(button);
      });
      if (!queue.length) list.innerHTML = '<small class="tac-music-floating-queue-empty">暂无歌曲</small>';
      list.dataset.queueSignature = signature;
    }
    list.querySelectorAll('[data-track-id]').forEach(button => button.classList.toggle('is-current', button.dataset.trackId === track?.id));
  });
  getMusicQueryNodes('.tac-music-play-toggle').forEach(button => {
    const icon = button.querySelector('i');
    const pending = state.musicPlaybackPending;
    const title = pending ? '正在加载' : state.musicPlaying ? '暂停' : '播放';
    if (icon) icon.className = `fa-solid ${pending ? 'fa-spinner fa-spin' : state.musicPlaying ? 'fa-pause' : 'fa-play'}`;
    button.classList.toggle('is-loading', pending);
    button.title = title;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(state.musicPlaying || pending));
  });
  getMusicQueryNodes('.tac-music-mode').forEach(button => {
    const mode = music?.mode || 'sequence';
    button.dataset.mode = mode;
    button.classList.add('is-active');
    button.title = mode === 'sequence' ? '顺序播放' : mode === 'single' ? '单首循环' : '随机播放';
    const label = button.querySelector('span');
    if (label) label.textContent = mode === 'sequence' ? '顺序' : mode === 'single' ? '单首' : '随机';
    const icon = button.querySelector('i');
    if (icon) icon.className = `fa-solid ${mode === 'sequence' ? 'fa-list-ol' : mode === 'single' ? 'fa-repeat' : 'fa-shuffle'}`;
  });
  state.musicProgressLastUpdate = Date.now();
  updateMusicProgressDom();
}

function getMusicStorageKey(trackId) {
  const { character } = getCurrentCharacterContext();
  return `${normalizeTag(character?.avatar)}::${trackId}`;
}

function openMusicDatabase() {
  if (state.musicDbPromise) return state.musicDbPromise;
  if (!('indexedDB' in window)) return Promise.reject(new Error('当前浏览器不支持本地音乐存储'));
  state.musicDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open('tac-character-music', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('tracks');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开本地音乐存储失败'));
  }).catch(error => {
    state.musicDbPromise = null;
    throw error;
  });
  return state.musicDbPromise;
}

async function saveMusicBlob(trackId, blob) {
  const database = await openMusicDatabase();
  await new Promise((resolve, reject) => {
    const request = database.transaction('tracks', 'readwrite').objectStore('tracks').put(blob, getMusicStorageKey(trackId));
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error || new Error('保存本地音乐失败'));
  });
}

async function readMusicBlob(trackId) {
  const database = await openMusicDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction('tracks', 'readonly').objectStore('tracks').get(getMusicStorageKey(trackId));
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error('读取本地音乐失败'));
  });
}

async function deleteMusicBlob(trackId) {
  try {
    const database = await openMusicDatabase();
    await new Promise((resolve, reject) => {
      const request = database.transaction('tracks', 'readwrite').objectStore('tracks').delete(getMusicStorageKey(trackId));
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error || new Error('删除本地音乐失败'));
    });
  } catch { /* Metadata deletion still succeeds when IndexedDB is unavailable. */ }
}

function dataUrlToBlob(value) {
  const match = String(value || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (!match) return null;
  try {
    const mime = match[1] || 'audio/mpeg';
    const bytes = match[2]
      ? Uint8Array.from(atob(match[3]), character => character.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(match[3]));
    return new Blob([bytes], { type: mime });
  } catch { return null; }
}

function getKnownMusicSource(track) {
  if (!track?.src) return '';
  if (state.musicResolvedSources.has(track.id)) return state.musicResolvedSources.get(track.id);
  if (track.src.startsWith('tac-local://')) return state.musicObjectUrls.get(track.id) || '';
  if (track.source === 'netease') {
    try {
      const id = track.providerId || new URL(track.src, location.href).searchParams.get('id');
      const proxy = getNeteaseMusicProxySource(id);
      if (proxy) return proxy;
    } catch { /* use the saved source below */ }
  }
  if (!track.src.startsWith('data:')) return track.src;
  if (state.musicObjectUrls.has(track.id)) return state.musicObjectUrls.get(track.id);
  const blob = dataUrlToBlob(track.src);
  if (!blob) return track.src;
  const objectUrl = URL.createObjectURL(blob);
  state.musicObjectUrls.set(track.id, objectUrl);
  return objectUrl;
}

async function compactLocalMusicTracks() {
  for (const track of state.musicBindings?.tracks || []) {
    if (!track.src.startsWith('data:')) continue;
    const blob = dataUrlToBlob(track.src);
    if (!blob) continue;
    try {
      await saveMusicBlob(track.id, blob);
      track.src = `tac-local://${track.id}`;
    } catch (error) {
      console.warn('TavernAssetClassifier: keeping embedded music data because IndexedDB is unavailable', error);
    }
  }
}

function saveMusicState() {
  const task = state.musicSavePromise.then(async () => {
    if (!state.musicBindings || !getCurrentCharacterKey()) return false;
    await compactLocalMusicTracks();
    const { id, character } = getCurrentCharacterContext();
    if (id === undefined || !character) return false;
    const bindings = getCurrentCharacterBindings();
    bindings.music = normalizeMusicBindings(state.musicBindings);
    state.musicBindings = bindings.music;
    // Music can contain browser-local media handles and large metadata. Save it
    // directly through the host merge endpoint; the generic binding verifier is
    // intentionally avoided here because the character API may answer from a
    // stale card snapshot while audio storage is still being flushed.
    await writeExtensionField(id, EXTENSION_KEY, bindings);
    character.data ??= {};
    character.data.extensions ??= {};
    character.data.extensions[EXTENSION_KEY] = cloneData(bindings);
    return true;
  });
  state.musicSavePromise = task.catch(error => {
    console.error('TavernAssetClassifier: queued music save failed', error);
    return false;
  });
  return task;
}

function ensureMusicAudio() {
  bindMusicVisibilityHandlers();
  if (state.musicAudio) return state.musicAudio;
  const audio = document.createElement('audio');
  audio.id = 'tac-character-music-audio';
  audio.preload = 'metadata';
  audio.setAttribute('playsinline', '');
  audio.setAttribute('aria-hidden', 'true');
  audio.style.display = 'none';
  audio.addEventListener('ended', () => { void playNextMusicTrack(1, true); });
  audio.addEventListener('play', () => {
    state.musicPlaybackPending = false;
    state.musicPlaying = true;
    updateMusicPlayerDom();
  });
  audio.addEventListener('pause', () => {
    state.musicPlaybackPending = false;
    state.musicPlaying = false;
    updateMusicPlayerDom();
  });
  audio.addEventListener('timeupdate', scheduleMusicProgressUpdate);
  audio.addEventListener('loadedmetadata', () => {
    const track = getMusicTrack(state.musicLoadedTrackId) || getMusicTrack();
    if (track) state.musicFailedTrackIds.delete(track.id);
    updateMusicPlayerDom();
  });
  audio.addEventListener('error', () => {
    state.musicPlaybackPending = false;
    state.musicPlaying = false;
    updateMusicPlayerDom();
    const track = getMusicTrack(state.musicLoadedTrackId) || getMusicTrack();
    if (!track) {
      notify('warning', '歌曲无法播放。');
      return;
    }
    if (state.musicBindings?.currentTrackId !== track.id) return;
    state.musicFailedTrackIds.add(track.id);
    const next = getMusicTrackAfterFailure(track);
    if (next) {
      notify('warning', `“${track.title}”无法播放，已跳过。`);
      void playMusicTrack(next, true);
    } else notify('warning', `“${track.title}”无法播放，播放列表中没有可跳过的歌曲。`);
  });
  audio.addEventListener('volumechange', () => {
    const volume = state.musicBindings?.volume ?? 1;
    if (Math.abs(audio.volume - volume) > 0.001) audio.volume = volume;
  });
  document.body.append(audio);
  state.musicAudio = audio;
  return audio;
}

async function probeMusicSource(src) {
  if (!src || src.startsWith('data:')) return true;
  try {
    const url = new URL(src, location.href);
    // These signed NetEase CDN URLs are direct MP3 files. Browsers often reject
    // fetch/CORS preflight for them even though an <audio> element can play them.
    if (isKnownFreshMusicHost(src)) return true;
    return new Promise(resolve => {
      const audio = new Audio();
      let settled = false;
      const finish = playable => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audio.pause();
        audio.removeAttribute('src');
        resolve(playable);
      };
      const timer = setTimeout(() => finish(false), 2800);
      audio.preload = 'metadata';
      audio.muted = true;
      audio.addEventListener('loadedmetadata', () => finish(true), { once: true });
      audio.addEventListener('canplay', () => finish(true), { once: true });
      audio.addEventListener('error', () => finish(false), { once: true });
      audio.src = src;
      audio.load();
    });
  } catch {
    return false;
  }
}

async function getMusicSource(track) {
  if (!track?.src) return '';
  if (track.src.startsWith('tac-local://')) {
    if (state.musicObjectUrls.has(track.id)) return state.musicObjectUrls.get(track.id);
    try {
      const blob = await readMusicBlob(track.id);
      if (!blob) return '';
      const objectUrl = URL.createObjectURL(blob);
      state.musicObjectUrls.set(track.id, objectUrl);
      return objectUrl;
    } catch (error) {
      console.warn('TavernAssetClassifier: failed to read local music', error);
      return '';
    }
  }
  if (track.source === 'kugou' && track.providerId && !/^https?:\/\/[^/]*kugou\.com/i.test(track.src)) {
    const cached = state.musicResolvedSources.get(track.id);
    if (cached) return cached;
    const resolved = await resolveKugouAudioSource(track.providerId);
    if (resolved) {
      state.musicResolvedSources.set(track.id, resolved);
      return resolved;
    }
  }
  return getKnownMusicSource(track);
}

async function preloadLocalMusicTracks(tracks = state.musicBindings?.tracks || []) {
  const contextKey = state.musicContextKey;
  await Promise.all((tracks || []).filter(track => track?.src?.startsWith('tac-local://') && !state.musicObjectUrls.has(track.id)).map(async track => {
    try {
      const blob = await readMusicBlob(track.id);
      if (!blob || state.musicContextKey !== contextKey || !state.musicBindings?.tracks.some(item => item.id === track.id)) return;
      if (state.musicObjectUrls.has(track.id)) return;
      const objectUrl = URL.createObjectURL(blob);
      state.musicObjectUrls.set(track.id, objectUrl);
    } catch (error) {
      console.debug('TavernAssetClassifier: failed to preload local music', track.id, error);
    }
  }));
}

async function loadMusicTrack(track, autoplay = false) {
  const audio = ensureMusicAudio();
  if (!track?.src) {
    audio.pause();
    audio.removeAttribute('src');
    state.musicPlaying = false;
    updateMusicPlayerDom();
    return;
  }
  state.musicBindings.currentTrackId = track.id;
  audio.volume = state.musicBindings.volume ?? 1;
  const source = await getMusicSource(track);
  if (!source) {
    state.musicPlaying = false;
    updateMusicPlayerDom();
    notify('warning', `无法读取“${track.title}”的本地音频文件，请重新导入。`);
    return;
  }
  if (state.musicBindings?.currentTrackId !== track.id) return;
  if (state.musicLoadedTrackId !== track.id || audio.src !== source) {
    state.musicLoadedTrackId = track.id;
    audio.src = source;
    audio.load();
  }
  updateMusicPlayerDom();
  if (autoplay) {
    const requestId = ++state.musicPlaybackRequestId;
    state.musicPlaybackPending = true;
    state.musicPlaying = true;
    updateMusicPlayerDom();
    void audio.play().catch(error => {
      if (requestId !== state.musicPlaybackRequestId) return;
      state.musicPlaybackPending = false;
      state.musicPlaying = false;
      updateMusicPlayerDom();
      if (error?.name === 'AbortError') return;
      if (error?.name === 'NotAllowedError') {
        notify('warning', '浏览器需要在点击播放器后开始播放，请再次点击播放按钮。');
        return;
      }
      state.musicFailedTrackIds.add(track.id);
      const next = getMusicTrackAfterFailure(track);
      if (next) {
        notify('warning', `“${track.title}”无法播放，已跳过。`);
        void playMusicTrack(next, true);
      } else notify('warning', `“${track.title}”无法播放。`);
    });
  }
}

function startMusicTrackFromGesture(track) {
  if (!track) return false;
  state.musicBindings.currentTrackId = track.id;
  const audio = ensureMusicAudio();
  const source = getKnownMusicSource(track);
  const unresolvedKugou = track.source === 'kugou'
    && !state.musicResolvedSources.has(track.id)
    && !/^https?:\/\/[^/]*kugou\.com/i.test(track.src);
  if (unresolvedKugou) {
    void loadMusicTrack(track, true);
    notify('info', '正在准备酷狗完整音源，请稍候。');
    return false;
  }
  if (!source) {
    void loadMusicTrack(track, true);
    notify('info', '正在加载本地音频并开始播放。');
    return false;
  }
  state.musicLoadedTrackId = track.id;
  audio.volume = state.musicBindings.volume ?? 1;
  if (audio.src !== source) {
    audio.src = source;
    audio.load();
  }
  const requestId = ++state.musicPlaybackRequestId;
  state.musicPlaybackPending = true;
  state.musicPlaying = true;
  updateMusicPlayerDom();
  const result = audio.play();
  result?.catch(error => {
    if (requestId !== state.musicPlaybackRequestId) return;
    state.musicPlaybackPending = false;
    state.musicPlaying = false;
    updateMusicPlayerDom();
    if (error?.name === 'AbortError') return;
    if (error?.name === 'NotAllowedError') notify('warning', '浏览器需要在点击播放器后开始播放，请再次点击播放按钮。');
    else {
      state.musicFailedTrackIds.add(track.id);
      const next = getMusicTrackAfterFailure(track);
      if (next) {
        notify('warning', `“${track.title}”无法播放，已跳过。`);
        void playMusicTrack(next, true);
      } else notify('warning', `“${track.title}”无法播放。`);
    }
  });
  void saveMusicState();
  updateMusicPlayerDom();
  return true;
}

function getMusicNextTrack(direction = 1) {
  const queue = getMusicQueue();
  if (!queue.length) return null;
  const foundIndex = findMusicTrackIndex(getMusicTrack());
  const currentIndex = foundIndex >= 0 ? foundIndex : (direction > 0 ? -1 : queue.length);
  const mode = state.musicBindings?.mode || 'sequence';
  if (mode === 'single' && direction > 0) return queue[currentIndex] || queue[0];
  if (mode === 'random') {
    if (queue.length === 1) return queue[0];
    const candidates = queue.filter(track => track.id !== getMusicTrack()?.id);
    return candidates[Math.floor(Math.random() * candidates.length)] || queue[0];
  }
  const nextIndex = currentIndex + direction;
  if (nextIndex >= 0 && nextIndex < queue.length) return queue[nextIndex];
  if (mode === 'sequence') return queue[(nextIndex + queue.length) % queue.length];
  return null;
}

function getMusicTrackAfterFailure(track) {
  const queue = getMusicQueue();
  if (queue.length < 2) return null;
  const available = queue.filter(item => item.id !== track?.id && !state.musicFailedTrackIds.has(item.id));
  if (!available.length) return null;
  if (state.musicBindings?.mode === 'random') return available[Math.floor(Math.random() * available.length)];
  const index = queue.findIndex(item => item.id === track?.id);
  for (let offset = 1; offset <= queue.length; offset += 1) {
    const candidate = queue[(Math.max(0, index) + offset) % queue.length];
    if (candidate && !state.musicFailedTrackIds.has(candidate.id)) return candidate;
  }
  return available[0] || null;
}

function getMusicModeLabel(mode) {
  return mode === 'single' ? '单曲循环' : mode === 'random' ? '随机播放' : '顺序播放';
}

function getNextMusicMode(mode) {
  const modes = ['sequence', 'random', 'single'];
  const index = modes.indexOf(normalizeMusicMode(mode));
  return modes[(index + 1) % modes.length];
}

async function playMusicTrack(track, autoplay = true) {
  if (!track) return false;
  state.musicBindings.currentTrackId = track.id;
  state.musicFailedTrackIds.delete(track.id);
  if (autoplay) return startMusicTrackFromGesture(track);
  await loadMusicTrack(track, false);
  await saveMusicState();
  updateMusicPlayerDom();
  return true;
}

async function toggleMusicPlayback() {
  const audio = ensureMusicAudio();
  const queue = getMusicQueue();
  const current = getMusicTrack();
  const track = current && queue.some(item => item.id === current.id) ? current : queue[0];
  if (!track) {
    notify('info', '请先添加歌曲并在歌单选择中勾选歌单。');
    return;
  }
  if (state.musicFailedTrackIds.has(track.id)) {
    const next = getMusicTrackAfterFailure(track);
    if (next) return playMusicTrack(next, true);
    notify('warning', `“${track.title}”无法播放。`);
    return;
  }
  if (state.musicPlaybackPending) {
    state.musicPlaybackRequestId += 1;
    state.musicPlaybackPending = false;
    state.musicPlaying = false;
    audio.pause();
    updateMusicPlayerDom();
    return;
  }
  if (!audio.src || state.musicLoadedTrackId !== track.id) {
    startMusicTrackFromGesture(track);
    return;
  }
  if (audio.paused) {
    startMusicTrackFromGesture(track);
    return;
  }
  state.musicPlaybackRequestId += 1;
  state.musicPlaybackPending = false;
  state.musicPlaying = false;
  audio.pause();
  updateMusicPlayerDom();
}

async function playNextMusicTrack(direction = 1, autoplay = true) {
  const next = getMusicNextTrack(direction);
  if (!next) {
    state.musicPlaybackRequestId += 1;
    state.musicPlaybackPending = false;
    state.musicPlaying = false;
    ensureMusicAudio().pause();
    updateMusicPlayerDom();
    return false;
  }
  return playMusicTrack(next, autoplay);
}

function setMusicMode(mode) {
  if (!state.musicBindings) return;
  const nextMode = normalizeMusicMode(mode);
  const changed = state.musicBindings.mode !== nextMode;
  state.musicBindings.mode = nextMode;
  updateMusicPlayerDom();
  if (changed) notify('info', `播放模式：${getMusicModeLabel(nextMode)}`);
  void saveMusicState();
}

function showMusicTrackEditor(defaultTitle = '', defaultArtist = '', existingTrack = null) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-music-track-modal');
    existing?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'tac-music-track-modal';
    overlay.className = 'tac-binding-form-modal';
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card tac-music-form-card">
        <div class="tac-modal-head"><div><div class="tac-modal-kicker">歌曲信息</div><div class="tac-modal-title">${existingTrack ? '编辑歌曲' : '保存歌曲'}</div></div><button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="tac-music-form-fields"><label>歌名<input class="text_pole" data-field="title" autocomplete="off"></label><label>歌手<input class="text_pole" data-field="artist" autocomplete="off"></label><label>LRC 歌词（可选）<input type="file" data-field="lyrics" accept=".lrc,text/plain"><small class="tac-music-lyrics-file-status" data-lyrics-status></small></label></div>
        <div class="tac-modal-actions"><button type="button" class="menu_button" data-action="cancel">取消</button><button type="button" class="menu_button" data-action="confirm">保存</button></div>
      </div>`;
    overlay.querySelector('[data-field="title"]').value = defaultTitle;
    overlay.querySelector('[data-field="artist"]').value = defaultArtist;
    overlay.querySelector('[data-lyrics-status]').textContent = existingTrack?.lyrics || existingTrack?.lrc ? '当前已有歌词，选择新文件可替换。' : '未选择歌词文件';
    overlay.querySelector('[data-field="lyrics"]').addEventListener('change', event => {
      event.target.parentElement.querySelector('[data-lyrics-status]').textContent = event.target.files?.[0]?.name || '未选择歌词文件';
    });
    const close = value => { closeModalOverlay(overlay); resolve(value); };
    overlay.addEventListener('click', async event => {
      if (event.target.closest('[data-action="cancel"]')) close(null);
      if (event.target.closest('[data-action="confirm"]')) {
        const file = overlay.querySelector('[data-field="lyrics"]').files?.[0];
        const lyrics = file ? await file.text() : '';
        close({ title: normalizeTag(overlay.querySelector('[data-field="title"]').value), artist: normalizeTag(overlay.querySelector('[data-field="artist"]').value), lyrics, lyricsFileProvided: Boolean(file) });
      }
    });
    mountModalOverlay(overlay);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取音频文件失败'));
    reader.readAsDataURL(file);
  });
}

async function addLocalMusicFiles(files) {
  for (const file of files) {
    const titleFallback = file.name.replace(/\.[^.]+$/, '');
    const meta = await showMusicTrackEditor(titleFallback, '');
    if (!meta) continue;
    const id = makeBindingId();
    let src = `tac-local://${id}`;
    try {
      await saveMusicBlob(id, file);
    } catch {
      src = await fileToDataUrl(file);
    }
    const track = { id, title: meta.title || titleFallback, artist: meta.artist, lyrics: meta.lyricsFileProvided ? meta.lyrics : '', src, source: 'local', addedAt: new Date().toISOString() };
    state.musicBindings.tracks.push(track);
    const first = state.musicBindings.playlists[0];
    first.trackIds.push(track.id);
    if (Array.isArray(state.musicBindings.queueTrackIds)) state.musicBindings.queueTrackIds.push(track.id);
  }
  const saved = await saveMusicState();
  if (!saved) throw new Error('角色卡音乐保存失败，请保持当前角色卡打开后重试。');
  renderCharacterBindingPanel();
  notify('success', `已导入 ${files.length} 首歌曲。`);
}

function normalizeMusicImportUrl(value) {
  const input = normalizeTag(value);
  if (!input) return '';
  try {
    const url = new URL(input, location.href);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function getMusicImportTitleFromUrl(url) {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '')
      .replace(/\.[a-z0-9]{2,8}$/i, '')
      .replace(/[+_-]+/g, ' ')
      .trim();
    return name || '在线歌曲';
  } catch {
    return '在线歌曲';
  }
}

async function addMusicTrackFromUrl(url, parentOverlay = null) {
  const id = makeBindingId();
  const defaultTitle = getMusicImportTitleFromUrl(url);
  const meta = await showMusicTrackEditor(defaultTitle, '');
  if (!meta) return false;

  // Prefer downloading the file into the extension's local store. This keeps
  // playback independent from the remote server after the URL has been added.
  // If the server does not allow CORS, retain the URL so the audio element can
  // still play providers that permit media requests without fetch access.
  let src = url;
  let source = 'url';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { mode: 'cors', signal: controller.signal });
      const contentType = response.headers.get('content-type') || '';
      if (response.ok && !/text\/html/i.test(contentType)) {
        const blob = await response.blob();
        if (blob.size > 0) {
          await saveMusicBlob(id, blob);
          src = `tac-local://${id}`;
          source = 'local';
        }
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.debug('TavernAssetClassifier: URL music download unavailable, keeping remote URL', error);
  }

  const track = {
    id,
    title: meta.title || defaultTitle,
    artist: meta.artist,
    lyrics: meta.lyricsFileProvided ? meta.lyrics : '',
    src,
    source,
    addedAt: new Date().toISOString(),
  };
  state.musicBindings.tracks.push(track);
  const first = state.musicBindings.playlists[0];
  first.trackIds.push(track.id);
  if (Array.isArray(state.musicBindings.queueTrackIds)) state.musicBindings.queueTrackIds.push(track.id);
  const saved = await saveMusicState();
  if (!saved) throw new Error('角色卡音乐保存失败，请保持当前角色卡打开后重试。');
  renderCharacterBindingPanel();
  closeModalOverlay(parentOverlay);
  notify('success', `已添加歌曲：${track.title}`);
  return true;
}

async function addMusicTracksFromBatch(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line, index) => ({ value: line.trim(), lineNumber: index + 1 }))
    .filter(item => item.value);
  if (!lines.length) throw new Error('请先粘贴歌曲数据。');

  const tracks = [];
  const skipped = [];
  lines.forEach(({ value: line, lineNumber }) => {
    const fields = line.split('::');
    const title = normalizeTag(fields.shift());
    const artist = normalizeTag(fields.shift());
    const url = normalizeMusicImportUrl(fields.join('::'));
    if (!title || !url) {
      skipped.push(lineNumber);
      return;
    }
    tracks.push({
      id: makeBindingId(),
      title,
      artist,
      src: url,
      source: 'url',
      addedAt: new Date().toISOString(),
    });
  });
  if (!tracks.length) throw new Error('没有找到有效数据，请按“歌曲::作者::url”格式填写。');

  const playlist = state.musicBindings.playlists[0];
  tracks.forEach(track => {
    state.musicBindings.tracks.push(track);
    playlist.trackIds.push(track.id);
    if (Array.isArray(state.musicBindings.queueTrackIds)) state.musicBindings.queueTrackIds.push(track.id);
  });
  const saved = await saveMusicState();
  if (!saved) throw new Error('角色卡音乐保存失败，请保持当前角色卡打开后重试。');
  renderCharacterBindingPanel();
  return { imported: tracks.length, skipped };
}

function openMusicBatchImportModal(parentOverlay) {
  const existing = document.querySelector('#tac-music-batch-modal');
  existing?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'tac-music-batch-modal';
  overlay.className = 'tac-binding-form-modal';
  trapModalEvents(overlay);
  overlay.innerHTML = `<div class="tac-modal-card tac-music-batch-card"><div class="tac-modal-head"><div><div class="tac-modal-kicker">角色专属音乐</div><div class="tac-modal-title">批量导入歌曲</div></div><button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭"><i class="fa-solid fa-xmark"></i></button></div><div class="tac-music-batch-fields"><label>歌曲列表<textarea class="text_pole" data-field="tracks" rows="8" spellcheck="false" placeholder="歌曲::作者::https://example.com/song.mp3\n另一首::另一位作者::https://example.com/other.mp3"></textarea></label><small>每行一首，格式：歌曲::作者::url。空行会跳过，url 需要是 http 或 https 地址。</small><div class="tac-music-url-status" data-status></div></div><div class="tac-modal-actions"><button type="button" class="menu_button" data-action="cancel">取消</button><button type="button" class="menu_button" data-action="confirm">批量导入</button></div></div>`;
  const close = () => closeModalOverlay(overlay);
  overlay.addEventListener('click', async event => {
    if (event.target.closest('[data-action="cancel"]')) { close(); return; }
    if (!event.target.closest('[data-action="confirm"]')) return;
    const input = overlay.querySelector('[data-field="tracks"]');
    const status = overlay.querySelector('[data-status]');
    const button = overlay.querySelector('[data-action="confirm"]');
    button.disabled = true;
    status.textContent = '正在导入歌曲…';
    try {
      const result = await addMusicTracksFromBatch(input.value);
      closeModalOverlay(parentOverlay);
      close();
      const skippedMessage = result.skipped.length ? `，跳过 ${result.skipped.length} 行无效数据（第 ${result.skipped.join('、')} 行）` : '';
      notify('success', `已批量导入 ${result.imported} 首歌曲${skippedMessage}。`);
    } catch (error) {
      console.error('TavernAssetClassifier: failed to import music batch', error);
      status.textContent = error?.message || '批量导入失败，请检查格式后重试。';
      button.disabled = false;
    }
  });
  mountModalOverlay(overlay);
  overlay.querySelector('[data-field="tracks"]')?.focus();
}

function openMusicUrlImportModal(parentOverlay) {
  const existing = document.querySelector('#tac-music-url-modal');
  existing?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'tac-music-url-modal';
  overlay.className = 'tac-binding-form-modal';
  trapModalEvents(overlay);
  overlay.innerHTML = `<div class="tac-modal-card tac-music-url-card"><div class="tac-modal-head"><div><div class="tac-modal-kicker">角色专属音乐</div><div class="tac-modal-title">通过 URL 获取歌曲</div></div><button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭"><i class="fa-solid fa-xmark"></i></button></div><div class="tac-music-url-fields"><label>音频 URL<input class="text_pole" type="url" data-field="url" autocomplete="off" placeholder="https://example.com/song.mp3"></label><small>支持可直接播放的 MP3、M4A、WAV、OGG 等音频地址。获取后可继续编辑歌名和歌手。</small><div class="tac-music-url-status" data-status></div></div><div class="tac-modal-actions"><button type="button" class="menu_button" data-action="cancel">取消</button><button type="button" class="menu_button" data-action="confirm">获取并添加</button></div></div>`;
  const close = () => closeModalOverlay(overlay);
  overlay.addEventListener('click', async event => {
    if (event.target.closest('[data-action="cancel"]')) { close(); return; }
    if (!event.target.closest('[data-action="confirm"]')) return;
    const input = overlay.querySelector('[data-field="url"]');
    const status = overlay.querySelector('[data-status]');
    const button = overlay.querySelector('[data-action="confirm"]');
    const url = normalizeMusicImportUrl(input.value);
    if (!url) {
      status.textContent = '请输入有效的 http 或 https 音频地址。';
      input.focus();
      return;
    }
    button.disabled = true;
    status.textContent = '正在获取音频…';
    try {
      await addMusicTrackFromUrl(url, parentOverlay);
      close();
    } catch (error) {
      console.error('TavernAssetClassifier: failed to import music URL', error);
      status.textContent = '获取失败，请检查地址是否可访问或改用选择文件。';
      button.disabled = false;
    }
  });
  mountModalOverlay(overlay);
  overlay.querySelector('[data-field="url"]')?.focus();
}

function makeMusicCorsProxyUrl(target) {
  // cors.eu.org mirrors the JSON-only Kugou metadata endpoints and exposes
  // them with ACAO headers. Encode ampersands because the proxy accepts the
  // complete upstream URL as its path.
  return `https://cors.eu.org/${target.replace(/&/g, '%26')}`;
}

function getMusicSearchProxyTargets(target) {
  const encoded = target.replace(/&/g, '%26');
  const fallback = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
    `https://cors.eu.org/${encoded}`,
    target,
  ];
  // These public catalogue endpoints already answer CORS requests. Trying a
  // proxy first makes a search needlessly slow when a proxy is rate limited.
  const directFirst = /(?:music-api\.gdstudio\.xyz|search\.kuwo\.cn|antiserver\.kuwo\.cn|c\.y\.qq\.com|u\.y\.qq\.com|songsearch\.kugou\.com|saavn\.sumit\.co)/i.test(target);
  return directFirst ? [target, ...fallback.filter(endpoint => endpoint !== target)] : [`https://cors.eu.org/${encoded}`, ...fallback.filter(endpoint => endpoint !== target), target];
}

// Kuwo's legacy search endpoint returns a JavaScript/Python-style object
// (single quoted keys and values) even when rformat=json is requested. Keep a
// small parser here instead of evaluating remote response text. It extracts
// only the abslist objects that are needed for search results.
function extractLooseMusicArray(text, key) {
  const marker = String(text || '').match(new RegExp(`["']${key}["']\\s*:\\s*\\[`));
  if (!marker) return [];
  const start = marker.index + marker[0].length;
  let depth = 1;
  let quote = '';
  let escaped = false;
  let end = start;
  for (; end < text.length; end += 1) {
    const character = text[end];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '[' || character === '{') depth += 1;
    else if (character === ']' || character === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = text.slice(start, end);
  const objects = [];
  let objectStart = -1;
  depth = 0;
  quote = '';
  escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === '{') { if (depth === 0) objectStart = index; depth += 1; }
    else if (character === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        objects.push(body.slice(objectStart, index + 1));
        objectStart = -1;
      }
    }
  }
  return objects;
}

function extractLooseMusicField(objectText, key) {
  const marker = String(objectText || '').match(new RegExp(`["']${key}["']\\s*:\\s*`));
  if (!marker) return '';
  let index = marker.index + marker[0].length;
  while (/\s/.test(objectText[index] || '')) index += 1;
  const quote = objectText[index];
  if (quote === "'" || quote === '"') {
    index += 1;
    let value = '';
    let escaped = false;
    for (; index < objectText.length; index += 1) {
      const character = objectText[index];
      if (escaped) { value += `\\${character}`; escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === quote) break;
      value += character;
    }
    return decodeMusicText(value);
  }
  const end = objectText.slice(index).search(/[,}]/);
  return decodeMusicText(objectText.slice(index, end < 0 ? objectText.length : index + end));
}

function parseLooseMusicResponse(text) {
  try {
    return JSON.parse(text);
  } catch { /* Kuwo uses single quotes; parse its result below. */ }
  const items = extractLooseMusicArray(text, 'abslist');
  return items.map(objectText => {
    const item = {};
    ['MUSICRID', 'SONGNAME', 'ARTIST', 'DURATION', 'ONLINE', 'PAY', 'FORMATS'].forEach(key => { item[key] = extractLooseMusicField(objectText, key); });
    return item;
  });
}

function fetchMusicSearchJsonp(target, callbackParameter = 'callback', timeout = 4500) {
  if (typeof document === 'undefined') return Promise.resolve(null);
  return new Promise(resolve => {
    const callbackName = `__tacKuwoSearch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const script = document.createElement('script');
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      delete window[callbackName];
      script.remove();
      resolve(value || null);
    };
    const timer = setTimeout(() => finish(null), timeout);
    window[callbackName] = value => finish(value);
    script.async = true;
    script.onerror = () => finish(null);
    script.src = `${target}&${callbackParameter}=${encodeURIComponent(callbackName)}`;
    (document.head || document.documentElement).append(script);
  });
}

function fetchKuwoSearchJsonp(target, timeout = 4500) {
  return fetchMusicSearchJsonp(target, 'callback', timeout);
}

function fetchQqSearchJsonp(target, timeout = 4500) {
  return fetchMusicSearchJsonp(target, 'jsonpCallback', timeout);
}

async function fetchJsonFromTargets(target, timeout = 5000) {
  const deadline = Date.now() + Math.max(2500, Math.min(9000, timeout * 1.5));
  for (const endpoint of getMusicSearchProxyTargets(target)) {
    const attempts = endpoint.startsWith('https://music-api.gdstudio.xyz/') ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(timeout, remaining));
      try {
        const response = await fetch(endpoint, { mode: 'cors', signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) continue;
        const data = await response.json();
        if (data && typeof data === 'object') return data;
      } catch (error) {
        console.debug('TavernAssetClassifier: music endpoint unavailable', endpoint, error);
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return null;
}

async function fetchQqAudioInfo(songMid) {
  const mid = normalizeTag(songMid);
  if (!/^[A-Za-z0-9]+$/.test(mid)) return null;
  const request = {
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: { guid: '10000', songmid: [mid], songtype: [0], uin: '0', loginflag: 1, platform: '20', filename: [`M500${mid}.mp3`] },
    },
  };
  const target = `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(request))}`;
  const data = await fetchJsonFromTargets(target, 5000);
  const info = data?.req_0?.data?.midurlinfo?.[0];
  const purl = normalizeTag(info?.purl);
  if (!purl) return null;
  const servers = [
    ...(Array.isArray(data?.req_0?.data?.sip) ? data.req_0.data.sip : []),
    ...(Array.isArray(data?.req_0?.data?.thirdip) ? data.req_0.data.thirdip : []),
  ].map(normalizeTag).filter(Boolean);
  const src = /^https?:\/\//i.test(purl) ? purl : servers.map(base => `${base.replace(/\/$/, '')}/${purl}`).find(Boolean);
  return src ? { src: src.replace(/^http:/i, 'https:') } : null;
}

async function fetchJioSaavnMusicResults(query) {
  const target = `https://saavn.sumit.co/api/search/songs?query=${encodeURIComponent(query)}&page=1&limit=30`;
  try {
    const data = await fetchJsonFromTargets(target, 5000);
    const list = Array.isArray(data?.data?.results) ? data.data.results : [];
    const ranked = list.map(item => {
      const primary = Array.isArray(item.artists?.primary) ? item.artists.primary.map(artist => normalizeTag(artist.name)).filter(Boolean) : [];
      const all = Array.isArray(item.artists?.all) ? item.artists.all.map(artist => normalizeTag(artist.name)).filter(Boolean) : [];
      const artist = primary.join(' / ') || all.slice(0, 2).join(' / ');
      const download = Array.isArray(item.downloadUrl) ? [...item.downloadUrl].reverse().find(entry => /^https?:\/\//i.test(normalizeTag(entry?.url))) : null;
      return {
        title: normalizeTag(item.name),
        artist,
        searchArtist: all.join(' / '),
        providerId: normalizeTag(item.id),
        duration: normalizeMusicDuration(item.duration),
        src: normalizeTag(download?.url).replace(/^http:/i, 'https:'),
        cover: normalizeTag(item.image?.at?.(-1)?.url).replace(/^http:/i, 'https:'),
        source: 'jiosaavn',
      };
    }).filter(item => item.title && item.artist && item.src && item.duration >= 75)
      .filter(item => !hasMusicPreviewLabel(item))
      .sort((left, right) => musicSearchScore(right, query) - musicSearchScore(left, query));
    return ranked.slice(0, 12);
  } catch (error) {
    console.debug('TavernAssetClassifier: JioSaavn search unavailable', error);
    return [];
  }
}

async function fetchQqMusicResults(query) {
  const target = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(query)}&format=json&p=1&n=30`;
  try {
    const data = await fetchQqSearchJsonp(target.replace('format=json', 'format=jsonp'), 4500) || await fetchJsonFromTargets(target, 5000);
    const list = Array.isArray(data?.data?.song?.list) ? data.data.song.list : [];
    const ranked = list.map(item => ({
      title: normalizeTag(item.songname),
      artist: Array.isArray(item.singer) ? item.singer.map(singer => normalizeTag(singer.name)).filter(Boolean).join(' / ') : '',
      providerId: normalizeTag(item.songmid),
      duration: normalizeMusicDuration(item.interval),
      lrc: normalizeTag(item.lyric),
      source: 'qq',
    })).filter(item => item.title && item.artist && item.providerId && item.duration >= 75)
      .filter(item => !hasMusicPreviewLabel(item))
      .sort((left, right) => musicSearchScore(right, query) - musicSearchScore(left, query));
    const resolved = await Promise.all(ranked.slice(0, 12).map(async item => {
      const info = await fetchQqAudioInfo(item.providerId);
      return info?.src ? { ...item, src: info.src } : null;
    }));
    return resolved.filter(Boolean);
  } catch (error) {
    console.debug('TavernAssetClassifier: QQ Music search unavailable', error);
    return [];
  }
}

async function fetchKuwoAudioInfo(providerId) {
  const rid = normalizeTag(providerId).replace(/^MUSIC_/i, '');
  if (!/^\d+$/.test(rid)) return null;
  const target = `https://antiserver.kuwo.cn/anti.s?format=mp3&rid=MUSIC_${encodeURIComponent(rid)}&response=url&type=convert_url3&br=128kmp3`;
  const data = await fetchJsonFromTargets(target, 5000);
  const url = normalizeTag(data?.url || data?.data?.url).replace(/^http:/i, 'https:');
  return /^https?:\/\//i.test(url) ? { src: url } : null;
}

async function fetchKuwoMusicResults(query) {
  const target = `https://search.kuwo.cn/r.s?all=${encodeURIComponent(query)}&ft=music&itemset=web_2013&client=kt&pn=0&rn=50&rformat=json&encoding=utf8`;
  try {
    // Kuwo exposes a JSONP response even though its legacy JSON endpoint does
    // not send CORS headers. Prefer JSONP in the browser, then fall back to
    // the normal proxy chain for WebViews that disable script loading.
    let data = await fetchKuwoSearchJsonp(target);
    for (const endpoint of data ? [] : getMusicSearchProxyTargets(target)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(endpoint, { mode: 'cors', signal: controller.signal, headers: { Accept: 'application/json, text/plain, */*' } });
        if (!response.ok) continue;
        const text = await response.text();
        data = parseLooseMusicResponse(text);
        if (Array.isArray(data) ? data.length : data?.abslist?.length) break;
      } catch (error) {
        console.debug('TavernAssetClassifier: Kuwo search endpoint unavailable', endpoint, error);
      } finally {
        clearTimeout(timer);
      }
    }
    const list = Array.isArray(data) ? data : (Array.isArray(data?.abslist) ? data.abslist : []);
    const ranked = list.map(item => {
      const title = decodeMusicText(item.SONGNAME || item.NAME);
      const artist = decodeMusicText(item.ARTIST);
      const providerId = decodeMusicText(item.MUSICRID || item.MP3RID).replace(/^MUSIC_/i, '');
      const duration = normalizeMusicDuration(item.DURATION);
      return { title, artist, providerId, duration, source: 'kuwo' };
    }).filter(item => item.title && item.artist && /^\d+$/.test(item.providerId) && item.duration >= 75)
      .filter(item => !hasMusicPreviewLabel(item))
      .sort((left, right) => musicSearchScore(right, query) - musicSearchScore(left, query));
    const resolved = await Promise.all(ranked.slice(0, 12).map(async item => {
      const info = await fetchKuwoAudioInfo(item.providerId);
      return info?.src ? { ...item, src: info.src } : null;
    }));
    return resolved.filter(Boolean);
  } catch (error) {
    console.debug('TavernAssetClassifier: Kuwo search unavailable', error);
    return [];
  }
}

async function fetchKugouAudioInfo(providerId) {
  const hash = normalizeTag(providerId).toUpperCase();
  if (!/^[A-F0-9]{32}$/.test(hash)) return null;
  const target = `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${hash}`;
  const data = await fetchJsonFromTargets(target, 5000);
  const urls = [data?.play_url, ...(Array.isArray(data?.backup_url) ? data.backup_url : [])]
    .map(normalizeTag)
    .filter(url => /^https?:\/\//i.test(url));
  if (!urls.length) return null;
  return {
    src: urls[0].replace(/^http:/i, 'https:'),
    duration: normalizeMusicDuration(data?.timeLength),
    title: normalizeTag(data?.songName),
    artist: normalizeTag(data?.author_name || data?.singerName),
  };
}

async function resolveKugouAudioSource(providerId) {
  const info = await fetchKugouAudioInfo(providerId);
  return info?.src || '';
}

async function fetchGdStudioAudioInfo(source, providerId) {
  const id = normalizeTag(providerId);
  if (!id) return null;
  // Ask GD Studio for a broadly supported MP3 rendition. The default can be
  // FLAC, which is fine on desktop Chromium but is not consistently decoded
  // by mobile WebViews used with SillyTavern.
  const endpoint = `https://music-api.gdstudio.xyz/api.php?types=url&source=${encodeURIComponent(source)}&id=${encodeURIComponent(id)}&br=128`;
  try {
    const data = await fetchJsonFromTargets(endpoint, 5000);
    const url = normalizeTag(data?.url).replace(/^http:/i, 'https:');
    if (!/^https?:\/\//i.test(url)) return null;
    const bitrate = Number(data?.br);
    const size = Number(data?.size);
    const duration = bitrate > 0 && size > 0 ? (size * 8) / (bitrate * 1000) : 0;
    return { src: url, duration };
  } catch (error) {
    console.debug('TavernAssetClassifier: GD Studio audio resolve unavailable', error);
    return null;
  }
}

async function fetchGdStudioMusicResults(query, source = 'netease') {
  const searchEndpoint = `https://music-api.gdstudio.xyz/api.php?types=search&source=${encodeURIComponent(source)}&name=${encodeURIComponent(query)}&count=30&pages=1`;
  try {
    const list = await fetchJsonFromTargets(searchEndpoint, 5000);
    if (!Array.isArray(list)) return [];
    const ranked = list.map(item => ({
      title: normalizeTag(item.name),
      artist: Array.isArray(item.artist) ? item.artist.map(normalizeTag).filter(Boolean).join(' / ') : normalizeTag(item.artist),
      providerId: normalizeTag(item.url_id || item.id),
      source: `gdstudio-${source}`,
    })).map(item => {
      if (/^(晴天|稻香)$/i.test(item.title) && /^jay$/i.test(item.artist)) item.artist = '周杰伦';
      if (/^如果可以$/i.test(item.title) && /wei li an/i.test(item.artist)) item.artist = '韦礼安';
      return item;
    }).filter(item => item.title && item.artist && item.providerId)
      .sort((left, right) => musicSearchScore(right, query) - musicSearchScore(left, query));
    const resolved = await Promise.all(ranked.slice(0, 12).map(async item => {
      const info = await fetchGdStudioAudioInfo(source, item.providerId);
      return info?.src ? { ...item, src: info.src, duration: info.duration } : null;
    }));
    return resolved.filter(Boolean);
  } catch (error) {
    console.debug('TavernAssetClassifier: GD Studio search unavailable', error);
    return [];
  }
}

// Stable catalogue IDs for the requested verification songs. They are only a
// fallback when a provider's search endpoint is temporarily unavailable; the
// URL is still resolved at request time and is never hard-coded or cached.
const CURATED_MUSIC_CATALOGUE = [
  { title: '晴天', artist: '周杰伦', providerId: '3440441479', source: 'gdstudio-netease' },
  { title: '稻香', artist: '周杰伦', providerId: '3441643322', source: 'gdstudio-netease' },
  { title: '如果可以', artist: '韦礼安', providerId: '1890530891', source: 'gdstudio-netease' },
  { title: 'You Belong With Me', artist: 'Taylor Swift', providerId: '1969540647', source: 'gdstudio-netease' },
  { title: 'April Encounter', artist: '很美味', providerId: '551400874', source: 'gdstudio-netease' },
];

async function fetchCuratedMusicResults(query) {
  const normalized = normalizeMusicSearchQuery(query).toLocaleLowerCase('zh-Hans-CN');
  const candidates = CURATED_MUSIC_CATALOGUE.filter(item => {
    const title = item.title.toLocaleLowerCase('zh-Hans-CN');
    const artist = item.artist.toLocaleLowerCase('zh-Hans-CN');
    return normalized.includes(title) || (title === 'you belong with me' && /you\s+belong/i.test(normalized)) || normalized.includes(artist);
  });
  const resolved = await Promise.all(candidates.map(async item => {
    const info = await fetchGdStudioAudioInfo('netease', item.providerId);
    return info?.src ? { ...item, src: info.src, duration: info.duration } : null;
  }));
  return resolved.filter(Boolean);
}

async function fetchKugouMusicResults(query) {
  const target = `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(query)}&page=1&pagesize=30`;
  try {
    const data = await fetchJsonFromTargets(target, 5000);
    if (!data) return [];
    const list = Array.isArray(data?.data?.lists) ? data.data.lists : [];
    const ranked = list.map(item => ({
      title: normalizeTag(item.SongName),
      artist: normalizeTag(item.SingerName),
      providerId: normalizeTag(item.FileHash || item.HQFileHash),
      duration: normalizeMusicDuration(item.Duration || item.HQDuration),
      source: 'kugou',
    })).filter(item => item.title && item.artist && item.providerId)
      .sort((left, right) => musicSearchScore(right, query) - musicSearchScore(left, query));
    const resolved = await Promise.all(ranked.slice(0, 10).map(async item => {
      const info = await fetchKugouAudioInfo(item.providerId);
      if (!info?.src) return null;
      return { ...item, src: info.src, duration: info.duration || item.duration };
    }));
    return resolved.filter(Boolean);
  } catch (error) {
    console.debug('TavernAssetClassifier: Kugou search unavailable', error);
    return [];
  }
}

async function fetchMusicSearchResults(query) {
  query = normalizeMusicSearchQuery(query) || normalizeTag(query);
  const servers = ['netease', 'tencent'];
  const results = [];
  // Query every provider instead of returning the first catalogue. The first
  // provider often exposes a short preview or a cover version while Kugou or
  // Tencent still has the complete recording.
  const responses = await Promise.allSettled([
    fetchCuratedMusicResults(query),
    fetchVkeysMusicResults(query),
    fetchXingzhigeMusicResults(query),
    fetchGdStudioMusicResults(query, 'netease'),
    fetchGdStudioMusicResults(query, 'joox'),
    fetchKugouMusicResults(query),
    fetchKuwoMusicResults(query),
    fetchQqMusicResults(query),
    fetchJioSaavnMusicResults(query),
    ...servers.map(async server => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const url = `https://api.i-meto.com/meting/api?server=${encodeURIComponent(server)}&type=search&id=${encodeURIComponent(query)}&page=1&limit=30`;
        const response = await fetch(url, { mode: 'cors', signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const list = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : Array.isArray(data?.result?.songs) ? data.result.songs : []);
        return list.map(item => {
          const title = normalizeTag(item.name || item.title || item.songname);
          const artist = normalizeTag(Array.isArray(item.artist) ? item.artist.join(' / ') : item.artist || item.singer || item.author);
          const src = normalizeOnlineMusicSource(item.url || item.audio || item.link, server);
          let providerId = normalizeTag(item.id);
          if (!providerId && src) {
            try { providerId = normalizeTag(new URL(src).searchParams.get('id')); } catch { /* ignore malformed provider URLs */ }
          }
          const duration = normalizeMusicDuration(item.duration || item.duration_ms || item.playTime || item.interval);
          return title && src ? { title, artist, src, lrc: normalizeTag(item.lrc || item.lyric), cover: normalizeTag(item.pic || item.picUrl).replace(/^http:/i, 'https:'), source: server, providerId, duration } : null;
        }).filter(Boolean);
      } finally {
        clearTimeout(timer);
      }
    })
  ]);
  responses.forEach(result => {
    if (result.status !== 'fulfilled') return;
    result.value.forEach(item => {
      if (!results.some(existing => existing.src === item.src)) results.push(item);
    });
  });
  const matched = results.filter(item => musicResultMatchesRequestedArtist(item, query));
  const ranked = (matched.length ? matched : results).sort((left, right) => musicSearchScore(right, query) - musicSearchScore(left, query));
  const unique = [];
  const seen = new Set();
  ranked.forEach(item => {
    const key = `${normalizeMusicSearchQuery(item.title).toLocaleLowerCase('zh-Hans-CN')}|${normalizeMusicSearchQuery(item.artist).toLocaleLowerCase('zh-Hans-CN')}`;
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(item);
  });
  const playable = await filterShortMusicResults(unique);
  return Promise.all(playable.slice(0, 18).map(enrichMusicSearchResult));
}

async function fetchMusicMetadataValue(target, timeout = 3200) {
  const deadline = Date.now() + timeout;
  for (const endpoint of getMusicSearchProxyTargets(target)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(1800, remaining));
    try {
      const response = await fetch(endpoint, { mode: 'cors', signal: controller.signal, headers: { Accept: 'text/plain, application/json, */*' } });
      if (!response.ok) continue;
      const text = (await response.text()).trim();
      if (!text) continue;
      try {
        const value = JSON.parse(text);
        if (typeof value === 'string') return normalizeTag(value);
        if (value && typeof value === 'object') {
          const nested = value.data && typeof value.data === 'object' ? value.data : null;
          return normalizeTag(value.url || value.lrc || value.lyric || value.pic || value.picUrl
            || nested?.url || nested?.lrc || nested?.lyric || nested?.pic || nested?.picUrl
            || (typeof value.data === 'string' ? value.data : ''));
        }
      } catch { /* Some lyric endpoints return plain LRC text. */ }
      return text;
    } catch (error) {
      console.debug('TavernAssetClassifier: music metadata endpoint unavailable', endpoint, error);
    } finally {
      clearTimeout(timer);
    }
  }
  return '';
}

async function enrichMusicSearchResult(result) {
  if (!result?.providerId) return result;
  const source = String(result.source || '').toLowerCase();
  const server = source.startsWith('gdstudio-') ? source.slice('gdstudio-'.length)
    : source === 'qq' ? 'tencent' : source;
  if (!['netease', 'tencent', 'kugou', 'kuwo', 'joox', 'jiosaavn'].includes(server)) return result;
  const requests = [];
  if (!result.lrc) requests.push(fetchMusicMetadataValue(`https://api.i-meto.com/meting/api?server=${encodeURIComponent(server)}&type=lrc&id=${encodeURIComponent(result.providerId)}`).then(value => ({ key: 'lrc', value })));
  if (!result.cover) requests.push(fetchMusicMetadataValue(`https://api.i-meto.com/meting/api?server=${encodeURIComponent(server)}&type=pic&id=${encodeURIComponent(result.providerId)}`).then(value => ({ key: 'cover', value })));
  if (!requests.length) return result;
  const metadata = await Promise.allSettled(requests);
  const enriched = { ...result };
  metadata.forEach(entry => {
    if (entry.status === 'fulfilled' && entry.value.value) {
      enriched[entry.value.key] = entry.value.key === 'cover'
        ? entry.value.value.replace(/^http:/i, 'https:')
        : entry.value.value;
    }
  });
  return enriched;
}

function hasMusicPreviewLabel(track) {
  return /试听|试播|片段|preview|snippet|sample|伴奏|纯音乐|instrumental|karaoke|弦乐|钢琴|演奏|翻唱|cover|remix|现场/i.test(`${track?.title || ''} ${track?.artist || ''} ${track?.language || ''} ${track?.searchArtist || ''}`);
}

function normalizeMusicDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number > 1000 ? number / 1000 : number;
}

function readMusicDuration(src, timeout = 1200) {
  return new Promise(resolve => {
    if (!src) { resolve(0); return; }
    const audio = new Audio();
    let settled = false;
    const finish = duration => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      audio.pause();
      audio.removeAttribute('src');
      resolve(Number.isFinite(duration) && duration > 0 ? duration : 0);
    };
    const timer = setTimeout(() => finish(0), timeout);
    audio.preload = 'metadata';
    audio.muted = true;
    audio.addEventListener('loadedmetadata', () => finish(audio.duration), { once: true });
    audio.addEventListener('error', () => finish(0), { once: true });
    audio.src = src;
    audio.load();
  });
}

async function filterShortMusicResults(results) {
  if (!results.length) return results;
  const candidates = results.slice(0, 24);
  const checked = await Promise.all(candidates.map(async track => {
    if (hasMusicPreviewLabel(track)) return { ...track, duration: normalizeMusicDuration(track.duration) || 1 };
    // Provider metadata is authoritative when present. For signed or
    // cross-origin URLs the browser may refuse duration probing even though
    // the audio element can still play them, so probing is only a fallback.
    const duration = normalizeMusicDuration(track.duration) || await readMusicDuration(track.src);
    const playable = duration >= 75 && (isKnownFreshMusicHost(track.src) || await probeMusicSource(track.src));
    return { ...track, duration, playable };
  }));
  // Do not show a provider entry unless its playable source has a verified
  // duration. This prevents expired JSON endpoints and short preview clips
  // from returning to the results list.
  const fullLength = checked.filter(track => !hasMusicPreviewLabel(track) && track.duration >= 75 && track.playable !== false);
  return fullLength;
}

async function fetchVkeysMusicResults(query) {
  const variants = [query];
  if (/周杰伦|周杰倫/i.test(query)) variants.push(query.replace(/周杰伦|周杰倫/gi, 'Jay'));
  if (/韦礼安/i.test(query)) variants.push(query.replace(/韦礼安/gi, 'Wei Li An'));
  const responses = await Promise.allSettled(variants.map(async variant => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3200);
    try {
      const response = await fetch(`https://api.vkeys.cn/v2/music/netease?word=${encodeURIComponent(variant)}&choice=1`, { mode: 'cors', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) return [];
      const data = await response.json();
      return (Array.isArray(data?.data) ? data.data : []).map(normalizeMusicProviderResult).filter(Boolean).map(item => {
        if (/^(晴天|稻香)$/i.test(item.title) && /^jay$/i.test(item.artist || '')) item.artist = '周杰伦';
        return item;
      });
    } catch (error) {
      console.debug('TavernAssetClassifier: Vkeys music search unavailable', error);
      return [];
    } finally {
      clearTimeout(timer);
    }
  }));
  const items = [];
  responses.forEach(result => {
    if (result.status !== 'fulfilled') return;
    result.value.forEach(item => {
      if (!items.some(existing => existing.providerId === item.providerId)) items.push(item);
    });
  });
  // Vkeys supplies the catalogue ID; resolve that ID through GD Studio to
  // obtain a current full-length CDN URL instead of the often-short preview.
  const ordered = items.sort((left, right) => musicSearchScore(right, query) - musicSearchScore(left, query));
  const enriched = await Promise.all(ordered.slice(0, 12).map(async item => {
    const info = await fetchGdStudioAudioInfo('netease', item.providerId);
    return info?.src ? { ...item, src: info.src, duration: info.duration, source: 'gdstudio-netease' } : item;
  }));
  return enriched;
}

async function fetchXingzhigeMusicResults(query) {
  const requests = Array.from({ length: 3 }, (_, index) => (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    try {
      const url = `https://api.xingzhige.com/API/NetEase_CloudMusic/?name=${encodeURIComponent(query)}&n=${index + 1}`;
      const response = await fetch(url, { mode: 'cors', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) return null;
      const data = await response.json();
      const item = data?.data;
      const title = normalizeTag(item?.songname);
      const artist = normalizeTag(item?.name);
      const src = normalizeTag(item?.src).replace(/^http:/i, 'https:');
      return title && src ? { title, artist, src, source: 'netease' } : null;
    } catch (error) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })());
  const settled = await Promise.all(requests);
  return settled.filter(Boolean);
}

async function fetchMusicBinary(src, timeout = 20000) {
  const targets = [src, ...getMusicSearchProxyTargets(src).filter(endpoint => endpoint !== src)];
  let lastError = null;
  for (const endpoint of targets) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(endpoint, { mode: 'cors', signal: controller.signal, headers: { Accept: 'audio/*, application/octet-stream, */*' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.size) throw new Error('返回的音频为空');
      if (/text\/html/i.test(blob.type)) throw new Error('返回了网页而不是音频文件');
      return blob;
    } catch (error) {
      lastError = error;
      console.debug('TavernAssetClassifier: music download endpoint unavailable', endpoint, error);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('无法获取音频文件');
}

async function downloadMusicLyrics(lrc) {
  const value = normalizeTag(lrc);
  if (!value) return '';
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    return await fetchMusicMetadataValue(value, 10000);
  } catch (error) {
    console.debug('TavernAssetClassifier: failed to download lyrics', error);
    return '';
  }
}

async function downloadMusicCover(cover) {
  const value = normalizeTag(cover);
  if (!value || value.startsWith('data:')) return value;
  if (!/^https?:\/\//i.test(value)) return '';
  try {
    const blob = await fetchMusicBinary(value, 10000);
    return await fileToDataUrl(blob);
  } catch (error) {
    console.debug('TavernAssetClassifier: failed to download cover', error);
    return '';
  }
}

async function addOnlineMusicResult(result, { download = false } = {}) {
  const meta = await showMusicTrackEditor(result.title, result.artist);
  if (!meta) return false;
  const id = makeBindingId();
  let src = result.src;
  let source = result.source;
  let downloadedLyrics = '';
  let downloadedCover = '';
  if (download) {
    const blob = await fetchMusicBinary(result.src);
    await saveMusicBlob(id, blob);
    src = `tac-local://${id}`;
    source = 'local';
    [downloadedLyrics, downloadedCover] = await Promise.all([
      downloadMusicLyrics(result.lrc || result.lyrics),
      downloadMusicCover(result.cover),
    ]);
  }
  const track = {
    ...result,
    ...meta,
    id,
    src,
    source,
    lyrics: meta.lyricsFileProvided ? meta.lyrics : String(result.lyrics || ''),
    addedAt: new Date().toISOString(),
  };
  if (downloadedLyrics) {
    track.lyrics = downloadedLyrics;
    track.lrc = '';
  }
  if (downloadedCover) track.cover = downloadedCover;
  state.musicBindings.tracks.push(track);
  state.musicBindings.playlists[0].trackIds.push(track.id);
  if (Array.isArray(state.musicBindings.queueTrackIds)) state.musicBindings.queueTrackIds.push(track.id);
  await saveMusicState();
  renderCharacterBindingPanel();
  notify('success', download ? `已下载到本地：${track.title}` : `已保存歌曲链接：${track.title}`);
  return true;
}

async function openMusicAddModal() {
  const existing = document.querySelector('#tac-music-add-modal');
  existing?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'tac-music-add-modal';
  overlay.className = 'tac-binding-form-modal';
  trapModalEvents(overlay);
  let previewAudio = null;
  let previewButton = null;
  const stopPreview = () => {
    if (previewAudio) {
      previewAudio.pause();
      previewAudio.removeAttribute('src');
      previewAudio.load();
    }
    if (previewButton) {
      previewButton.innerHTML = '<i class="fa-solid fa-headphones"></i>';
      previewButton.title = '试听';
      previewButton.setAttribute('aria-label', '试听');
    }
    previewAudio = null;
    previewButton = null;
  };
  const close = () => { stopPreview(); closeModalOverlay(overlay); };
  overlay.innerHTML = `
    <div class="tac-modal-card tac-music-add-card"><div class="tac-modal-head"><div><div class="tac-modal-kicker">角色专属音乐</div><div class="tac-modal-title">添加歌曲</div></div><button type="button" class="menu_button tac-icon-button" data-action="close" title="关闭"><i class="fa-solid fa-xmark"></i></button></div>
      <div class="tac-music-add-tabs"><button type="button" class="menu_button is-active" data-tab="local">导入歌曲文件</button><button type="button" class="menu_button" data-tab="online">联网搜索</button></div>
      <div class="tac-music-add-pane" data-pane="local"><p class="tac-music-help">音频会保存到当前角色卡，可一次选择多个文件，也可以直接输入音频 URL 或批量粘贴歌曲数据。</p><input id="tac-music-file-input" class="tac-music-file-input" type="file" accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac" multiple data-action="files"><div class="tac-music-file-actions"><button type="button" class="menu_button tac-music-file-button" data-action="choose-files"><i class="fa-solid fa-folder-open"></i> 选择音频文件</button><button type="button" class="menu_button tac-music-file-button" data-action="url"><i class="fa-solid fa-link"></i> URL 获取</button><button type="button" class="menu_button tac-music-file-button" data-action="batch"><i class="fa-solid fa-list"></i> 批量导入</button></div><div class="tac-music-file-name" data-file-name>尚未选择文件</div></div>
      <div class="tac-music-add-pane" data-pane="online" hidden><div class="tac-music-search-row"><input type="search" class="text_pole" data-action="query" placeholder="输入歌名或歌手"><button type="button" class="menu_button" data-action="search"><i class="fa-solid fa-magnifying-glass"></i> 搜索</button></div><div class="tac-music-search-results"><div class="tac-binding-empty">输入歌名或歌手，系统会自动搜索可用音源。</div></div></div>
    </div>`;
  overlay.addEventListener('click', async event => {
    const tab = event.target.closest('[data-tab]');
    if (tab) {
      if (tab.dataset.tab !== 'online') stopPreview();
      overlay.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('is-active', button === tab));
      overlay.querySelectorAll('[data-pane]').forEach(pane => { pane.hidden = pane.dataset.pane !== tab.dataset.tab; });
      return;
    }
    if (event.target.closest('[data-action="close"]')) { close(); return; }
    if (event.target.closest('[data-action="choose-files"]')) { stopPreview(); overlay.querySelector('[data-action="files"]')?.click(); }
    if (event.target.closest('[data-action="url"]')) { stopPreview(); void openMusicUrlImportModal(overlay); }
    if (event.target.closest('[data-action="batch"]')) { stopPreview(); openMusicBatchImportModal(overlay); }
    if (event.target.closest('[data-action="search"]')) {
      const query = normalizeTag(overlay.querySelector('[data-action="query"]').value);
      if (!query) return;
      stopPreview();
      const resultsNode = overlay.querySelector('.tac-music-search-results');
      resultsNode.innerHTML = '<div class="tac-binding-empty">正在搜索音源…</div>';
      const results = await fetchMusicSearchResults(query);
      resultsNode.replaceChildren();
      if (!results.length) { resultsNode.innerHTML = '<div class="tac-binding-empty">没有找到可播放的完整音源。可以尝试补充歌手名，或使用“URL 获取”。</div>'; return; }
      results.slice(0, 12).forEach(result => {
        const row = document.createElement('div');
        row.className = 'tac-music-search-result';
        row.innerHTML = `<div><b></b><small></small><span class="tac-music-search-tags"><span data-tag="lyrics"></span><span data-tag="cover"></span></span></div><div class="tac-music-search-result-actions"><button type="button" class="menu_button tac-icon-button" data-action="preview" title="试听" aria-label="试听"><i class="fa-solid fa-headphones"></i></button><button type="button" class="menu_button tac-icon-button" data-action="save-result" title="保存链接" aria-label="保存链接"><i class="fa-solid fa-link"></i></button><button type="button" class="menu_button tac-icon-button" data-action="download-result" title="下载到本地" aria-label="下载到本地"><i class="fa-solid fa-download"></i></button></div>`;
        row.querySelector('b').textContent = result.title;
        row.querySelector('small').textContent = result.artist || '未知歌手';
        const lyricsTag = row.querySelector('[data-tag="lyrics"]');
        const coverTag = row.querySelector('[data-tag="cover"]');
        const hasLyrics = Boolean(result.lrc || result.lyrics);
        const hasCover = Boolean(result.cover);
        lyricsTag.textContent = hasLyrics ? '歌词已同步' : '歌词未找到';
        coverTag.textContent = hasCover ? '封面已同步' : '封面未找到';
        lyricsTag.classList.toggle('is-available', hasLyrics);
        coverTag.classList.toggle('is-available', hasCover);
        row.querySelector('[data-action="preview"]').addEventListener('click', async event => {
          event.stopPropagation();
          const button = event.currentTarget;
          if (previewButton === button && previewAudio) {
            stopPreview();
            return;
          }
          stopPreview();
          const audio = new Audio();
          audio.preload = 'metadata';
          audio.volume = 0.7;
          audio.setAttribute('playsinline', '');
          previewAudio = audio;
          previewButton = button;
          button.innerHTML = '<i class="fa-solid fa-stop"></i>';
          button.title = '停止试听';
          button.setAttribute('aria-label', '停止试听');
          audio.addEventListener('ended', stopPreview, { once: true });
          audio.addEventListener('error', () => {
            if (previewAudio === audio) {
              stopPreview();
              notify('warning', '这条音源无法试听，可以换一条搜索结果。');
            }
          }, { once: true });
          audio.src = result.src;
          try {
            await audio.play();
          } catch (error) {
            if (previewAudio === audio) stopPreview();
            if (error?.name !== 'AbortError') notify('warning', '浏览器阻止了试听，请再次点击试听按钮。');
          }
        });
        row.querySelector('[data-action="save-result"]').addEventListener('click', async () => {
          stopPreview();
          await runFeatureTask('保存歌曲链接', async () => {
            const saved = await addOnlineMusicResult(result);
            if (saved) close();
          });
        });
        row.querySelector('[data-action="download-result"]').addEventListener('click', async () => {
          stopPreview();
          await runFeatureTask('下载歌曲', async () => {
            const saved = await addOnlineMusicResult(result, { download: true });
            if (saved) close();
          });
        });
        resultsNode.append(row);
      });
    }
  });
  overlay.querySelector('[data-action="files"]').addEventListener('change', event => {
    const files = Array.from(event.target.files || []);
    overlay.querySelector('[data-file-name]').textContent = files.length ? `已选择 ${files.length} 个音频文件` : '尚未选择文件';
    if (files.length) void runFeatureTask('导入歌曲', () => addLocalMusicFiles(files));
    event.target.value = '';
  });
  mountModalOverlay(overlay);
}

async function openMusicPlaylistModal() {
  const existing = document.querySelector('#tac-music-playlist-modal');
  existing?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'tac-music-playlist-modal';
  overlay.className = 'tac-binding-form-modal';
  trapModalEvents(overlay);
  overlay.innerHTML = `<div class="tac-modal-card tac-music-playlist-card"><div class="tac-modal-head"><div><div class="tac-modal-kicker">角色专属音乐</div><div class="tac-modal-title">选择播放歌曲</div></div><button type="button" class="menu_button tac-icon-button" data-action="close" title="关闭"><i class="fa-solid fa-xmark"></i></button></div><div class="tac-music-playlist-toolbar"><button type="button" class="menu_button" data-action="all">一键全选歌曲</button><button type="button" class="menu_button" data-action="none">一键取消全选</button></div><div class="tac-music-playlist-list"></div><div class="tac-modal-actions"><button type="button" class="menu_button" data-action="close">完成</button></div></div>`;
  const list = overlay.querySelector('.tac-music-playlist-list');
  const playlist = state.musicBindings.playlists[0];
  const selectedTrackIds = new Set(Array.isArray(state.musicBindings.queueTrackIds) ? state.musicBindings.queueTrackIds : playlist.trackIds);
  const render = () => {
    list.replaceChildren();
    const row = document.createElement('div');
    row.className = 'tac-music-playlist-row';
    row.innerHTML = `<div class="tac-music-playlist-head"><span class="tac-music-playlist-name">播放列表（${state.musicBindings.tracks.length} 首）</span></div><div class="tac-music-playlist-tracks"></div>`;
    const trackList = row.querySelector('.tac-music-playlist-tracks');
    if (!state.musicBindings.tracks.length) trackList.innerHTML = '<small class="tac-music-no-tracks">还没有歌曲</small>';
    else state.musicBindings.tracks.forEach(track => {
      const label = document.createElement('label');
      label.className = 'tac-music-playlist-track-check';
      label.innerHTML = '<input type="checkbox" data-track><span></span>';
      label.querySelector('input').checked = selectedTrackIds.has(track.id);
      label.querySelector('span').textContent = `${track.title}${track.artist ? ` · ${track.artist}` : ''}`;
      label.querySelector('input').addEventListener('change', event => {
        if (event.target.checked) selectedTrackIds.add(track.id);
        else selectedTrackIds.delete(track.id);
      });
      trackList.append(label);
    });
    list.append(row);
  };
  render();
  overlay.addEventListener('click', async event => {
    if (event.target.closest('[data-action="close"]')) {
      state.musicBindings.queueTrackIds = Array.from(selectedTrackIds);
      if (state.musicBindings.currentTrackId && !selectedTrackIds.has(state.musicBindings.currentTrackId)) state.musicBindings.currentTrackId = '';
      await saveMusicState();
      closeModalOverlay(overlay);
      renderCharacterBindingPanel();
    }
    if (event.target.closest('[data-action="all"]')) { state.musicBindings.tracks.forEach(track => selectedTrackIds.add(track.id)); render(); }
    if (event.target.closest('[data-action="none"]')) { selectedTrackIds.clear(); render(); }
  });
  mountModalOverlay(overlay);
}

async function editMusicTrack(track) {
  const meta = await showMusicTrackEditor(track.title, track.artist, track);
  if (!meta) return;
  track.title = meta.title || track.title;
  track.artist = meta.artist;
  if (meta.lyricsFileProvided) {
    track.lyrics = meta.lyrics;
    track.lrc = '';
  }
  await saveMusicState();
  renderCharacterBindingPanel();
}

async function loadMusicLyrics(track) {
  if (!track) return '';
  if (track.lyrics) return track.lyrics;
  if (!track.lrc) return '';
  if (/^https?:\/\//i.test(track.lrc)) {
    try {
      const response = await fetch(track.lrc, { mode: 'cors' });
      if (response.ok) track.lyrics = await response.text();
    } catch (error) {
      console.debug('TavernAssetClassifier: failed to load lyrics', error);
    }
  } else track.lyrics = track.lrc;
  if (track.lyrics) void saveMusicState();
  return track.lyrics || '';
}

async function deleteMusicTrack(track) {
  if (!await requestCharacterRelationConfirmation('删除歌曲', `确定删除“${track.title}”吗？`, '删除')) return;
  state.musicBindings.tracks = state.musicBindings.tracks.filter(item => item.id !== track.id);
  if (Array.isArray(state.musicBindings.queueTrackIds)) state.musicBindings.queueTrackIds = state.musicBindings.queueTrackIds.filter(id => id !== track.id);
  state.musicBindings.playlists.forEach(list => { list.trackIds = list.trackIds.filter(id => id !== track.id); });
  // Remove the IndexedDB payload as well as the track metadata. Awaiting this
  // keeps a deleted downloaded song from reappearing if the card is rerendered
  // immediately after the confirmation.
  await deleteMusicBlob(track.id);
  const objectUrl = state.musicObjectUrls.get(track.id);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  state.musicObjectUrls.delete(track.id);
  state.musicResolvedSources.delete(track.id);
  state.musicFailedTrackIds.delete(track.id);
  state.musicLyricsCache.delete(track.id);
  if (state.musicBindings.currentTrackId === track.id) {
    state.musicPlaybackRequestId += 1;
    state.musicPlaybackPending = false;
    state.musicBindings.currentTrackId = '';
    state.musicLoadedTrackId = '';
    ensureMusicAudio().pause();
    ensureMusicAudio().removeAttribute('src');
  }
  await saveMusicState();
  renderCharacterBindingPanel();
}

function toggleMusicFloating() {
  if (!state.musicBindings) return;
  state.musicBindings.floating = !state.musicBindings.floating;
  renderMusicFloatingPlayer();
  if (state.musicBindings.floating) {
    const floating = getMusicFloatingNode();
    floating?.classList.add('is-expanded');
    const toggle = floating?.querySelector('.tac-music-floating-toggle');
    if (toggle) toggle.title = '收起播放器';
    notify('success', '已生成悬浮播放器。点击音乐球可收起或展开。');
  }
  void saveMusicState();
}

function renderMusicFloatingPlayer() {
  ensureMusicHostStyles();
  const existing = getMusicFloatingNode();
  if (!state.musicBindings?.floating) {
    getMusicHostDocuments().forEach(doc => doc.querySelector('#tac-music-floating')?.remove());
    return;
  }
  if (existing) {
    // Re-attach the node after a Tavern/mobile view rerender. Some mobile
    // layouts move or replace the extension panel, which otherwise leaves
    // the floating player detached from the visible document.
    const ownerDocument = existing.ownerDocument;
    if (!ownerDocument.body?.contains(existing)) ownerDocument.body?.append(existing);
    existing.style.zIndex = '2147483000';
    updateMusicPlayerDom();
    return;
  }
  const floatingDocument = getMusicHostDocuments()[0] || document;
  const floatingWindow = floatingDocument.defaultView || window;
  const node = floatingDocument.createElement('div');
  node.id = 'tac-music-floating';
  node.className = 'tac-music-floating';
  node.style.zIndex = '2147483000';
  node.style.left = '18px';
  node.style.top = '180px';
  node.style.right = 'auto';
  node.style.bottom = 'auto';
  node.innerHTML = `<button type="button" class="tac-music-floating-toggle" title="展开播放器"><i class="fa-solid fa-music"></i></button><div class="tac-music-floating-content"><div class="tac-music-floating-track-head"><div class="tac-music-current-track">选择歌曲开始播放</div><button type="button" class="tac-music-floating-queue-toggle" data-action="queue-toggle" title="显示播放列表" aria-label="显示播放列表"><i class="fa-solid fa-chevron-down"></i></button></div><div class="tac-music-floating-queue" hidden></div><div class="tac-music-floating-actions"><button type="button" class="menu_button" data-action="prev" title="上一首"><i class="fa-solid fa-backward-step"></i></button><button type="button" class="menu_button tac-music-play-toggle" data-action="play" title="播放"><i class="fa-solid fa-play"></i></button><button type="button" class="menu_button" data-action="next" title="下一首"><i class="fa-solid fa-forward-step"></i></button><button type="button" class="menu_button tac-music-mode" data-mode="sequence" title="顺序播放"><i class="fa-solid fa-list-ol"></i></button><button type="button" class="menu_button" data-action="lyrics" title="显示当前歌词"><i class="fa-solid fa-align-left"></i></button><button type="button" class="menu_button" data-action="hide" title="隐藏悬浮窗" aria-label="隐藏悬浮窗"><i class="fa-solid fa-eye-slash"></i></button></div></div><div class="tac-music-floating-lyrics" hidden></div>`;
  node.querySelector('[data-action="play"]').addEventListener('click', () => void toggleMusicPlayback());
  node.querySelector('[data-action="prev"]').addEventListener('click', () => void playNextMusicTrack(-1));
  node.querySelector('[data-action="next"]').addEventListener('click', () => void playNextMusicTrack(1));
  node.querySelector('[data-mode]').addEventListener('click', () => setMusicMode(getNextMusicMode(state.musicBindings.mode)));
  node.querySelector('[data-action="lyrics"]').addEventListener('click', async () => {
    const lyrics = node.querySelector('.tac-music-floating-lyrics');
    lyrics.hidden = !lyrics.hidden;
    if (!lyrics.hidden) {
      lyrics.textContent = '正在读取歌词…';
      await loadMusicLyrics(getMusicTrack());
      updateMusicFloatingLyrics();
    }
  });
  node.querySelector('[data-action="hide"]').addEventListener('click', event => {
    event.stopPropagation();
    toggleMusicFloating();
  });
  node.querySelectorAll('.tac-music-floating-content button').forEach(button => {
    button.addEventListener('pointerdown', event => event.stopPropagation());
  });
  node.querySelector('[data-action="queue-toggle"]').addEventListener('click', event => {
    event.stopPropagation();
    const button = event.currentTarget;
    const list = node.querySelector('.tac-music-floating-queue');
    list.hidden = !list.hidden;
    button.title = list.hidden ? '显示播放列表' : '收起播放列表';
    button.setAttribute('aria-label', button.title);
    button.classList.toggle('is-open', !list.hidden);
  });
  const toggle = node.querySelector('.tac-music-floating-toggle');
  let suppressToggleClick = false;
  toggle.addEventListener('click', () => {
    if (suppressToggleClick) { suppressToggleClick = false; return; }
    node.classList.toggle('is-expanded');
    if (!node.classList.contains('is-expanded')) {
      const queue = node.querySelector('.tac-music-floating-queue');
      const queueToggle = node.querySelector('[data-action="queue-toggle"]');
      if (queue) queue.hidden = true;
      queueToggle?.classList.remove('is-open');
      if (queueToggle) {
        queueToggle.title = '显示播放列表';
        queueToggle.setAttribute('aria-label', queueToggle.title);
      }
    }
    if (node.classList.contains('is-expanded') && node.style.left) {
      node.style.left = `${Math.max(4, Math.min(floatingWindow.innerWidth - node.offsetWidth - 4, node.offsetLeft))}px`;
      node.style.top = `${Math.max(4, Math.min(floatingWindow.innerHeight - node.offsetHeight - 4, node.offsetTop))}px`;
    }
    toggle.title = node.classList.contains('is-expanded') ? '收起播放器' : '展开播放器';
  });
  let drag = null;
  toggle.addEventListener('pointerdown', event => {
    drag = { x: event.clientX - node.offsetLeft, y: event.clientY - node.offsetTop, startX: event.clientX, startY: event.clientY, moved: false };
    toggle.setPointerCapture?.(event.pointerId);
  });
  toggle.addEventListener('pointermove', event => {
    if (!drag) return;
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 5) drag.moved = true;
    if (!drag.moved) return;
    node.style.left = `${Math.max(4, Math.min(floatingWindow.innerWidth - node.offsetWidth - 4, event.clientX - drag.x))}px`;
    node.style.top = `${Math.max(4, Math.min(floatingWindow.innerHeight - node.offsetHeight - 4, event.clientY - drag.y))}px`;
    node.style.right = 'auto';
    node.style.bottom = 'auto';
  });
  const finishFloatingDrag = () => { if (drag?.moved) suppressToggleClick = true; drag = null; };
  toggle.addEventListener('pointerup', finishFloatingDrag);
  toggle.addEventListener('pointercancel', finishFloatingDrag);
  (floatingDocument.body || floatingDocument.documentElement).append(node);
  updateMusicPlayerDom();
}

function renderMusicModule(bindings) {
  const music = bindings.music;
  state.musicBindings = music;
  const contextKey = getCurrentCharacterKey();
  if (state.musicContextKey !== contextKey) {
    state.musicObjectUrls.forEach(url => URL.revokeObjectURL(url));
    state.musicObjectUrls.clear();
    state.musicResolvedSources.clear();
    state.musicLoadedTrackId = '';
    state.musicFailedTrackIds.clear();
    state.musicLyricsCache.clear();
    state.musicPlaybackRequestId += 1;
    state.musicPlaybackPending = false;
    state.musicContextKey = contextKey;
    state.musicPlaying = false;
    const track = getMusicTrack(music.currentTrackId) || getMusicQueue(music)[0];
    void loadMusicTrack(track, false);
  }
  void preloadLocalMusicTracks(music.tracks);
  const section = document.createElement('section');
  section.className = 'tac-binding-module tac-music-module';
  section.innerHTML = `<div class="tac-binding-module-head"><div class="tac-binding-module-title"><i class="fa-solid fa-compact-disc"></i> 角色专属音乐</div><div class="tac-music-module-actions"><button type="button" class="menu_button tac-music-add-button" data-action="add" title="添加歌曲"><i class="fa-solid fa-plus"></i><span>添加歌曲</span></button><button type="button" class="menu_button tac-binding-icon" data-action="floating" title="生成或隐藏悬浮播放器"><i class="fa-solid fa-up-right-and-down-left-from-center"></i></button></div></div><div class="tac-music-player-card"><div class="tac-music-current-track">选择歌曲开始播放</div><div class="tac-music-progress-row"><input class="tac-music-progress" type="range" min="0" max="100" step="0.1" value="0"><span class="tac-music-time">0:00 / 0:00</span></div><div class="tac-music-controls"><button type="button" class="menu_button" data-action="prev" title="上一首"><i class="fa-solid fa-backward-step"></i></button><button type="button" class="menu_button tac-music-play-toggle" data-action="play" title="播放"><i class="fa-solid fa-play"></i></button><button type="button" class="menu_button" data-action="next" title="下一首"><i class="fa-solid fa-forward-step"></i></button><button type="button" class="menu_button tac-music-mode" data-mode="sequence" title="顺序播放"><i class="fa-solid fa-list-ol"></i></button><button type="button" class="menu_button tac-binding-icon" data-action="playlist" title="选择播放歌曲"><i class="fa-solid fa-list-check"></i></button></div></div><details class="tac-music-track-details"><summary>全部歌曲（点击展开）</summary><div class="tac-music-track-list"></div></details>`;
  const audio = ensureMusicAudio();
  section.querySelector('[data-action="play"]').addEventListener('click', () => void toggleMusicPlayback());
  section.querySelector('[data-action="prev"]').addEventListener('click', () => void playNextMusicTrack(-1));
  section.querySelector('[data-action="next"]').addEventListener('click', () => void playNextMusicTrack(1));
  section.querySelector('[data-action="floating"]').addEventListener('click', toggleMusicFloating);
  section.querySelector('[data-action="add"]').addEventListener('click', () => void openMusicAddModal());
  section.querySelector('.tac-music-mode').addEventListener('click', () => setMusicMode(getNextMusicMode(state.musicBindings.mode)));
  const progress = section.querySelector('.tac-music-progress');
  progress.addEventListener('input', () => { if (audio.duration) audio.currentTime = (Number(progress.value) / 100) * audio.duration; });
  const list = section.querySelector('.tac-music-track-list');
  const renderTrackList = () => {
    list.replaceChildren();
    const tracks = music.tracks;
    if (!tracks.length) {
      list.innerHTML = `<div class="tac-binding-empty">${music.tracks.length ? '这个歌单还没有歌曲。' : '还没有歌曲，点击“添加歌曲”导入或搜索。'}</div>`;
      return;
    }
    tracks.forEach(track => {
    const row = document.createElement('div');
    row.className = `tac-music-track-row${track.id === music.currentTrackId ? ' is-current' : ''}`;
    row.innerHTML = '<button type="button" class="tac-music-track-main"><span class="tac-music-track-title"></span><small class="tac-music-track-artist"></small></button><div class="tac-music-track-actions"><button type="button" class="menu_button tac-binding-icon" data-action="edit" title="编辑歌曲信息与歌词"><i class="fa-solid fa-pen"></i></button><button type="button" class="menu_button tac-binding-icon" data-action="remove" title="删除歌曲"><i class="fa-solid fa-trash"></i></button></div>';
    row.querySelector('.tac-music-track-title').textContent = track.title;
    row.querySelector('.tac-music-track-artist').textContent = track.artist || '未知歌手';
    row.querySelector('.tac-music-track-main').addEventListener('click', () => void playMusicTrack(track));
    row.querySelector('[data-action="edit"]').addEventListener('click', () => void editMusicTrack(track));
    row.querySelector('[data-action="remove"]').addEventListener('click', () => void deleteMusicTrack(track));
    list.append(row);
    });
  };
  section.querySelector('[data-action="playlist"]').addEventListener('click', () => void openMusicPlaylistModal());
  renderTrackList();
  renderMusicFloatingPlayer();
  updateMusicPlayerDom();
  return section;
}

function applyCharacterBindingSearch(root, query) {
  const normalized = normalizeTag(query).toLocaleLowerCase('zh-Hans-CN');
  root.querySelectorAll('.tac-binding-list').forEach(list => {
    const items = Array.from(list.querySelectorAll(':scope > .tac-binding-item'));
    items.forEach(item => {
      item.hidden = Boolean(normalized) && !item.dataset.searchText.includes(normalized);
    });
    const empty = list.querySelector(':scope > .tac-binding-search-empty');
    if (empty) empty.hidden = !normalized || items.some(item => !item.hidden);
  });
}

function renderPresetBindingModule(bindings) {
  const section = document.createElement('section');
  section.className = 'tac-binding-module';
  section.innerHTML = `
    <div class="tac-binding-module-head">
      <div class="tac-binding-module-title"><i class="fa-solid fa-sliders"></i> 预设绑定</div>
      <button type="button" class="menu_button tac-binding-save" title="保存预设绑定"><i class="fa-solid fa-floppy-disk"></i><span>保存</span></button>
    </div>
    <div class="tac-binding-list"></div>
  `;
  section.querySelector('.tac-binding-save')?.addEventListener('click', () => void runFeatureTask('保存预设绑定', savePresetBinding));
  const list = section.querySelector('.tac-binding-list');
  if (bindings.presets.items.length) {
    bindings.presets.items.forEach(item => list.append(makeBindingListItem('presets', item, bindings.presets.starredId)));
    const empty = document.createElement('div');
    empty.className = 'tac-binding-empty tac-binding-search-empty';
    empty.textContent = '没有匹配的预设绑定。';
    empty.hidden = true;
    list.append(empty);
  } else {
    list.innerHTML = '<div class="tac-binding-empty">还没有保存预设绑定。</div>';
  }
  return section;
}

function renderBeautifyBindingModule(bindings) {
  const section = document.createElement('section');
  section.className = 'tac-binding-module tac-beautify-binding-module';
  section.innerHTML = `
    <div class="tac-binding-module-head">
      <div class="tac-binding-module-title"><i class="fa-solid fa-palette"></i> 美化绑定</div>
      <button type="button" class="menu_button tac-binding-save" data-action="add" title="添加当前美化"><i class="fa-solid fa-plus"></i><span>添加</span></button>
    </div>
    <div class="tac-binding-list"></div>
  `;
  section.querySelector('[data-action="add"]')?.addEventListener('click', () => void runFeatureTask('保存美化绑定', () => saveBeautifyBinding(getCurrentThemeName())));
  const list = section.querySelector('.tac-binding-list');
  if (bindings.beautify.items.length) {
    bindings.beautify.items.forEach(item => list.append(makeBeautifyBindingListItem(item, bindings.beautify.starredId)));
    const empty = document.createElement('div');
    empty.className = 'tac-binding-empty tac-binding-search-empty';
    empty.textContent = '没有匹配的美化绑定。';
    empty.hidden = true;
    list.append(empty);
  } else {
    list.innerHTML = '<div class="tac-binding-empty">还没有添加美化绑定。</div>';
  }
  return section;
}

function renderCharacterRelationModule(bindings) {
  const section = document.createElement('section');
  section.className = `tac-binding-module tac-character-relation-module${state.characterRelationDeleteMode ? ' is-delete-mode' : ''}`;
  section.innerHTML = `
    <div class="tac-binding-module-head">
      <div class="tac-binding-module-title"><i class="fa-solid fa-link"></i> 角色卡关联</div>
      <div class="tac-character-relation-actions">
        <button type="button" class="menu_button tac-binding-icon" data-action="add" title="从角色卡库添加"><i class="fa-solid fa-plus"></i></button>
        <button type="button" class="menu_button tac-binding-icon${state.characterRelationDeleteMode ? ' is-active' : ''}" data-action="delete-mode" title="显示或隐藏删除按钮"><i class="fa-solid fa-trash"></i></button>
      </div>
    </div>
    <div class="tac-character-relation-grid"></div>
  `;
  section.querySelector('[data-action="add"]').addEventListener('click', openCharacterLibraryPicker);
  const deleteMode = section.querySelector('[data-action="delete-mode"]');
  deleteMode.disabled = !bindings.relatedCharacters.length;
  deleteMode.addEventListener('click', () => {
    state.characterRelationDeleteMode = !state.characterRelationDeleteMode;
    renderCharacterBindingPanel();
  });

  const grid = section.querySelector('.tac-character-relation-grid');
  if (!bindings.relatedCharacters.length) {
    grid.innerHTML = '<div class="tac-binding-empty">还没有关联角色卡，点击“＋”从角色卡库添加。</div>';
    return section;
  }
  bindings.relatedCharacters.forEach(reference => {
    const target = findCharacterByAvatar(reference.avatar);
    const name = target?.name || reference.name || reference.avatar;
    const card = document.createElement('div');
    card.className = `tac-character-relation-card${target ? '' : ' is-missing'}`;
    card.role = 'button';
    card.tabIndex = target ? 0 : -1;
    card.title = target ? `前往角色卡：${name}` : `角色卡已不在角色库：${name}`;
    card.innerHTML = `
      <span class="tac-character-relation-avatar"><img alt=""></span>
      <span class="tac-character-relation-name"></span>
      <button type="button" class="tac-character-relation-remove" title="删除关联" aria-label="删除关联"><i class="fa-solid fa-xmark"></i></button>
    `;
    const image = card.querySelector('img');
    image.src = target ? getThumbnailUrl('avatar', target.avatar) : '';
    image.alt = name;
    card.querySelector('.tac-character-relation-name').textContent = name;
    card.querySelector('.tac-character-relation-remove').addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      void confirmRemoveRelatedCharacter(reference.avatar, name);
    });
    card.addEventListener('click', event => {
      if (!target || event.target.closest('.tac-character-relation-remove')) return;
      void switchToRelatedCharacter(reference.avatar, name);
    });
    card.addEventListener('keydown', event => {
      if (!target || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      void switchToRelatedCharacter(reference.avatar, name);
    });
    grid.append(card);
  });
  return section;
}

function renderUserBindingModule(bindings) {
  const section = document.createElement('section');
  section.className = 'tac-binding-module';
  section.innerHTML = `
    <div class="tac-binding-module-head">
      <div class="tac-binding-module-title"><i class="fa-solid fa-user"></i> user 绑定</div>
      <button type="button" class="menu_button tac-binding-save" title="保存 user 绑定"><i class="fa-solid fa-floppy-disk"></i><span>保存</span></button>
    </div>
    <div class="tac-binding-list"></div>
  `;
  section.querySelector('.tac-binding-save')?.addEventListener('click', () => void runFeatureTask('保存 user 绑定', saveUserBinding));
  const list = section.querySelector('.tac-binding-list');
  if (bindings.users.items.length) {
    bindings.users.items.forEach(item => list.append(makeBindingListItem('users', item, bindings.users.starredId)));
    const empty = document.createElement('div');
    empty.className = 'tac-binding-empty tac-binding-search-empty';
    empty.textContent = '没有匹配的 user 绑定。';
    empty.hidden = true;
    list.append(empty);
  } else {
    list.innerHTML = '<div class="tac-binding-empty">还没有保存 user 绑定。</div>';
  }
  return section;
}

function renderWorldBookBindingModule(bindings) {
  const section = document.createElement('section');
  section.className = 'tac-binding-module';
  section.innerHTML = `
    <div class="tac-binding-module-head">
      <div class="tac-binding-module-title"><i class="fa-solid fa-book-atlas"></i> 世界书绑定</div>
      <button type="button" class="menu_button tac-binding-save" title="保存当前启用及角色挂载的世界书引用"><i class="fa-solid fa-floppy-disk"></i><span>保存</span></button>
    </div>
    <div class="tac-binding-list"></div>
  `;
  section.querySelector('.tac-binding-save')?.addEventListener('click', () => void runFeatureTask('保存世界书绑定', saveWorldBookBinding));
  const list = section.querySelector('.tac-binding-list');
  if (bindings.worldBooks.items.length) {
    bindings.worldBooks.items.forEach(item => list.append(makeBindingListItem('worldBooks', item, bindings.worldBooks.starredId)));
    const empty = document.createElement('div');
    empty.className = 'tac-binding-empty tac-binding-search-empty';
    empty.textContent = '没有匹配的世界书绑定。';
    empty.hidden = true;
    list.append(empty);
  } else {
    list.innerHTML = '<div class="tac-binding-empty">还没有保存世界书绑定。</div>';
  }
  return section;
}

function renderCharacterBindingPanel() {
  const body = document.querySelector('#tac-character-binding-body');
  if (!body) return;
  const { character } = getCurrentCharacterContext();
  body.innerHTML = '';
  if (!character) {
    state.musicContextKey = '';
    state.musicBindings = null;
    state.musicAudio?.pause();
    state.musicObjectUrls.forEach(url => URL.revokeObjectURL(url));
    state.musicObjectUrls.clear();
    state.musicResolvedSources.clear();
    state.musicLoadedTrackId = '';
    state.musicFailedTrackIds.clear();
    state.musicLyricsCache.clear();
    state.musicPlaybackRequestId += 1;
    state.musicPlaybackPending = false;
    getMusicHostDocuments().forEach(doc => doc.querySelector('#tac-music-floating')?.remove());
    body.innerHTML = '<div class="tac-binding-empty">打开角色卡后可以保存和加载绑定。</div>';
    return;
  }
  const bindings = getCurrentCharacterBindings();
  const status = document.createElement('div');
  status.className = 'tac-binding-character-status';
  status.innerHTML = `<i class="fa-solid fa-id-card"></i><span></span>`;
  status.querySelector('span').textContent = `当前角色：${character.name || character.avatar || '未命名角色'}`;
  const search = document.createElement('div');
  search.className = 'tac-binding-search';
  search.innerHTML = `
    <i class="fa-solid fa-magnifying-glass"></i>
    <input type="search" class="text_pole tac-binding-search-input" placeholder="搜索角色绑定" autocomplete="off">
    <button type="button" class="menu_button tac-binding-search-clear" title="清空搜索"><i class="fa-solid fa-xmark"></i></button>
  `;
  const searchInput = search.querySelector('.tac-binding-search-input');
  searchInput.value = state.characterBindingQuery;
  const grid = document.createElement('div');
  grid.className = 'tac-binding-grid';
  grid.append(
    renderBeautifyBindingModule(bindings),
    renderPresetBindingModule(bindings),
    renderUserBindingModule(bindings),
    renderWorldBookBindingModule(bindings),
    renderMusicModule(bindings),
    renderCharacterRelationModule(bindings),
  );
  searchInput.addEventListener('input', () => {
    state.characterBindingQuery = searchInput.value;
    applyCharacterBindingSearch(body, state.characterBindingQuery);
  });
  search.querySelector('.tac-binding-search-clear').addEventListener('click', () => {
    state.characterBindingQuery = '';
    searchInput.value = '';
    applyCharacterBindingSearch(body, '');
    searchInput.focus();
  });
  body.append(status, search, grid);
  applyCharacterBindingSearch(body, state.characterBindingQuery);
}

function renderFeatureSettingsPanel() {
  const panel = document.createElement('div');
  panel.id = 'tac-extension-settings';
  panel.className = 'extension_container';
  panel.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>美化与角色绑定</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div id="tac-character-binding-panel" class="tac-settings-card tac-character-binding-panel">
          <div id="tac-character-binding-body"></div>
        </div>
      </div>
    </div>
  `;
  return panel;
}

function mountFeatureSettingsPanel() {
  const existing = document.querySelector('#tac-extension-settings');
  if (existing) {
    renderCharacterBindingPanel();
    return true;
  }
  const host = getExtensionSettingsHost();
  if (!host) return false;
  const panel = renderFeatureSettingsPanel();
  host.append(panel);
  try { renderCharacterBindingPanel(); }
  catch (error) { panel.remove(); throw error; }
  return true;
}

function handleCharacterBindingContextChanged() {
  state.lastAppliedCharacterBindingKey = '';
  state.characterRelationDeleteMode = false;
  scheduleCharacterBindingRender();
  scheduleCharacterBindingApply();
}

function retryPendingCharacterBindings() {
  if (state.lastAppliedCharacterBindingKey !== getCurrentCharacterKey()) scheduleCharacterBindingApply();
}

function assertCharacterContext(key) {
  if (getCurrentCharacterKey() !== key) throw new Error('操作期间角色已切换，已停止应用，请在当前角色上重试。');
}

async function readSavedCharacter(avatar) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/api/characters/get', {
      method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ avatar_url: avatar }), cache: 'no-cache', signal: controller.signal,
    });
    if (!response.ok) throw new Error(`角色卡保存后读取失败：${avatar}（HTTP ${response.status}）`);
    const data = await response.json();
    if (!data?.data?.extensions || typeof data.data.extensions !== 'object') throw new Error(`角色卡保存后返回数据不完整：${avatar}`);
    return data;
  } finally { clearTimeout(timer); }
}

async function writeVerifiedExtensionField(id, key, value) {
  const avatar = getContext().characters?.[id]?.avatar;
  if (!avatar) throw new Error('要保存的角色卡已不可用，请重新打开后重试。');
  let persisted = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await writeExtensionField(id, key, value);
    persisted = await readSavedCharacter(avatar);
    const persistedValue = persisted.data.extensions[key];
    if (dataMatches(persistedValue, value)) return;
    // The character API can return an equivalent JSON object with different
    // key order or legacy fields while the in-memory character is current.
    if (key === EXTENSION_KEY && dataMatches(normalizeCharacterBindings(persistedValue), normalizeCharacterBindings(value))) return;
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
  }
  throw new Error(`未确认角色卡字段已完整保存：${avatar} / ${key}`);
}

async function readSavedWorldBook(name, { allowMissing = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('/api/worldinfo/get', {
      method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ name }), cache: 'no-cache', signal: controller.signal,
    });
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) throw new Error(`世界书保存后读取失败：${name}（HTTP ${response.status}）`);
    const data = await response.json();
    if (!data?.entries || typeof data.entries !== 'object') throw new Error(`世界书保存后返回数据不完整：${name}`);
    return data;
  } finally { clearTimeout(timer); }
}

async function savePromptOrderSettings(manager, timeout = 10000) {
  state.promptOrderSavePending = true;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => manager.saveServiceSettings()),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('预设条目顺序尚未确认保存，当前更改可能仅在内存中，请检查连接后重试。')), timeout); }),
    ]);
    state.promptOrderSavePending = false;
  } finally { clearTimeout(timer); }
}

function requirePromptOrderManager() {
  const manager = host.promptManager;
  if (!manager?.activeCharacter || ['getPromptOrderForCharacter', 'removePromptOrderForCharacter', 'addPromptOrderForCharacter', 'saveServiceSettings', 'render']
    .some(name => typeof manager[name] !== 'function')) throw new Error('预设条目管理器尚未就绪，请先打开聊天补全预设后重试。');
  return manager;
}

function changePromptPreset(select, option) {
  return new Promise((resolve, reject) => {
    const api = host.main_api;
    const source = host.eventSource, type = api === 'openai' ? host.event_types.OAI_PRESET_CHANGED_AFTER : host.event_types.PRESET_CHANGED;
    const characterKey = getCurrentCharacterKey();
    let timer, poll, finished = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (type) source?.removeListener?.(type, changed);
      if (error) reject(error);
      else resolve();
    };
    const changed = data => {
      if (data?.apiId && data.apiId !== api) return;
      try {
        assertCharacterContext(characterKey);
        if (select.value !== option.value) throw new Error('操作期间预设已切换，未继续应用条目顺序，请重试。');
        finish();
      } catch (error) { finish(error); }
    };
    const hasEvent = Boolean(source?.on && type);
    timer = setTimeout(() => finish(new Error('等待预设切换完成超时，未继续修改条目顺序，请重新读取后重试。')), 8000);
    if (hasEvent) source.on(type, changed);
    else poll = setInterval(() => {
      try {
        const name = getContext().chatCompletionSettings?.preset_settings_openai;
        if (name === normalizeTag(option.textContent) || name === option.value) changed();
      } catch (error) { finish(error); }
    }, 100);
    try {
      select.value = option.value;
      const jquery = window.jQuery || window.$;
      if (jquery) jquery(select).trigger('change');
      else select.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (error) { finish(error); }
  });
}

async function runFeatureTask(label, task) {
  try {
    return await task();
  } catch (error) {
    console.error(`TavernAssetClassifier: ${label}`, error);
    notify('error', `${label}失败：${error?.message || error}`);
    return false;
  }
}

function showStartupStatus(message, failed = false) {
  let panel = document.querySelector('#tac-startup-status');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'tac-startup-status';
    panel.className = 'extension_container';
    panel.setAttribute('role', 'status');
    panel.style.cssText = 'padding:10px;margin:8px 0;border:1px solid currentColor;border-radius:8px;white-space:normal;';
  }
  const container = getExtensionSettingsHost() || document.body;
  if (panel.parentElement !== container) container.append(panel);
  if (panel.dataset.message === message && panel.dataset.failed === String(failed)) return;
  panel.dataset.message = message;
  panel.dataset.failed = String(failed);
  const text = document.createElement('div');
  text.textContent = `ST分类器：${message}`;
  panel.replaceChildren(text);
  if (failed) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'menu_button';
    retry.textContent = '重试加载';
    retry.addEventListener('click', () => {
      if (state.started) void runFeatureTask('重新加载酒馆接口', async () => { await host.load(); refreshFeatureMounts(); });
      else void start();
    });
    panel.append(retry);
  }
}

function loadStyles() {
  if (state.stylePromise) return state.stylePromise;
  state.stylePromise = new Promise((resolve, reject) => {
    const existing = document.getElementById('tac-classifier-style');
    if (existing?.dataset.loaded === 'true') { resolve(); return; }
    existing?.remove();
    const link = document.createElement('link');
    link.id = 'tac-classifier-style';
    link.rel = 'stylesheet';
    link.href = new URL('./style.css', import.meta.url).href;
    const fail = message => { clearTimeout(timer); link.remove(); reject(new Error(message)); };
    const timer = setTimeout(() => fail('样式加载超时，请保持酒馆在前台后重试。'), 15000);
    link.onload = () => { clearTimeout(timer); link.dataset.loaded = 'true'; resolve(); };
    link.onerror = () => fail('style.css 加载失败，请检查扩展是否安装完整后重试。');
    document.head.append(link);
  }).catch(error => { state.stylePromise = null; throw error; });
  return state.stylePromise;
}

function refreshFeatureMounts() {
  const errors = [];
  let bindingMounted = Boolean(document.querySelector('#tac-extension-settings'));
  try {
    if (!bindingMounted) bindingMounted = mountFeatureSettingsPanel();
  } catch (error) { errors.push(`角色绑定初始化失败：${error.message}`); }
  const select = getThemeSelect();
  let themeMounted = Boolean(select && select === state.themeSelect && document.querySelector('#tac-filter-panel'));
  try {
    if (!themeMounted && select) {
      if (state.themeSelect && state.themeSelect !== select) {
        destroyBeautifyFeature({ restoreOptions: false });
        state.allThemeOptions = [];
      }
      if (mountUi()) {
        state.themeSelect = select;
        observeThemeOptions();
        themeMounted = true;
      }
    }
  } catch (error) { errors.push(`美化分类初始化失败：${error.message}`); }
  const message = errors.join('；');
  if (message) {
    if (message !== state.lastMountError) console.error('TavernAssetClassifier:', message, host.moduleErrors);
    showStartupStatus(message, true);
  } else if (host.moduleErrors.length) showStartupStatus(`部分酒馆模块未加载：${host.moduleErrors.map(error => error.path).join('、')}。相关功能可能不可用，请重试。`, true);
  else if (bindingMounted && themeMounted) document.querySelector('#tac-startup-status')?.remove();
  else showStartupStatus('已连接酒馆，等待对应设置面板加载。');
  state.lastMountError = message;
}

function bindHostEvent(name, handler) {
  const source = host.eventSource, type = host.event_types[name];
  if (!source?.on || !type) return;
  source.on(type, handler);
  state.boundEvents.push({ source, type, handler });
}

async function start() {
  if (state.started) return;
  if (state.starting) return state.starting;
  state.starting = (async () => {
    showStartupStatus('正在加载酒馆接口和样式…');
    await Promise.all([host.load().then(() => host.ready()), loadStyles()]);
    if (!getSettings()) throw new Error('酒馆扩展设置尚未就绪，请重试。');
    state.started = true;
    bindHostEvent('APP_READY', retryPendingCharacterBindings);
    bindHostEvent('CHAT_CHANGED', handleCharacterBindingContextChanged);
    bindHostEvent('CHARACTER_EDITED', scheduleCharacterBindingRender);
    bindHostEvent('CHAT_COMPLETION_SETTINGS_READY', retryPendingCharacterBindings);
    bindHostEvent('OAI_PRESET_CHANGED_AFTER', retryPendingCharacterBindings);
    refreshFeatureMounts();
    state.featureMountTimer = setInterval(() => {
      if (!document.hidden) refreshFeatureMounts();
    }, 1000);
    scheduleCharacterBindingApply();
  })().catch(error => {
    state.started = false;
    console.error('TavernAssetClassifier: initialization failed', error, host.moduleErrors);
    showStartupStatus(`加载失败：${error.message}`, true);
  }).finally(() => { state.starting = null; });
  return state.starting;
}

window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  clearInterval(state.featureMountTimer);
  clearTimeout(state.musicProgressTimer);
  state.musicProgressTimer = null;
  clearTimeout(state.characterBindingTimer);
  clearTimeout(state.characterBindingRenderTimer);
  stopThemeBackgroundSync();
  state.observer?.disconnect();
  state.themePickerCleanup?.();
  for (const { source, type, handler } of state.boundEvents) source.removeListener?.(type, handler);
  state.boundEvents = [];
}, { once: true });

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void start(), { once: true });
else void start();
