const crypto = require('crypto');
const { load, save, MAX_TRANSLATION_LENGTH, MAX_NOTE_LENGTH, MAX_OPERATOR_LENGTH, UNNAMED } = require('./store');
const { ApiError, pickText } = require('./errors');

const MODULE_PATTERN = /^[a-z][a-z0-9-]{0,29}$/;
const KEY_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;
const MAX_KEY_LENGTH = 120;

function validateModule(value) {
  const module = pickText(value);
  if (!module) throw new ApiError(400, 'MODULE_REQUIRED', '请填写模块名', 'module');
  if (!MODULE_PATTERN.test(module)) {
    throw new ApiError(400, 'MODULE_INVALID', '模块名要小写字母起头，后面可以跟数字与短横线，最长 30 个字符', 'module');
  }
  return module;
}

function validateKey(value) {
  const key = pickText(value);
  if (!key) throw new ApiError(400, 'KEY_REQUIRED', '请填写文案键', 'key');
  if (key.length > MAX_KEY_LENGTH) {
    throw new ApiError(400, 'KEY_TOO_LONG', `文案键不能超过 ${MAX_KEY_LENGTH} 个字符`, 'key');
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ApiError(400, 'KEY_INVALID', '文案键要写成 home.banner.title 这样的形式，由小写字母、数字、下划线与短横线组成，并用点号至少分成两段', 'key');
  }
  return key;
}

// 译文逐条校验：语言必须是登记过的，取值必须是文本，长度不能超过上限
function validateTranslations(raw, languages) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'TRANSLATIONS_INVALID', '译文需要按语言逐条填写', 'translations');
  }
  const known = new Map();
  languages.forEach((item) => known.set(item.code.toLowerCase(), item.code));

  const result = {};
  Object.keys(raw).forEach((code) => {
    const value = raw[code];
    const actual = known.get(String(code).toLowerCase());
    if (!actual) {
      throw new ApiError(400, 'LANGUAGE_UNKNOWN', `语言 ${code} 没有登记过，请先在语言区登记这种语言`, `translations.${code}`);
    }
    if (typeof value !== 'string') {
      throw new ApiError(400, 'TRANSLATION_INVALID', `${actual} 的译文需要是文本`, `translations.${actual}`);
    }
    if (value.length > MAX_TRANSLATION_LENGTH) {
      throw new ApiError(400, 'TRANSLATION_TOO_LONG', `${actual} 的译文不能超过 ${MAX_TRANSLATION_LENGTH} 个字符，当前 ${value.length} 个字符`, `translations.${actual}`);
    }
    // 留空表示这条还没翻译，原样保留一个空串，方便页面上看出是空的还是根本没这一项
    result[actual] = value;
  });
  return result;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'NOTE_INVALID', '备注需要是文本', 'note');
  }
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

// 操作者：页面顶栏填的名字，留空按未署名记录，只做长度检查
function validateOperator(value, fallback) {
  if (value === undefined || value === null) return fallback || UNNAMED;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'OPERATOR_INVALID', '操作者需要是文本', 'operator');
  }
  const name = value.trim();
  if (!name) return UNNAMED;
  if (name.length > MAX_OPERATOR_LENGTH) {
    throw new ApiError(400, 'OPERATOR_TOO_LONG', `操作者名字不能超过 ${MAX_OPERATOR_LENGTH} 个字符`, 'operator');
  }
  return name;
}

// 同一个模块下不允许出现重复的键，比较时忽略大小写。既要比别人的当前键，
// 也要比别人的曾用键：曾用键仍然会查询到原来那条文案，被占用时指明是哪一条
function assertKeyFree(data, module, key, selfId) {
  const lower = key.toLowerCase();
  const hit = data.entries.find((item) => item.module === module
    && item.id !== selfId
    && item.key.toLowerCase() === lower);
  if (hit) {
    throw new ApiError(409, 'KEY_DUPLICATED', `模块 ${module} 下的 ${key} 已被文案「${hit.key}」（编号 ${hit.id}）占用`, 'key');
  }
  const aliasHit = data.entries.find((item) => item.id !== selfId
    && (item.previousKeys || []).some((alias) => alias.module === module && alias.key.toLowerCase() === lower));
  if (aliasHit) {
    throw new ApiError(409, 'KEY_ALIAS_TAKEN', `模块 ${module} 下的 ${key} 是文案「${aliasHit.key}」（编号 ${aliasHit.id}）的曾用键，仍会查询到那条文案，不能重复使用`, 'key');
  }
}

// 改名时把旧写法记进曾用键，旧键仍然可以查询到这条文案；如果新写法自己就是
// 一条曾用键（改回旧名字），那它从现在起是正式写法，不再算曾用
function applyRename(entry, module, key, renamedAt) {
  if (entry.module === module && entry.key === key) return false;
  const kept = (Array.isArray(entry.previousKeys) ? entry.previousKeys : [])
    .filter((alias) => !(alias.module === module && alias.key === key));
  const already = kept.some((alias) => alias.module === entry.module && alias.key === entry.key);
  if (!already) kept.push({ module: entry.module, key: entry.key, renamedAt });
  entry.previousKeys = kept;
  entry.module = module;
  entry.key = key;
  return true;
}

