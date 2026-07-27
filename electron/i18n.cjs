function normalizeUiLanguage(value, allowEnglish = true) {
  if (!allowEnglish) return 'zh-CN';
  const normalized = String(value || '').toLowerCase();
  if (normalized.startsWith('zh')) return 'zh-CN';
  if (normalized.startsWith('en')) return 'en-US';
  return 'en-US';
}

function tr(language, chinese, english) {
  return language === 'en-US' ? english : chinese;
}

function systemUiLanguage(allowEnglish = true) {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || process.env.LANG || '';
  return normalizeUiLanguage(locale, allowEnglish);
}

module.exports = { normalizeUiLanguage, systemUiLanguage, tr };
