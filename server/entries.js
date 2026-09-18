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

// 同一个模块下不允许出现重复的键，比较时忽略大小写；
// 其它文案改名前的旧键也算占用，因为旧键仍然指向那一条
function assertKeyFree(data, module, key, selfId) {
  const hit = data.entries.find((item) => item.module === module
    && item.id !== selfId
    && item.key.toLowerCase() === key.toLowerCase());
  if (hit) {
    throw new ApiError(409, 'KEY_DUPLICATED', `模块 ${module} 下已经有 ${hit.key} 这条文案了`, 'key');
  }
  const reserved = data.entries.find((item) => item.module === module
    && item.id !== selfId
    && (item.previousKeys || []).some((oldKey) => oldKey.toLowerCase() === key.toLowerCase()));
  if (reserved) {
    throw new ApiError(409, 'KEY_RESERVED', `${key} 是 ${reserved.key} 这条文案改名前的旧键，仍然指向它，请换一个键`, 'key');
  }
}

// 键真正变化时把旧键记到曾用键最前面；改回某个曾用键时把它从曾用键里拿掉
function recordKeyRename(entry, oldKey) {
  const kept = (entry.previousKeys || []).filter((item) => item.toLowerCase() !== entry.key.toLowerCase()
    && item.toLowerCase() !== oldKey.toLowerCase());
  entry.previousKeys = [oldKey].concat(kept);
}

function sortEntries(list) {
  return list.slice().sort((a, b) => {
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// 按模块与关键词筛选：关键词同时匹配文案键与任意一种语言的译文
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
      // 改名前的旧键也能搜到，搜出来的就是改名后的这一条
      if ((item.previousKeys || []).some((oldKey) => oldKey.toLowerCase().includes(keyword))) return true;
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
    previousKeys: [],
    translations,
    note,
    updatedBy: operator,
    createdAt: now,
    updatedAt: now,
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

  const oldKey = found.key;
  found.module = module;
  found.key = key;
  if (oldKey.toLowerCase() !== key.toLowerCase()) recordKeyRename(found, oldKey);
  found.translations = translations;
  found.note = note;
  found.updatedBy = operator;
  found.updatedAt = new Date().toISOString();
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

// 批量改键的入参：模块必填，find 是键里要替换掉的写法，replace 允许空串（把某段删掉）
function validateRenameRule(input) {
  const module = validateModule(input.module);
  const find = pickText(input.find);
  if (!find) throw new ApiError(400, 'FIND_REQUIRED', '请填写键里要替换的写法', 'find');
  if (find.length > MAX_KEY_LENGTH) {
    throw new ApiError(400, 'FIND_TOO_LONG', `要替换的写法不能超过 ${MAX_KEY_LENGTH} 个字符`, 'find');
  }
  if (input.replace !== undefined && input.replace !== null && typeof input.replace !== 'string') {
    throw new ApiError(400, 'REPLACE_INVALID', '替换成的内容需要是文本', 'replace');
  }
  const replace = pickText(input.replace);
  if (replace.length > MAX_KEY_LENGTH) {
    throw new ApiError(400, 'REPLACE_TOO_LONG', `替换成的内容不能超过 ${MAX_KEY_LENGTH} 个字符`, 'replace');
  }
  if (find === replace) {
    throw new ApiError(400, 'RENAME_NOOP', '替换前后的写法一样，没有需要改名的文案', 'replace');
  }
  return { module, find, replace };
}

// 批量改键的计划：模块下键里包含 find 的文案，把 find 的所有出现处换成 replace。
// 冲突按全部改名完成后的最终状态判定，批量内部的链式改名也能查准
function planKeyRename(data, rule) {
  const { module, find, replace } = rule;
  const changes = [];
  const problems = [];

  const finalKeys = new Map();
  data.entries.forEach((item) => finalKeys.set(item.id, item.key));

  data.entries.forEach((item) => {
    if (item.module !== module) return;
    if (!item.key.includes(find)) return;
    const to = item.key.split(find).join(replace);
    if (to === item.key) return;
    finalKeys.set(item.id, to);
    changes.push({ id: item.id, from: item.key, to });
  });

  changes.forEach((change) => {
    if (!change.to) {
      problems.push({ ...change, code: 'KEY_INVALID', message: `${change.from} 改名后键就空了，请调整替换规则` });
      return;
    }
    try {
      validateKey(change.to);
    } catch (err) {
      problems.push({ ...change, code: err.code, message: `${change.from} 改名后会是 ${change.to}：${err.message}` });
      return;
    }
    const clash = data.entries.find((item) => item.id !== change.id
      && item.module === module
      && finalKeys.get(item.id).toLowerCase() === change.to.toLowerCase());
    if (clash) {
      problems.push({ ...change, code: 'KEY_DUPLICATED', message: `${change.from} 改名后会是 ${change.to}，与模块 ${module} 下键为 ${clash.key} 的文案重复` });
      return;
    }
    const reserved = data.entries.find((item) => item.id !== change.id
      && item.module === module
      && (item.previousKeys || []).some((oldKey) => oldKey.toLowerCase() === change.to.toLowerCase()));
    if (reserved) {
      problems.push({ ...change, code: 'KEY_RESERVED', message: `${change.from} 改名后会是 ${change.to}，但它是 ${reserved.key} 改名前的旧键，仍指向那一条` });
    }
  });

  return { changes, problems };
}

// 预览：只算计划不落盘，页面据此展示条数与改名前后的一一对应
function previewKeyRename(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const rule = validateRenameRule(input);
  const { changes, problems } = planKeyRename(data, rule);
  return { ...rule, count: changes.length, changes, problems };
}

// 执行：计划重算一遍，任何问题都整批拒绝，全有或全无
function renameKeys(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const rule = validateRenameRule(input);
  const operator = validateOperator(input.operator, UNNAMED);
  const { changes, problems } = planKeyRename(data, rule);
  if (problems.length) {
    const first = problems[0];
    const status = first.code === 'KEY_DUPLICATED' || first.code === 'KEY_RESERVED' ? 409 : 400;
    throw new ApiError(status, first.code, `${first.message}。本次一条都没有改，请调整规则后再试`, 'replace');
  }
  if (!changes.length) {
    throw new ApiError(400, 'RENAME_NO_MATCH', `模块 ${rule.module} 下没有键里包含「${rule.find}」的文案，未做任何改动`, 'find');
  }

  const now = new Date().toISOString();
  const byId = new Map(data.entries.map((item) => [item.id, item]));
  changes.forEach((change) => {
    const entry = byId.get(change.id);
    const oldKey = entry.key;
    entry.key = change.to;
    recordKeyRename(entry, oldKey);
    entry.updatedBy = operator;
    entry.updatedAt = now;
  });
  save(data);
  return { ...rule, count: changes.length, changes };
}

module.exports = {
  listEntries,
  getEntry,
  createEntry,
  updateEntry,
  deleteEntry,
  previewKeyRename,
  renameKeys,
  validateModule,
  validateKey,
  validateTranslations,
  validateOperator,
};
