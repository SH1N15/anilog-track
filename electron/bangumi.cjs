const { items: bangumiItems } = require('bangumi-data');

const BANGUMI_RESOLVER_VERSION = 4;

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function normalizeComparableTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\bfirst\s+season\b/gi, 'season1')
    .replace(/\bsecond\s+season\b/gi, 'season2')
    .replace(/\bthird\s+season\b/gi, 'season3')
    .replace(/\bfourth\s+season\b/gi, 'season4')
    .replace(/第\s*(\d+)\s*[季期]/gi, 'season$1')
    .replace(/シーズン\s*(\d+)/gi, 'season$1')
    .replace(/(\d+)(?:st|nd|rd|th)\s*season/gi, 'season$1')
    .replace(/season\s*(\d+)/gi, 'season$1')
    .replace(/(\d+)\s*期/gi, 'season$1')
    .replace(/第?\s*(\d+)\s*クール/gi, 'part$1')
    .replace(/(?:part|cour)\s*(\d+)/gi, 'part$1')
    .replace(/(\d+)(?:st|nd|rd|th)/gi, '$1')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function bangumiSearchKeywords(anime) {
  const keywords = [];
  const add = (value) => {
    const keyword = String(value || '').trim();
    if (keyword && !keywords.includes(keyword)) keywords.push(keyword);
  };

  const titles = [anime.title?.native, anime.title?.romaji, anime.title?.english].filter(Boolean);
  for (const title of titles) {
    const withoutYear = String(title).replace(/\s*[（(]\s*(?:19|20)\d{2}\s*[)）]/gu, '').trim();
    const releaseMarker = withoutYear.match(/\s*(?:[-–—:：]\s*)?(?:第\s*\d+\s*[季期]|シーズン\s*\d+|第?\s*\d+\s*クール|(?:\d+(?:st|nd|rd|th)\s*|first\s+|second\s+|third\s+|fourth\s+)?season(?:\s*\d+)?|(?:part|cour)\s*\d+)/iu);
    const baseTitle = releaseMarker?.index ? withoutYear.slice(0, releaseMarker.index).trim() : withoutYear;
    add(title);
    add(withoutYear);
    add(baseTitle);
  }

  return keywords.slice(0, 4);
}

const offlineTitleIndex = new Map();
const offlineAniListIndex = new Map();
for (const item of bangumiItems) {
  const aliases = [item.title, ...(item.titleTranslate?.ja || []), ...(item.titleTranslate?.en || [])];
  for (const alias of aliases) {
    const key = normalizeTitle(alias);
    if (!key) continue;
    if (!offlineTitleIndex.has(key)) offlineTitleIndex.set(key, []);
    offlineTitleIndex.get(key).push(item);
  }

  const aniListSite = item.sites?.find((site) => site.site === 'aniList');
  if (aniListSite?.id && chineseTitleOf(item) && bangumiIdOf(item)) {
    const animeId = Number(aniListSite.id);
    if (!offlineAniListIndex.has(animeId)) offlineAniListIndex.set(animeId, []);
    offlineAniListIndex.get(animeId).push(item);
  }
}

function yearOf(anime) {
  return anime.startDate?.year || anime.seasonYear || null;
}