function sortEntries(list) {
  return list.slice().sort((a, b) => {
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// 按模块与关键词筛选：关键词同时匹配文案键、曾用键与任意一种语言的译文
function listEntries(options) {
  const input = options && typeof options === 'object' ? options : {};
  const module = pickText(input.module);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.entries;
  if (module) list = list.filter((item) => item.module === module);
  if (keyword) {
    list = list.filter((item) => {
      if (item.key.toLowerCase().includes(keyword)) return true;
      const aliases = Array.isArray(item.previousKeys) ? item.previousKeys : [];
      const hitAlias = aliases.some((alias) => alias.key.toLowerCase().includes(keyword)
        || alias.module.toLowerCase().includes(keyword));
      if (hitAlias) return true;
      return Object.keys(item.translations).some((code) => item.translations[code].toLowerCase().includes(keyword));
    });
  }

  const counts = {};
  data.entries.forEach((item) => {
    counts[item.module] = (counts[item.module] || 0) + 1;
  });
  const modules = Object.keys(counts).sort().map((name) => ({ module: name, count: counts[name] }));

  return { entries: sortEntries(list), modules };
}

function getEntry(id) {
  const data = load();
  const found = data.entries.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ENTRY_NOT_FOUND', '这条文案不存在或已被删除', '');
  return found;
}

function createEntry(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const module = validateModule(input.module);
  const key = validateKey(input.key);
  const translations = validateTranslations(input.translations, data.languages);
  const note = validateNote(input.note);
  const operator = validateOperator(input.operator, UNNAMED);
  assertKeyFree(data, module, key, '');

  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    module,
    key,
    translations,
    note,
    updatedBy: operator,
    createdAt: now,
    updatedAt: now,
    previousKeys: [],
  };
  data.entries.push(created);
  save(data);
  return created;
}

function updateEntry(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.entries.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ENTRY_NOT_FOUND', '这条文案不存在或已被删除', '');

  const module = input.module === undefined ? found.module : validateModule(input.module);
  const key = input.key === undefined ? found.key : validateKey(input.key);
  const translations = input.translations === undefined
    ? found.translations
    : validateTranslations(input.translations, data.languages);
  const note = input.note === undefined ? found.note : validateNote(input.note);
  const operator = validateOperator(input.operator, found.updatedBy);
  assertKeyFree(data, module, key, found.id);

  const now = new Date().toISOString();
  applyRename(found, module, key, now);
  found.translations = translations;
  found.note = note;
  found.updatedBy = operator;
  found.updatedAt = now;
  save(data);
  return found;
}

function deleteEntry(id) {
  const data = load();
  const index = data.entries.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'ENTRY_NOT_FOUND', '这条文案不存在或已被删除', '');
  const [removed] = data.entries.splice(index, 1);
  save(data);
  return { id: removed.id, key: removed.key };
}

// 按模块与键查询文案：先比当前写法，再比曾用键，旧键依然指向改名后的那一条
function resolveEntry(moduleValue, keyValue) {
  const module = pickText(moduleValue);
  const key = pickText(keyValue);
  if (!module) throw new ApiError(400, 'MODULE_REQUIRED', '请填写模块名', 'module');
  if (!key) throw new ApiError(400, 'KEY_REQUIRED', '请填写文案键', 'key');
  const data = load();
  const lower = key.toLowerCase();
  const current = data.entries.find((item) => item.module === module && item.key.toLowerCase() === lower);
  if (current) return { match: 'current', requested: { module, key }, entry: current };
  const viaAlias = data.entries.find((item) => (item.previousKeys || [])
    .some((alias) => alias.module === module && alias.key.toLowerCase() === lower));
  if (viaAlias) {
    const alias = viaAlias.previousKeys.find((item) => item.module === module && item.key.toLowerCase() === lower);
    return { match: 'alias', requested: { module, key }, alias, entry: viaAlias };
  }
  throw new ApiError(404, 'ENTRY_NOT_FOUND', `模块 ${module} 下没有 ${key} 这条文案，它也不是任何文案的曾用键`, '');
}

// 批量改名的替换规则：查找内容必填，替换为可以留空（表示把查到的部分删掉），
// 模块范围留空表示全部模块；规则同时作用于模块名与文案键
function validateRenameRule(input) {
  const find = pickText(input.find);
  if (!find) throw new ApiError(400, 'RENAME_FIND_REQUIRED', '请填写要查找的内容', 'find');
  if (find.length > MAX_KEY_LENGTH) {
    throw new ApiError(400, 'RENAME_FIND_TOO_LONG', `查找内容不能超过 ${MAX_KEY_LENGTH} 个字符`, 'find');
  }
  let replace = '';
  if (input.replace !== undefined && input.replace !== null) {
    if (typeof input.replace !== 'string') {
      throw new ApiError(400, 'RENAME_REPLACE_INVALID', '替换为需要是文本', 'replace');
    }
    replace = input.replace.trim();
    if (replace.length > MAX_KEY_LENGTH) {
      throw new ApiError(400, 'RENAME_REPLACE_TOO_LONG', `替换为不能超过 ${MAX_KEY_LENGTH} 个字符`, 'replace');
    }
  }
  const scope = pickText(input.module);
  if (scope && !MODULE_PATTERN.test(scope)) {
    throw new ApiError(400, 'MODULE_INVALID', '模块名要小写字母起头，后面可以跟数字与短横线，最长 30 个字符', 'renameModule');
  }
  return { scope, find, replace };
}

// 把规则套到候选文案上，给出每一条改名前后的对应关系；改完之后写法不合法的、
// 撞上别人（当前键或曾用键）的、互相撞车的，都单独列进 problems
function planRenames(data, scope, find, replace) {
  const apply = (text) => text.split(find).join(replace);
  const candidates = [];
  data.entries.forEach((item) => {
    if (scope && item.module !== scope) return;
    const newModule = apply(item.module);
    const newKey = apply(item.key);
    if (newModule === item.module && newKey === item.key) return;
    candidates.push({ id: item.id, module: item.module, key: item.key, newModule, newKey });
  });

  const changing = new Set(candidates.map((item) => item.id));
  const targets = new Map();
  const changes = [];
  const problems = [];
  candidates.forEach((change) => {
    const lowerKey = change.newKey.toLowerCase();
    if (!MODULE_PATTERN.test(change.newModule)) {
      problems.push({ ...change, reason: `新模块名 ${change.newModule || '（空）'} 不符合模块的写法要求` });
      return;
    }
    if (change.newKey.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(change.newKey)) {
      problems.push({ ...change, reason: `新文案键 ${change.newKey || '（空）'} 不符合文案键的写法要求` });
      return;
    }
    const signature = `${change.newModule}\n${lowerKey}`;
    const first = targets.get(signature);
    if (first) {
      problems.push({ ...change, reason: `与 ${first.key} 改名后的写法一模一样，两条会撞在一起` });
      return;
    }
    targets.set(signature, change);
    // 同批改名的条目会同时让出旧写法，所以只占未参与本次改名的条目的位置才算撞车
    const occupant = data.entries.find((item) => !changing.has(item.id)
      && item.module === change.newModule
      && item.key.toLowerCase() === lowerKey);
    if (occupant) {
      problems.push({ ...change, reason: `新写法已被文案「${occupant.key}」（编号 ${occupant.id}）占用`, occupiedBy: { id: occupant.id, key: occupant.key } });
      return;
    }
    const aliasOwner = data.entries.find((item) => item.id !== change.id
      && (item.previousKeys || []).some((alias) => alias.module === change.newModule && alias.key.toLowerCase() === lowerKey));
    if (aliasOwner) {
      problems.push({ ...change, reason: `新写法是文案「${aliasOwner.key}」（编号 ${aliasOwner.id}）的曾用键，仍会查询到那条文案`, occupiedBy: { id: aliasOwner.id, key: aliasOwner.key } });
      return;
    }
    changes.push(change);
  });
  return { changes, problems };
}

// 预览：把规则的作用结果原样返回，页面上给出条数与改名前后的一一对应
function previewRename(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const rule = validateRenameRule(input);
  const data = load();
  const { changes, problems } = planRenames(data, rule.scope, rule.find, rule.replace);
  return { module: rule.scope, find: rule.find, replace: rule.replace, total: changes.length, changes, problems };
}

// 确认执行：规则重新套一遍并整体校验，任何一条不成立就全部不改
function executeRename(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const rule = validateRenameRule(input);
  const operator = validateOperator(input.operator, UNNAMED);
  const data = load();
  const { changes, problems } = planRenames(data, rule.scope, rule.find, rule.replace);
  if (problems.length) {
    const first = problems[0];
    throw new ApiError(409, 'RENAME_CONFLICT', `有 ${problems.length} 条文案无法按规则改名，例如 ${first.key}：${first.reason}。本次改名已整体取消`, '');
  }
  if (!changes.length) {
    throw new ApiError(400, 'RENAME_EMPTY', '没有文案会被这条规则改动', 'find');
  }
  const now = new Date().toISOString();
  const byId = new Map(data.entries.map((item) => [item.id, item]));
  changes.forEach((change) => {
    const entry = byId.get(change.id);
    if (!entry) return;
    applyRename(entry, change.newModule, change.newKey, now);
    entry.updatedBy = operator;
    entry.updatedAt = now;
  });
  save(data);
  return { renamed: changes.length, changes };
}

module.exports = {
  listEntries,
  getEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  resolveEntry,
  previewRename,
  executeRename,
  validateModule,
  validateKey,
  validateTranslations,
  validateOperator,
};
