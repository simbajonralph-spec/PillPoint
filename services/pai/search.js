const db = require('../../db/database');
const { eligibleBatchQuantitySql, publishedProductSql } = require('../inventory-batches');

function normalizeText(value) {
  return (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const dp = Array.from({ length: b.length + 1 }, () => Array(a.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[0][i] = i;
  for (let j = 0; j <= b.length; j += 1) dp[j][0] = j;

  for (let j = 1; j <= b.length; j += 1) {
    for (let i = 1; i <= a.length; i += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j][i] = Math.min(
        dp[j - 1][i] + 1,
        dp[j][i - 1] + 1,
        dp[j - 1][i - 1] + cost
      );
    }
  }

  return dp[b.length][a.length];
}

function similarityScore(a, b) {
  const longer = Math.max(a.length, b.length) || 1;
  const distance = levenshtein(a, b);
  return 1 - distance / longer;
}

function normalizedMedicineName(value) {
  return normalizeText(value).split(' ')
    .filter(token => !/^\d+(?:mg|mcg|g|ml|l|iu|%)?$/i.test(token))
    .join(' ');
}

function buildMedicineCandidates(query) {
  const cleaned = normalizeText(query);
  if (!cleaned) return { best: null, matches: [] };

  const medicines = db.prepare('SELECT id, name, category FROM medicines').all();
  const ranked = medicines
    .map((medicine) => {
      const name = normalizeText(medicine.name);
      const baseName = normalizedMedicineName(medicine.name);
      let score = 0;

      if (name === cleaned) score = 1;
      else if (baseName === cleaned) score = 1;
      else if (baseName.includes(cleaned) || cleaned.includes(baseName)) score = 0.95;
      else {
        const queryTokens = cleaned.split(' ');
        const nameTokens = baseName.split(' ');
        const tokenScores = queryTokens.map(queryToken => {
          const scores = nameTokens.map(nameToken => {
            if (queryToken === nameToken) return 1;
            if (queryToken.length < 4 || nameToken.length < 4) return 0;
            return similarityScore(queryToken, nameToken);
          });
          return Math.max(0, ...scores);
        });
        const tokenScore = tokenScores.reduce((total, value) => total + value, 0) / queryTokens.length;
        const exactPhraseScore = similarityScore(cleaned, baseName);
        score = Math.max(tokenScore, exactPhraseScore);
      }

      return { medicine, score };
    })
    .filter(entry => entry.score > 0.35)
    .sort((a, b) => b.score - a.score || a.medicine.name.localeCompare(b.medicine.name));

  if (!ranked.length) {
    return { best: null, matches: [] };
  }

  return {
    best: ranked[0].medicine,
    medicines: ranked.map(entry => entry.medicine),
    matches: ranked.slice(0, 5).map(entry => ({
      id: entry.medicine.id,
      name: entry.medicine.name,
      category: entry.medicine.category,
      score: Number(entry.score.toFixed(2)),
    })),
  };
}

function extractPriceLimit(text) {
  const match = (text || '').match(/(?:under|below|within|less than|max|budget|up to)\s*(?:php\s*)?(\d+(?:\.\d+)?)/i);
  if (!match) return null;
  return Number(match[1]);
}

function parseMedicineQuery(rawQuery) {
  const text = (rawQuery || '').trim();
  const priceLimit = extractPriceLimit(text);

  const medicineCandidate = text.match(/(?:find|show|where can i buy|where can i find|do you have|looking for|need|search for)\s+(?:medicine\s+)?(.+)/i)
    || text.match(/(?:for|about|with)\s+([a-z0-9 ]{2,})/i)
    || text.match(/([a-z0-9][a-z0-9\s]{2,})/i);

  const queryText = medicineCandidate ? medicineCandidate[1].replace(/\s+(?:under|below|within|less than|max|budget|up to)\b.*$/i, '').trim() : text;
  const candidates = buildMedicineCandidates(queryText);

  return {
    query: text,
    medicine: candidates.best ? candidates.best.name : null,
    medicine_id: candidates.best ? candidates.best.id : null,
    max_price: priceLimit,
    confidence: candidates.best ? (candidates.matches[0]?.score || 0.75) : 0,
    suggestions: candidates.matches,
  };
}

function searchVerifiedInventory(options = {}) {
  const { query = '', max_price = null, medicine_id = null, pharmacy_id = null, inventory_ids = [] } = options;
  const eligibleQuantity = eligibleBatchQuantitySql('i');
  const availableQuantity = `MAX(0, MIN(i.stock_quantity, ${eligibleQuantity}) -
    COALESCE((SELECT SUM(r.quantity) FROM reservations r WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup')), 0))`;
  const pharmacyHasAvailable = `EXISTS (
    SELECT 1 FROM inventory available
    JOIN medicines available_medicine ON available_medicine.id = available.medicine_id
    WHERE available.pharmacy_id = p.id
      AND ${publishedProductSql('available', 'available_medicine')}
  )`;

  let sql = `
    SELECT i.id AS inventory_id, i.price, i.stock_quantity, i.low_stock_threshold, i.brand, i.deployed,
      COALESCE((SELECT SUM(r.quantity) FROM reservations r WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup')), 0) AS reserved_quantity,
      ${availableQuantity} AS available_quantity,
      m.id AS medicine_id, m.name AS medicine_name, m.category,
      p.id AS pharmacy_id, p.name AS pharmacy_name, p.address, p.latitude, p.longitude,
      COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) AS verification_status,
      p.verified, p.store_image, p.profile_image, p.cover_image, p.description, p.hours,
      ${availableQuantity} AS available_stock,
      CASE WHEN ${pharmacyHasAvailable}
        THEN 'Available' ELSE 'No stock currently available' END AS pharmacy_status,
      (SELECT ROUND(AVG(rating), 1) FROM pharmacy_ratings WHERE pharmacy_id = p.id) AS average_rating,
      (SELECT COUNT(*) FROM pharmacy_ratings WHERE pharmacy_id = p.id) AS rating_count
    FROM inventory i
    JOIN medicines m ON m.id = i.medicine_id
    JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      AND ${publishedProductSql('i', 'm')}
      AND ${availableQuantity} > 0
  `;

  const params = [];

  if (medicine_id) {
    sql += ' AND i.medicine_id = ?';
    params.push(medicine_id);
  } else if (query) {
    sql += ' AND m.name LIKE ?';
    params.push(`%${query}%`);
  }

  if (Number.isInteger(Number(pharmacy_id)) && Number(pharmacy_id) > 0) {
    sql += ' AND p.id = ?';
    params.push(Number(pharmacy_id));
  }

  const safeInventoryIds = [...new Set((Array.isArray(inventory_ids) ? inventory_ids : [])
    .map(Number)
    .filter(id => Number.isInteger(id) && id > 0))].slice(0, 20);
  if (safeInventoryIds.length) {
    sql += ` AND i.id IN (${safeInventoryIds.map(() => '?').join(',')})`;
    params.push(...safeInventoryIds);
  } else if (Array.isArray(inventory_ids) && inventory_ids.length) {
    return [];
  }

  if (Number.isFinite(max_price)) {
    sql += ' AND i.price <= ?';
    params.push(max_price);
  }

  sql += ' ORDER BY i.price ASC, m.name ASC';

  return db.prepare(sql).all(...params);
}

module.exports = {
  normalizeText,
  buildMedicineCandidates,
  parseMedicineQuery,
  searchVerifiedInventory,
  similarityScore,
};