function scoreCandidate(anime, candidate) {
  if (candidate.type !== 2) return -1;

  const candidateName = normalizeComparableTitle(candidate.name);
  const native = normalizeComparableTitle(anime.title?.native);
  const romaji = normalizeComparableTitle(anime.title?.romaji);
  const english = normalizeComparableTitle(anime.title?.english);
  let score = 0;

  if (native && candidateName === native) score += 72;
  else if (native && (candidateName.includes(native) || native.includes(candidateName))) score += 52;
  if (romaji && candidateName === romaji) score += 45;
  if (english && candidateName === english) score += 42;
  if (score === 0) {
    const similarity = Math.max(
      characterBigramSimilarity(candidateName, native),
      characterBigramSimilarity(candidateName, romaji),
      characterBigramSimilarity(candidateName, english),
    );
    if (similarity >= 0.82) score += 42;
    else if (similarity >= 0.7) score += 30;
    else if (similarity >= 0.58) score += 18;
  }
  if (candidate.name_cn?.trim()) score += 10;

  const animeSeason = seasonNumber([anime.title?.native, anime.title?.romaji, anime.title?.english].filter(Boolean).join(' '));
  const candidateSeason = seasonNumber(`${candidate.name || ''} ${candidate.name_cn || ''}`);
  if (animeSeason && candidateSeason) score += animeSeason === candidateSeason ? 16 : -24;
  else if (animeSeason && !candidateSeason) score -= 16;

  const animePart = partNumber([anime.title?.native, anime.title?.romaji, anime.title?.english].filter(Boolean).join(' '));
  const candidatePart = partNumber(`${candidate.name || ''} ${candidate.name_cn || ''}`);
  if (animePart && candidatePart) score += animePart === candidatePart ? 16 : -24;
  else if (animePart && !candidatePart) score -= 16;

  const animeStages = stageNumbers([anime.title?.native, anime.title?.romaji, anime.title?.english].filter(Boolean).join(' '));
  const candidateStages = stageNumbers(candidate.name);
  if (animeStages.length && candidateStages.length) {
    score += sameNumberSet(animeStages, candidateStages) ? 18 : animeStages.some((number) => candidateStages.includes(number)) ? 4 : -24;
  }

  const animeYear = yearOf(anime);
  const candidateYear = Number(String(candidate.date || '').slice(0, 4));
  const animeDate = dateOf(anime);
  const candidateDate = String(candidate.date || '').slice(0, 10);
  if (animeDate && /^\d{4}-\d{2}-\d{2}$/.test(candidateDate) && animeDate === candidateDate) {
    score += 32;
  } else if (animeYear && candidateYear) {
    const difference = Math.abs(animeYear - candidateYear);
    const animeMonth = anime.startDate?.month;
    const candidateMonth = Number(candidateDate.slice(5, 7));
    if (difference === 0 && animeMonth && animeMonth === candidateMonth) score += 14;
    else if (difference === 0) score += 8;
    else if (difference === 1) score += 3;
    else if (difference >= 3) score -= 18;
  }

  const platform = String(candidate.platform || '').toUpperCase();
  if (anime.format === 'TV' && platform === 'TV') score += 7;
  if (anime.format === 'MOVIE' && /MOVIE|剧场|劇場/.test(platform)) score += 7;
  if (['ONA', 'TV_SHORT'].includes(anime.format) && /WEB|ONA/.test(platform)) score += 5;

  return score;
}

