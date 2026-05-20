import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { getContext } from '../../../../scripts/extensions.js';
import { background_settings, getBackgroundPath } from '../../../../scripts/backgrounds.js';
import { getThemeObject, power_user } from '../../../../scripts/power-user.js';

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
  observer: null,
  refreshTimer: null,
  allThemeOptions: [],
  suppressThemeObserver: false,
  presetEntryObserver: null,
  presetEntryBodyObserver: null,
  presetEntryTimer: null,
  presetEntrySelection: null,
  presetEntryDragPoint: null,
  presetEntryPointerBound: false,
  applyingPresetEntryGroups: false,
};

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

function escapeCssIdentifier(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return String(value ?? '').replace(/["\\]/g, '\\$&');
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
  if (!document.querySelector('#tac-tag-modal, #tac-rename-modal, #tac-auto-modal')) {
    document.body.classList.remove('tac-modal-open');
  }
}

function getSettings(create = true) {
  const context = getContext();
  const root = context.extensionSettings ?? context.extension_settings;
  if (!root || typeof root !== 'object') return null;
  if (!root[EXTENSION_KEY] && create) {
    root[EXTENSION_KEY] = { files: {} };
  }
  const settings = root[EXTENSION_KEY];
  if (!settings.files || typeof settings.files !== 'object') settings.files = {};
  if (!settings.presetEntryGroups || typeof settings.presetEntryGroups !== 'object') settings.presetEntryGroups = {};
  if (!settings.features || typeof settings.features !== 'object') {
    settings.features = {
      beautify: false,
      presets: false,
    };
  }
  settings.features.beautify = Boolean(settings.features.beautify);
  settings.features.presets = Boolean(settings.features.presets);
  return settings;
}

function saveSettings() {
  try {
    saveSettingsDebounced();
  } catch (error) {
    console.warn('TavernAssetClassifier: failed to save settings', error);
  }
}

function getFeatureSettings() {
  return getSettings()?.features ?? { beautify: false, presets: false };
}

function isBeautifyFeatureEnabled() {
  return Boolean(getFeatureSettings().beautify);
}

function isPresetFeatureEnabled() {
  return Boolean(getFeatureSettings().presets);
}

function normalizeTag(value) {
  return String(value ?? '').trim();
}

function uniqueTags(tags) {
  return [...new Set((tags ?? []).map(normalizeTag).filter(Boolean))];
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
    merged.set(value, {
      value,
      text: String(option.textContent || value),
    });
  });
  state.allThemeOptions = Array.from(merged.values());
}

function getThemeNames() {
  if (!state.allThemeOptions.length) snapshotThemeOptions();
  return state.allThemeOptions.map(option => option.value).filter(Boolean);
}

function getCurrentThemeName() {
  const select = getThemeSelect();
  if (!select) return String(power_user.theme || '').trim();

  const selectedValue = String(select.value || '').trim();
  if (selectedValue && Array.from(select.options).some(option => option.value === selectedValue)) {
    return selectedValue;
  }

  const selectedOptionValue = String(select.selectedOptions?.[0]?.value || '').trim();
  if (selectedOptionValue) return selectedOptionValue;

  return String(select.options?.[0]?.value || power_user.theme || '').trim();
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
  record.background = normalizeTag(record.background);
  return record;
}

function pruneMissingThemeRecords() {
  // Keep saved labels even if SillyTavern temporarily rebuilds or filters the
  // native theme dropdown. Rendering only reads records for existing themes, so
  // stale records stay hidden without risking accidental label loss.
}

function getColorMeta(name) {
  return COLOR_TAGS.find(item => item.name === name);
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
  background_settings.name = normalized;
  background_settings.url = url;
  saveSettingsDebounced();
  return true;
}

function applyBoundBackgroundForTheme(themeName = getCurrentThemeName()) {
  if (!isBeautifyFeatureEnabled()) return false;
  const record = getThemeRecordForTheme(themeName);
  const background = normalizeTag(record?.background);
  if (!background) return false;
  return applyBackgroundFile(background);
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
  if (!state.selectedFilters.length) return names;

  return names.filter(name => {
    const record = getThemeRecordForTheme(name);
    if (!record) return false;
    return state.selectedFilters.every(filter => uniqueTags(record[filter.category]).includes(filter.tag));
  });
}

