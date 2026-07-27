const EDITIONS = {
  standard: {
    id: 'standard',
    productName: 'AniLog',
    appId: 'io.anilog.desktop',
    usesBangumi: true,
  },
  original: {
    id: 'original',
    productName: 'AniLog Original',
    appId: 'io.anilog.desktop.original',
    usesBangumi: false,
  },
};

function editionFromEnvironment(environment = process.env) {
  return environment.ANILOG_EDITION === 'original' ? EDITIONS.original : EDITIONS.standard;
}

function normalizeTitlePreference(value) {
  return ['auto', 'english', 'romaji', 'native'].includes(value) ? value : 'auto';
}

function titleForPreference(title, preference = 'auto', language = 'zh-CN') {
  const orders = {
    auto: ['english', 'romaji', 'native'],
    english: ['english', 'romaji', 'native'],
    romaji: ['romaji', 'english', 'native'],
    native: ['native', 'romaji', 'english'],
  };
  const order = orders[normalizeTitlePreference(preference)];
  return order.map((key) => title?.[key]).find(Boolean) || (language === 'en-US' ? 'Untitled anime' : '未命名番剧');
}

function productName(edition, language = 'zh-CN') {
  return edition.id === 'original' && language === 'zh-CN' ? 'AniLog 原名版' : edition.productName;
}

module.exports = {
  EDITIONS,
  editionFromEnvironment,
  normalizeTitlePreference,
  productName,
  titleForPreference,
};