function dateOf(anime) {
  const { year, month, day } = anime.startDate || {};
  if (!year || !month || !day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function stageNumbers(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  if (!text.includes('stage')) return [];
  return [...new Set([...text.matchAll(/(\d+)(?:st|nd|rd|th)?/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
}

function sameNumberSet(left, right) {
  return left.length === right.length && left.every((number, index) => number === right[index]);
}

function characterBigramSimilarity(left, right) {
  const leftChars = [...String(left || '')];
  const rightChars = [...String(right || '')];
  if (leftChars.length < 4 || rightChars.length < 4) return 0;
  const leftPairs = new Set(leftChars.slice(0, -1).map((char, index) => char + leftChars[index + 1]));
  const rightPairs = new Set(rightChars.slice(0, -1).map((char, index) => char + rightChars[index + 1]));
  let overlap = 0;
  leftPairs.forEach((pair) => { if (rightPairs.has(pair)) overlap += 1; });
  return (2 * overlap) / (leftPairs.size + rightPairs.size);
}

function matchBangumiCandidates(anime, candidates) {
  const ranked = (candidates || [])
    .map((candidate) => ({ candidate, score: scoreCandidate(anime, candidate) }))
    .filter(({ candidate, score }) => score >= 0 && candidate.name_cn?.trim())
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 68) {
    return { status: 'unmatched', confidence: best?.score || 0, candidates: ranked.slice(0, 3).map(toCandidate) };
  }

  const second = ranked[1];
  if (second && best.score - second.score < 8) {
    const nearBest = ranked.filter(({ score }) => best.score - score < 8);
    const aggregate = aggregateCandidates(anime, nearBest, 'api-aggregate', best.score);
    if (aggregate) return aggregate;
    return { status: 'ambiguous', confidence: best.score, candidates: ranked.slice(0, 3).map(toCandidate) };
  }

  return {
    status: 'matched',
    subjectId: best.candidate.id,
    name: best.candidate.name,
    nameCn: best.candidate.name_cn.trim(),
    confidence: best.score,
    source: 'title-match',
    candidates: ranked.slice(0, 3).map(toCandidate),
  };
}

function matchOfflineBangumi(anime) {
  const mappedItems = offlineAniListIndex.get(Number(anime.id));
  if (mappedItems?.length) {
    const mapped = matchAniListMappedItems(anime, mappedItems);
    if (mapped) return mapped;
  }

  const keys = [anime.title?.native, anime.title?.romaji, anime.title?.english]
    .map(normalizeTitle)
    .filter(Boolean);
  const uniqueItems = new Map();
  keys.forEach((key) => {
    (offlineTitleIndex.get(key) || []).forEach((item) => uniqueItems.set(item.title, item));
  });

  const candidates = [...uniqueItems.values()].map(candidateFromItem).filter(Boolean);

  if (candidates.length === 0) return null;
  return matchBangumiCandidates(anime, candidates);
}

function matchAniListMappedItems(anime, items) {
  const candidates = items.map(candidateFromItem).filter(Boolean);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return directIdMatch(candidates[0]);

  const animeTitles = new Set([anime.title?.native, anime.title?.romaji, anime.title?.english].map(normalizeTitle).filter(Boolean));
  const exact = candidates.filter((candidate) => animeTitles.has(normalizeTitle(candidate.name)));
  if (exact.length === 1) return directIdMatch(exact[0]);

  const ranked = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(anime, candidate) }))
    .sort((a, b) => b.score - a.score);
  const bestScore = ranked[0]?.score || 0;
  const nearBest = ranked.filter(({ score }) => bestScore - score < 8);
  if (nearBest.length === 1 && bestScore >= 68) return directIdMatch(nearBest[0].candidate);

  const aggregate = aggregateCandidates(anime, nearBest, 'anilist-id-aggregate', 96);
  if (aggregate) return aggregate;
  return { status: 'ambiguous', confidence: bestScore, source: 'anilist-id', candidates: ranked.slice(0, 5).map(toCandidate) };
}

function directIdMatch(candidate) {
  return {
    status: 'matched',
    subjectId: candidate.id,
    subjectIds: [candidate.id],
    name: candidate.name,
    nameCn: candidate.name_cn.trim(),
    confidence: 100,
    source: 'anilist-id',
    candidates: [toCandidate({ candidate, score: 100 })],
  };
}

function aggregateCandidates(anime, ranked, source, confidence) {
  if (ranked.length < 2) return null;
  const prefix = meaningfulCommonPrefix(ranked.map(({ candidate }) => candidate.name_cn.trim()));
  if (!prefix) return null;
  return {
    status: 'matched',
    subjectIds: ranked.map(({ candidate }) => candidate.id),
    name: anime.title?.native || ranked[0].candidate.name,
    nameCn: prefix,
    confidence,
    source,
    candidates: ranked.slice(0, 5).map(toCandidate),
  };
}

function meaningfulCommonPrefix(titles) {
  if (titles.length < 2 || titles.some((title) => !title)) return '';
  let prefix = titles[0];
  for (const title of titles.slice(1)) {
    let index = 0;
    while (index < prefix.length && index < title.length && prefix[index] === title[index]) index += 1;
    prefix = prefix.slice(0, index);
    if (!prefix) return '';
  }
  prefix = prefix.trim().replace(/[（(【\[·・:：\-—–、/]+$/u, '').trim();
  const prefixLength = [...prefix].length;
  const shortestLength = Math.min(...titles.map((title) => [...title].length));
  return prefixLength >= 4 && prefixLength / shortestLength >= 0.5 ? prefix : '';
}

function seasonNumber(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  const numeric = text.match(/(?:season\s*(\d+)|シーズン\s*(\d+)|第\s*(\d+)\s*[季期]|(\d+)(?:st|nd|rd|th)\s*season|(\d+)\s*期)/i);
  if (numeric) return Number(numeric.slice(1).find(Boolean));
  const ordinal = text.match(/\b(first|second|third|fourth)\s+season\b/i)?.[1];
  return ordinal ? { first: 1, second: 2, third: 3, fourth: 4 }[ordinal] : null;
}

function partNumber(value) {
  const text = String(value || '').normalize('NFKC').toLowerCase();
  const match = text.match(/(?:第?\s*(\d+)\s*クール|(?:part|cour)\s*(\d+))/i);
  return match ? Number(match.slice(1).find(Boolean)) : null;
}

function chineseTitleOf(item) {
  return item.titleTranslate?.['zh-Hans']?.[0] || item.titleTranslate?.['zh-Hant']?.[0] || '';
}

function bangumiIdOf(item) {
  return Number(item.sites?.find((site) => site.site === 'bangumi')?.id) || null;
}

function candidateFromItem(item) {
  const id = bangumiIdOf(item);
  const nameCn = chineseTitleOf(item);
  if (!id || !nameCn) return null;
  const platforms = { tv: 'TV', web: 'WEB', movie: 'MOVIE', ova: 'OVA' };
  return {
    id,
    type: 2,
    name: item.title,
    name_cn: nameCn,
    date: item.begin,
    platform: platforms[item.type] || item.type,
  };
}

function toCandidate({ candidate, score }) {
  return {
    subjectId: candidate.id,
    name: candidate.name,
    nameCn: candidate.name_cn?.trim() || '',
    date: candidate.date || null,
    platform: candidate.platform || null,
    score,
  };
}

module.exports = {
  BANGUMI_RESOLVER_VERSION,
  bangumiSearchKeywords,
  matchBangumiCandidates,
  matchOfflineBangumi,
  meaningfulCommonPrefix,
  normalizeComparableTitle,
  normalizeTitle,
  scoreCandidate,
};