function applyThemeFilterToSelect() {
  const select = getThemeSelect();
  if (!select) return;
  if (!state.allThemeOptions.length) snapshotThemeOptions();
  if (!state.allThemeOptions.length) return;

  const previousValue = String(select.value || power_user.theme || '').trim();
  const visibleNames = new Set(getFilteredThemeNames());
  let nextOptions = state.selectedFilters.length
    ? state.allThemeOptions.filter(option => visibleNames.has(option.value))
    : state.allThemeOptions;
  const currentOption = state.allThemeOptions.find(option => option.value === previousValue);
  if (state.selectedFilters.length && currentOption && !nextOptions.some(option => option.value === previousValue)) {
    nextOptions = [currentOption, ...nextOptions];
  }
  const currentValues = Array.from(select.options).map(option => option.value);
  const nextValues = nextOptions.map(option => option.value);
  const isAlreadyTargetList = currentValues.length === nextValues.length
    && currentValues.every((value, index) => value === nextValues[index]);

  if (isAlreadyTargetList) return;

  state.suppressThemeObserver = true;
  select.innerHTML = '';
  nextOptions.forEach(item => {
    const option = document.createElement('option');
    option.value = item.value;
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
  state.suppressThemeObserver = false;
}

function restoreThemeSelectOptions() {
  const select = getThemeSelect();
  if (!select) return;
  if (!state.allThemeOptions.length) snapshotThemeOptions();
  state.selectedFilters = [];
  applyThemeFilterToSelect();
}

function renderFilterPanel() {
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

function selectTheme(name) {
  const select = getThemeSelect();
  if (!select) return;
  select.value = name;
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function getAutoTagsFromThemeName(name) {
  const rawName = String(name ?? '');
  if (!rawName.includes('_')) return { style: '', color: '' };
  const parts = rawName.split('_').map(part => normalizeTag(part)).filter(Boolean);
  const style = parts[0] || '';
  const color = parts[1] && COLOR_TAGS.some(item => item.name === parts[1]) ? parts[1] : '';
  return { style, color };
}

function getAutoDetectItems() {
  return getThemeNames()
    .map(name => ({ name, detected: getAutoTagsFromThemeName(name) }))
    .filter(item => [item.detected.style, item.detected.color].filter(Boolean).length >= 2);
}

function requestAutoDetectConfirmation(items) {
  return new Promise(resolve => {
    const existing = document.querySelector('#tac-auto-modal');
    if (existing) closeModalOverlay(existing);

    const overlay = document.createElement('div');
    overlay.id = 'tac-auto-modal';
    document.body.classList.add('tac-modal-open');
    trapModalEvents(overlay);
    overlay.innerHTML = `
      <div class="tac-modal-card tac-rename-card">
        <div class="tac-modal-head">
          <div>
            <div class="tac-modal-kicker">自动识别</div>
            <div class="tac-modal-title"></div>
          </div>
          <button type="button" class="menu_button tac-icon-button" data-action="cancel" title="关闭">
            <i class="fa-solid fa-xmark"></i>
          </button>
        </div>
        <div class="tac-auto-body">
          <div class="tac-auto-row"><span>数量</span><strong></strong></div>
          <div class="tac-auto-row"><span>说明</span><strong></strong></div>
        </div>
        <div class="tac-modal-actions">
          <button type="button" class="menu_button" data-action="cancel">取消</button>
          <button type="button" class="menu_button" data-action="confirm">确定</button>
        </div>
      </div>
    `;
    overlay.querySelector('.tac-modal-title').textContent = '识别全部美化';
    const values = overlay.querySelectorAll('.tac-auto-row strong');
    values[0].textContent = `${items.length} 个`;
    values[1].textContent = '将按名称中的下划线自动追加风格和颜色标签，不会清空已有标签。';

    const close = value => {
      closeModalOverlay(overlay);
      resolve(value);
    };

    overlay.addEventListener('click', event => {
      if (event.target.closest('[data-action="cancel"]')) close(false);
      if (event.target.closest('[data-action="confirm"]')) close(true);
    });

    document.body.append(overlay);
  });
}

async function autoDetectAllThemeTags() {
  const items = getAutoDetectItems();
  if (!items.length) {
    notify('info', '当前没有可识别出两个有效标签的美化。');
    return;
  }

  const confirmed = await requestAutoDetectConfirmation(items);
  if (!confirmed) return;

  let changed = 0;
  items.forEach(({ name, detected }) => {
    const record = getThemeRecord(name);
    if (!record) return;

    const before = JSON.stringify({
      style: uniqueTags(record.style),
      color: uniqueTags(record.color),
    });

    if (detected.style) {
      record.style = uniqueTags([...(record.style ?? []), detected.style]);
    }
    if (detected.color) {
      record.color = uniqueTags([...(record.color ?? []), detected.color]).filter(tag => COLOR_TAGS.some(item => item.name === tag));
    }

    const after = JSON.stringify({
      style: uniqueTags(record.style),
      color: uniqueTags(record.color),
    });
    if (before !== after) changed += 1;
  });

  saveSettings();
  renderFilterPanel();
  notify('success', `已自动识别 ${items.length} 个美化，更新 ${changed} 个。`);
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
        <button type="button" class="menu_button tac-icon-button" data-action="close" title="关闭">
          <i class="fa-solid fa-xmark"></i>
        </button>
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
        chip.title = '点击移除';
        chip.addEventListener('click', () => {
          record[category] = uniqueTags(record[category]).filter(item => item !== tag);
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

  document.body.append(overlay);
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
      chip.title = '点击移除';
      chip.addEventListener('click', () => {
        record[category] = uniqueTags(record[category]).filter(item => item !== tag);
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
        chip.title = '点击添加到当前主题';
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
        button.addEventListener('click', () => {
          if (uniqueTags(record.color).includes(item.name)) {
            record.color = uniqueTags(record.color).filter(tag => tag !== item.name);
          } else {
            record.color = uniqueTags([...(record.color ?? []), item.name]);
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
        button.addEventListener('click', () => {
          record.avatar = uniqueTags(record.avatar).includes(name) ? [] : [name];
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
      <div class="tac-modal-card tac-rename-card">
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

  document.body.append(overlay);
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
    power_user.theme = nextName;
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

function getPromptList() {
  return document.querySelector('#completion_prompt_manager_list, #openai_prompt_manager_list, [id$="prompt_manager_list"], ul[id*="prompt_manager"]');
}

function getPromptItems(list = getPromptList()) {
  if (!list) return [];
  return Array.from(list.querySelectorAll('li[data-pm-identifier]'));
}

function getPromptIdentifier(item) {
  return String(item?.dataset?.pmIdentifier || '').trim();
}

function getPromptTitle(item) {
  const nameNode = item?.querySelector('[data-pm-name]');
  const rawName = nameNode?.dataset?.pmName || nameNode?.textContent || item?.textContent || '';
  return String(rawName).replace(/\s+/g, ' ').trim();
}

function makePresetEntryGroupId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `tac-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function getCurrentPromptPresetName() {
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
    if (value) return value;
  }
  return '';
}

function getPresetEntryGroupKey() {
  const list = getPromptList();
  const listId = String(list?.id || 'prompt_manager_list').trim();
  const presetName = getCurrentPromptPresetName();
  return `${listId}:${presetName || 'default'}`;
}

function getPresetEntryStore() {
  const settings = getSettings();
  if (!settings) return { groups: [] };
  const key = getPresetEntryGroupKey();
  if (!settings.presetEntryGroups[key] || typeof settings.presetEntryGroups[key] !== 'object') {
    settings.presetEntryGroups[key] = { groups: [] };
  }
  const store = settings.presetEntryGroups[key];
  if (!Array.isArray(store.groups)) store.groups = [];
  store.groups = store.groups
    .filter(group => group && typeof group === 'object' && Array.isArray(group.memberIdentifiers))
    .map(group => ({
      id: String(group.id || makePresetEntryGroupId()),
      name: String(group.name || '分类'),
      collapsed: Boolean(group.collapsed),
      memberIdentifiers: [...new Set(group.memberIdentifiers.map(value => String(value || '').trim()).filter(Boolean))],
    }));
  return store;
}

function cleanupPresetEntryGrouping(list = getPromptList()) {
  if (!list) return;
  list.querySelectorAll('.tac-preset-group-header').forEach(node => node.remove());
  list.querySelectorAll('.tac-preset-group-end').forEach(node => node.remove());
  Array.from(list.querySelectorAll('.tac-preset-group-wrapper')).forEach(wrapper => {
    const parent = wrapper.parentNode;
    if (!parent) return;
    Array.from(wrapper.children).forEach(child => parent.insertBefore(child, wrapper));
    wrapper.remove();
  });
  getPromptItems(list).forEach(item => {
    item.classList.remove('tac-preset-select-start', 'tac-preset-select-range', 'tac-preset-group-collapsed-item');
    delete item.dataset.tacPresetGroupId;
  });
}

function injectPresetEntryButtons(list = getPromptList()) {
  getPromptItems(list).forEach(item => {
    const controls = item.querySelector('.prompt_manager_prompt_controls');
    if (!controls || controls.querySelector('.tac-preset-classify-button')) return;
    const button = document.createElement('span');
    button.className = 'tac-preset-classify-button menu_button fa-solid fa-tags';
    button.role = 'button';
    button.tabIndex = 0;
    button.title = '分类';
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      if (state.presetEntrySelection?.startIdentifier) {
        createPresetEntryGroup(item);
      } else {
        beginPresetEntrySelection(item);
      }
    });
    button.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      if (state.presetEntrySelection?.startIdentifier) {
        createPresetEntryGroup(item);
      } else {
        beginPresetEntrySelection(item);
      }
    });
    controls.insertBefore(button, controls.firstChild);
  });
}

function renderPresetEntrySelection() {
  const list = getPromptList();
  const selection = state.presetEntrySelection;
  getPromptItems(list).forEach(item => {
    item.classList.toggle('tac-preset-select-start', selection?.startIdentifier === getPromptIdentifier(item));
    item.classList.remove('tac-preset-select-range');
  });
}

function beginPresetEntrySelection(item) {
  const identifier = getPromptIdentifier(item);
  if (!identifier) return;
  state.presetEntrySelection = { startIdentifier: identifier };
  renderPresetEntrySelection();
  notify('info', '请选择同一段分类的结束条目。');
}

function makePresetEntryHeader(group, count) {
  const header = document.createElement('div');
  header.className = 'tac-preset-group-header';
  header.dataset.groupId = group.id;
  header.innerHTML = `
    <button type="button" class="tac-preset-group-toggle menu_button" title="${group.collapsed ? '展开分类' : '折叠分类'}">
      <i class="fa-solid ${group.collapsed ? 'fa-chevron-right' : 'fa-chevron-down'}"></i>
    </button>
    <button type="button" class="tac-preset-group-name" title="折叠/展开">${escapeHtml(group.name)}</button>
    <span class="tac-preset-group-count">${count}</span>
    <button type="button" class="tac-preset-group-rename menu_button" title="重命名分类"><i class="fa-solid fa-pen"></i></button>
    <button type="button" class="tac-preset-group-dissolve menu_button" title="解散分类"><i class="fa-solid fa-link-slash"></i></button>
  `;
  header.querySelector('.tac-preset-group-toggle')?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    togglePresetEntryGroup(group.id);
  });
  header.querySelector('.tac-preset-group-name')?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    togglePresetEntryGroup(group.id);
  });
  header.querySelector('.tac-preset-group-rename')?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    renamePresetEntryGroup(group.id);
  });
  header.querySelector('.tac-preset-group-dissolve')?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    dissolvePresetEntryGroup(group.id);
  });
  return header;
}

function makePresetEntryEnd(group) {
  const end = document.createElement('div');
  end.className = 'tac-preset-group-end';
  end.dataset.groupId = group.id;
  end.innerHTML = '<span></span>';
  return end;
}

function applyPresetEntryGroups() {
  const list = getPromptList();
  if (!list) return false;
  state.applyingPresetEntryGroups = true;
  cleanupPresetEntryGrouping(list);
  injectPresetEntryButtons(list);

  const store = getPresetEntryStore();
  const items = getPromptItems(list);
  const itemsById = new Map(items.map(item => [getPromptIdentifier(item), item]));
  const claimed = new Set();

  store.groups.forEach(group => {
    const memberItems = group.memberIdentifiers
      .map(identifier => itemsById.get(identifier))
      .filter(item => item && !claimed.has(getPromptIdentifier(item)));
    if (!memberItems.length) return;
    memberItems.forEach(item => claimed.add(getPromptIdentifier(item)));
    const first = memberItems[0];
    const header = makePresetEntryHeader(group, memberItems.length);
    first.parentNode.insertBefore(header, first);
    memberItems.forEach(item => {
      item.dataset.tacPresetGroupId = group.id;
      item.classList.toggle('tac-preset-group-collapsed-item', group.collapsed);
    });
    if (!group.collapsed) {
      const last = memberItems[memberItems.length - 1];
      last.parentNode.insertBefore(makePresetEntryEnd(group), last.nextSibling);
    }
  });

  renderPresetEntrySelection();
  setTimeout(() => {
    state.applyingPresetEntryGroups = false;
  }, 0);
  return true;
}

function syncPresetEntryGroupsFromDom() {
  if (state.applyingPresetEntryGroups) return;
  const list = getPromptList();
  if (!list) return;
  const store = getPresetEntryStore();
  let changed = false;
  const identifiersByGroup = new Map();
  getPromptItems(list).forEach(item => {
    const groupId = item.dataset.tacPresetGroupId;
    const identifier = getPromptIdentifier(item);
    if (!groupId || !identifier) return;
    if (!identifiersByGroup.has(groupId)) identifiersByGroup.set(groupId, []);
    identifiersByGroup.get(groupId).push(identifier);
  });
  store.groups.forEach(group => {
    const nextMembers = identifiersByGroup.get(group.id) || [];
    if (nextMembers.join('\u0001') !== group.memberIdentifiers.join('\u0001')) {
      group.memberIdentifiers = nextMembers;
      changed = true;
    }
  });
  const before = store.groups.length;
  store.groups = store.groups.filter(group => group.memberIdentifiers.length > 0);
  if (before !== store.groups.length) changed = true;
  if (changed) saveSettings();
}

function schedulePresetEntryRender(delay = 120) {
  if (!isPresetFeatureEnabled()) return;
  clearTimeout(state.presetEntryTimer);
  state.presetEntryTimer = setTimeout(() => {
    if (!isPresetFeatureEnabled()) return;
    syncPresetEntryGroupsFromDom();
    applyPresetEntryGroups();
  }, delay);
}

function getPresetEntryPointer(event) {
  const pointer = event?.originalEvent || event;
  const touch = pointer?.changedTouches?.[0] || pointer?.touches?.[0];
  const clientX = pointer?.clientX ?? touch?.clientX ?? state.presetEntryDragPoint?.clientX;
  const clientY = pointer?.clientY ?? touch?.clientY ?? state.presetEntryDragPoint?.clientY;
  if (typeof clientX !== 'number' || typeof clientY !== 'number') return null;
  return { clientX, clientY };
}

function rememberPresetEntryDragPoint(event) {
  const point = getPresetEntryPointer(event);
  if (point) state.presetEntryDragPoint = point;
}

function inferPresetEntryDropGroupByPoint(point) {
  if (!point) return null;
  const list = getPromptList();
  if (!list) return null;
  const listRect = list.getBoundingClientRect();
  if (point.clientX < listRect.left - 48 || point.clientX > listRect.right + 48) return null;
  const toleranceY = 28;
  let best = null;
  const headers = Array.from(list.querySelectorAll('.tac-preset-group-header'));
  headers.forEach((header, index) => {
    const groupId = header.dataset.groupId;
    if (!groupId) return;
    const nextHeader = headers[index + 1];
    const headerRect = header.getBoundingClientRect();
    const nextHeaderTop = nextHeader?.getBoundingClientRect().top;
    let contentBottom = headerRect.bottom;
    const endMarker = list.querySelector(`.tac-preset-group-end[data-group-id="${escapeCssIdentifier(groupId)}"]`);
    let node = header.nextElementSibling;
    while (node && !node.classList?.contains('tac-preset-group-header')) {
      if (node.matches?.('li[data-pm-identifier]')) {
        const rect = node.getBoundingClientRect();
        if (rect.height > 0) contentBottom = Math.max(contentBottom, rect.bottom);
      }
      node = node.nextElementSibling;
    }
    if (endMarker) {
      const endRect = endMarker.getBoundingClientRect();
      contentBottom = Math.max(contentBottom, endRect.bottom);
    }
    const top = headerRect.top - toleranceY;
    const bottom = typeof nextHeaderTop === 'number'
      ? Math.max(contentBottom, nextHeaderTop - 6)
      : contentBottom + toleranceY;
    if (point.clientY < top || point.clientY > bottom) return;
    const centerY = (top + bottom) / 2;
    const distance = Math.abs(point.clientY - centerY);
    if (!best || distance < best.distance) {
      best = { groupId, distance };
    }
  });
  return best?.groupId || null;
}

function inferPresetEntryDropGroup(event, item) {
  const point = getPresetEntryPointer(event);
  if (point && typeof document.elementsFromPoint === 'function') {
    const elements = document.elementsFromPoint(point.clientX, point.clientY);
    for (const element of elements) {
      if (!(element instanceof Element) || element === item || item?.contains(element)) continue;
      const groupedItem = element.closest('li[data-pm-identifier][data-tac-preset-group-id]');
      if (groupedItem?.dataset?.tacPresetGroupId) return groupedItem.dataset.tacPresetGroupId;
      const wrapper = element.closest('.tac-preset-group-wrapper');
      if (wrapper?.dataset?.groupId) return wrapper.dataset.groupId;
      const header = element.closest('.tac-preset-group-header');
      if (header?.dataset?.groupId) return header.dataset.groupId;
    }
  }
  return inferPresetEntryDropGroupByPoint(point);
}

function reassignDraggedPresetEntry(identifier, targetGroupId) {
  if (!identifier) return;
  const store = getPresetEntryStore();
  const orderedIdentifiers = getPromptItems().map(getPromptIdentifier).filter(Boolean);
  let changed = false;
  store.groups.forEach(group => {
    const before = group.memberIdentifiers.length;
    group.memberIdentifiers = group.memberIdentifiers.filter(value => value !== identifier);
    if (before !== group.memberIdentifiers.length) changed = true;
  });
  const target = targetGroupId ? store.groups.find(group => group.id === targetGroupId) : null;
  if (target) {
    const targetSet = new Set([...target.memberIdentifiers, identifier]);
    const nextMembers = orderedIdentifiers.filter(value => targetSet.has(value));
    if (nextMembers.join('\u0001') !== target.memberIdentifiers.join('\u0001')) {
      target.memberIdentifiers = nextMembers;
      changed = true;
    }
  }
  if (target && !target.memberIdentifiers.includes(identifier)) {
    target.memberIdentifiers.push(identifier);
    changed = true;
  }
  const before = store.groups.length;
  store.groups = store.groups.filter(group => group.memberIdentifiers.length > 0);
  if (before !== store.groups.length) changed = true;
  if (changed) saveSettings();
}

function bindPresetEntrySortEvents(list) {
  if (!list || list.dataset.tacPresetSortBound) return;
  const jquery = window.jQuery || window.$;
  if (!jquery?.fn?.on) return;
  list.dataset.tacPresetSortBound = '1';
  jquery(list)
    .on('sortstart.tac-preset-grouping sort.tac-preset-grouping', event => {
      rememberPresetEntryDragPoint(event);
    })
    .on('sortstop.tac-preset-grouping', (event, ui) => {
      rememberPresetEntryDragPoint(event);
      const item = ui?.item?.[0];
      const identifier = getPromptIdentifier(item);
      const targetGroupId = inferPresetEntryDropGroup(event, item);
      setTimeout(() => {
        reassignDraggedPresetEntry(identifier, targetGroupId);
        state.presetEntryDragPoint = null;
        schedulePresetEntryRender(0);
      }, 0);
    });
}

function bindPresetEntryPointerTracking() {
  if (state.presetEntryPointerBound) return;
  state.presetEntryPointerBound = true;
  ['pointermove', 'mousemove', 'touchmove', 'pointerup', 'mouseup', 'touchend'].forEach(eventName => {
    document.addEventListener(eventName, rememberPresetEntryDragPoint, { passive: true, capture: true });
  });
}

function togglePresetEntryGroup(groupId) {
  const store = getPresetEntryStore();
  const group = store.groups.find(item => item.id === groupId);
  if (!group) return;
  group.collapsed = !group.collapsed;
  saveSettings();
  applyPresetEntryGroups();
}

function renamePresetEntryGroup(groupId) {
  const store = getPresetEntryStore();
  const group = store.groups.find(item => item.id === groupId);
  if (!group) return;
  const nextName = normalizeTag(window.prompt('分类名称', group.name));
  if (!nextName) return;
  group.name = nextName;
  saveSettings();
  applyPresetEntryGroups();
}

function dissolvePresetEntryGroup(groupId) {
  const store = getPresetEntryStore();
  const index = store.groups.findIndex(item => item.id === groupId);
  if (index < 0) return;
  store.groups.splice(index, 1);
  saveSettings();
  applyPresetEntryGroups();
}

function createPresetEntryGroup(endItem) {
  const list = getPromptList();
  const selection = state.presetEntrySelection;
  const endIdentifier = getPromptIdentifier(endItem);
  if (!list || !selection?.startIdentifier || !endIdentifier) return;

  const identifiers = getPromptItems(list).map(getPromptIdentifier).filter(Boolean);
  const startIndex = identifiers.indexOf(selection.startIdentifier);
  const endIndex = identifiers.indexOf(endIdentifier);
  if (startIndex < 0 || endIndex < 0) return;
  const from = Math.min(startIndex, endIndex);
  const to = Math.max(startIndex, endIndex);
  const members = identifiers.slice(from, to + 1);
  if (!members.length) return;

  const store = getPresetEntryStore();
  store.groups.forEach(group => {
    group.memberIdentifiers = group.memberIdentifiers.filter(identifier => !members.includes(identifier));
  });
  store.groups = store.groups.filter(group => group.memberIdentifiers.length > 0);
  const name = normalizeTag(window.prompt('分类名称', '分类'));
  if (!name) {
    state.presetEntrySelection = null;
    renderPresetEntrySelection();
    return;
  }
  store.groups.push({
    id: makePresetEntryGroupId(),
    name,
    collapsed: false,
    memberIdentifiers: members,
  });
  state.presetEntrySelection = null;
  saveSettings();
  applyPresetEntryGroups();
}

function handlePresetEntryListClick(event) {
  const selection = state.presetEntrySelection;
  if (!selection) return;
  if (event.target.closest('.prompt_manager_prompt_controls, .tac-preset-group-header')) return;
  const item = event.target.closest('li[data-pm-identifier]');
  if (!item) return;
  event.preventDefault();
  event.stopPropagation();
  createPresetEntryGroup(item);
}

function nodeContainsPromptList(node) {
  if (!(node instanceof Element)) return false;
  const id = node.id || '';
  if (id.endsWith('prompt_manager_list') || (node.tagName === 'UL' && id.includes('prompt_manager'))) return true;
  return Boolean(node.querySelector?.('#completion_prompt_manager_list, #openai_prompt_manager_list, [id$="prompt_manager_list"], ul[id*="prompt_manager"]'));
}

function startPresetEntryGrouping() {
  const tryStart = () => {
    if (!isPresetFeatureEnabled()) return;
    const list = getPromptList();
    if (!list) {
      setTimeout(tryStart, 600);
      return;
    }
    if (!list.dataset.tacPresetGroupingBound) {
      list.dataset.tacPresetGroupingBound = '1';
      list.addEventListener('click', handlePresetEntryListClick, true);
    }
    bindPresetEntrySortEvents(list);
    if (!state.presetEntryObserver) {
      state.presetEntryObserver = new MutationObserver(() => {
        if (!state.applyingPresetEntryGroups) schedulePresetEntryRender();
      });
      state.presetEntryObserver.observe(list, { childList: true, subtree: true });
    }
    applyPresetEntryGroups();
  };
  if (!isPresetFeatureEnabled()) return;
  if (!state.presetEntryBodyObserver && document.body) {
    state.presetEntryBodyObserver = new MutationObserver(mutations => {
      if (!mutations.some(mutation => [...mutation.addedNodes, ...mutation.removedNodes].some(nodeContainsPromptList))) return;
      state.presetEntryObserver?.disconnect();
      state.presetEntryObserver = null;
      setTimeout(tryStart, 80);
    });
    state.presetEntryBodyObserver.observe(document.body, { childList: true, subtree: true });
  }
  bindPresetEntryPointerTracking();
  tryStart();
}

function destroyPresetEntryGrouping() {
  if (state.presetEntryTimer) {
    clearTimeout(state.presetEntryTimer);
    state.presetEntryTimer = null;
  }
  state.presetEntryObserver?.disconnect();
  state.presetEntryObserver = null;
  state.presetEntryBodyObserver?.disconnect();
  state.presetEntryBodyObserver = null;
  state.presetEntrySelection = null;
  state.presetEntryDragPoint = null;
  const list = getPromptList();
  cleanupPresetEntryGrouping(list);
  document.querySelectorAll('.tac-preset-classify-button').forEach(button => button.remove());
  if (list) {
    delete list.dataset.tacPresetGroupingBound;
    delete list.dataset.tacPresetSortBound;
    const jquery = window.jQuery || window.$;
    jquery?.(list).off?.('.tac-preset-grouping');
  }
}

function mountUi() {
  const themeBlock = document.querySelector('#UI-presets-block');
  const themeRow = document.querySelector('#themes')?.closest('.flex-container');
  if (document.querySelector('#tac-filter-panel')) return true;
  if (!themeBlock || !themeRow) return false;

  const actions = document.createElement('div');
  actions.id = 'tac-theme-actions';
  actions.addEventListener('click', event => event.stopPropagation());

  const updateButton = document.querySelector('#ui-preset-update-button');
  const saveButton = document.querySelector('#ui-preset-save-button');
  if (updateButton) actions.append(updateButton);
  if (saveButton) actions.append(saveButton);

  const rename = document.createElement('button');
  rename.type = 'button';
  rename.id = 'tac-theme-rename-button';
  rename.className = 'menu_button margin0';
  rename.title = '重命名当前主题';
  rename.innerHTML = '<i class="fa-solid fa-pen-to-square"></i>';
  rename.addEventListener('click', renameCurrentTheme);
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

  const autoButton = document.createElement('button');
  autoButton.type = 'button';
  autoButton.id = 'tac-auto-detect-tags';
  autoButton.className = 'menu_button';
  autoButton.title = '自动识别标签';
  autoButton.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
  autoButton.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    autoDetectAllThemeTags();
  });
  actions.append(autoButton);
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
    scheduleRefresh();
    setTimeout(() => applyBoundBackgroundForTheme(), 0);
  });

  document.querySelector('#ui-preset-delete-button')?.addEventListener('click', () => {
    const deletedName = getCurrentThemeName();
    scheduleRefresh(300);
    setTimeout(() => {
      const select = getThemeSelect();
      const stillVisible = Array.from(select?.options ?? []).some(option => option.value === deletedName);
      if (deletedName && !stillVisible) {
        state.allThemeOptions = state.allThemeOptions.filter(option => option.value !== deletedName);
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
  applyBoundBackgroundForTheme();
  return true;
}

function destroyBeautifyFeature() {
  if (state.refreshTimer) {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = null;
  }
  state.observer?.disconnect();
  state.observer = null;
  restoreThemeSelectOptions();
  const themeBlock = document.querySelector('#UI-presets-block');
  const actions = document.querySelector('#tac-theme-actions');
  const updateButton = document.querySelector('#ui-preset-update-button');
  const saveButton = document.querySelector('#ui-preset-save-button');
  if (themeBlock && actions) {
    if (updateButton) themeBlock.insertBefore(updateButton, actions);
    if (saveButton) themeBlock.insertBefore(saveButton, actions);
  }
  actions?.remove();
  document.querySelector('#tac-filter-panel')?.remove();
}

function startBeautifyFeature() {
  const tryMount = () => {
    if (!isBeautifyFeatureEnabled()) return;
    if (mountUi()) {
      observeThemeOptions();
      return;
    }
    setTimeout(tryMount, 500);
  };
  tryMount();
}

function observeThemeOptions() {
  const select = getThemeSelect();
  if (!select || state.observer) return;
  snapshotThemeOptions();
  state.observer = new MutationObserver(() => {
    if (state.suppressThemeObserver) return;
    snapshotThemeOptions();
    scheduleRefresh();
  });
  state.observer.observe(select, { childList: true, subtree: true, attributes: true });
}

function getExtensionSettingsHost() {
  return document.querySelector('#extensions_settings') || document.querySelector('#extensions_settings2');
}

function renderFeatureSettingsPanel() {
  const settings = getFeatureSettings();
  const panel = document.createElement('div');
  panel.id = 'tac-extension-settings';
  panel.className = 'extension_container';
  panel.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>分类器功能</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <div class="tac-settings-card flex-container flexFlowColumn flexGap5">
          <div class="tac-settings-card-title">功能开关</div>
          <label class="checkbox_label alignItemsCenter flexGap5" for="tac-enable-beautify">
            <input id="tac-enable-beautify" type="checkbox" data-feature="beautify" ${settings.beautify ? 'checked' : ''}>
            <small>美化分类</small>
          </label>
          <label class="checkbox_label alignItemsCenter flexGap5" for="tac-enable-presets">
            <input id="tac-enable-presets" type="checkbox" data-feature="presets" ${settings.presets ? 'checked' : ''}>
            <small>预设分类</small>
          </label>
        </div>
      </div>
    </div>
  `;
  panel.addEventListener('change', event => {
    const input = event.target.closest('input[data-feature]');
    if (!input) return;
    const nextSettings = getSettings();
    nextSettings.features[input.dataset.feature] = input.checked;
    saveSettings();
    applyFeatureState();
  });
  return panel;
}

function mountFeatureSettingsPanel() {
  const existing = document.querySelector('#tac-extension-settings');
  if (existing) {
    const beautify = existing.querySelector('input[data-feature="beautify"]');
    const presets = existing.querySelector('input[data-feature="presets"]');
    if (beautify) beautify.checked = isBeautifyFeatureEnabled();
    if (presets) presets.checked = isPresetFeatureEnabled();
    return true;
  }
  const host = getExtensionSettingsHost();
  if (!host) return false;
  host.append(renderFeatureSettingsPanel());
  return true;
}

function startFeatureSettingsPanel() {
  const tryMount = () => {
    if (mountFeatureSettingsPanel()) return;
    setTimeout(tryMount, 500);
  };
  tryMount();
}

function applyFeatureState() {
  if (isBeautifyFeatureEnabled()) {
    startBeautifyFeature();
  } else {
    destroyBeautifyFeature();
  }

  if (isPresetFeatureEnabled()) {
    startPresetEntryGrouping();
  } else {
    destroyPresetEntryGrouping();
  }
}

function start() {
  startFeatureSettingsPanel();
  applyFeatureState();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
