const { PaiUnavailableError, requestJsonCompletion } = require('./gemini');

const MAX_MESSAGE_LENGTH = 500;
const MAX_ANSWER_LENGTH = 2000;
const MAX_ANALYTIC_ITEMS = 5;
const FALLBACK_NOTICE = 'AI-generated explanations are temporarily unavailable. This answer uses current PillPoint analytics.';
const ANSWER_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
};

function compactSection(section, maxItems = MAX_ANALYTIC_ITEMS) {
  if (Array.isArray(section)) return section.slice(0, maxItems);
  if (!section || typeof section !== 'object') return section;
  return {
    ...section,
    ...(Array.isArray(section.items) ? { items: section.items.slice(0, maxItems) } : {}),
  };
}

function compactPharmacyInsights(insights) {
  return {
    insights: Array.isArray(insights.insights) ? insights.insights.slice(0, 8) : insights.insights,
    summary: insights.summary,
    stock_risk: compactSection(insights.stock_risk),
    demand_analysis: compactSection(insights.demand_analysis),
    top_searched: compactSection(insights.top_searched),
    expiry_risk: compactSection(insights.expiry_risk),
    price_analysis: compactSection(insights.price_analysis),
    performance_summary: insights.performance_summary,
    inventory_quantities: insights.inventory_quantities,
    stock_movements: compactSection(insights.stock_movements),
    data_quality: insights.data_quality,
  };
}

function compactAdminInsights(insights) {
  return {
    generated_at: insights.generated_at,
    reporting_period: insights.reporting_period,
    summary: insights.summary,
    pharmacy_participation: insights.pharmacy_participation ? {
      summary: insights.pharmacy_participation.summary,
      pharmacies: Array.isArray(insights.pharmacy_participation.pharmacies)
        ? insights.pharmacy_participation.pharmacies.slice(0, 10)
        : [],
    } : insights.pharmacy_participation,
    audit_summary: insights.audit_summary,
    top_searched: compactSection(insights.top_searched),
    demand_supply_gaps: compactSection(insights.demand_supply_gaps),
    pharmacy_availability: compactSection(insights.pharmacy_availability, 10),
    system_insights: compactSection(insights.system_insights, 8),
    anomalies: compactSection(insights.anomalies),
    price_anomalies: compactSection(insights.price_anomalies),
  };
}

function deterministicPharmacyAnswer(message, insights) {
  const query = message.toLowerCase();
  const inventory = insights.inventory_quantities || {};
  const totals = inventory.totals || {};
  const performance = insights.performance_summary || {};
  const risks = insights.stock_risk?.items || [];
  const expiring = insights.expiry_risk?.items || [];
  const riskLines = risks.slice(0, 5).map(item =>
    `${item.medicine_name}: ${item.current_stock} units (threshold ${item.threshold}), ${item.severity.toLowerCase()} risk.`);
  const expiryLines = expiring.slice(0, 5).map(item =>
    `${item.medicine_name}: ${item.current_quantity} units expire ${item.expiration_date} (${item.days_until_expiry} days).`);

  if (/expir|expiry|near date/.test(query)) {
    return expiring.length
      ? `Current expiry alerts: ${expiryLines.join(' ')}`
      : (Number(inventory.inventory_count) === 0
        ? 'No inventory records are available for expiry review.'
        : 'There are no current expiry alerts in the analytics reporting window.');
  }
  if (/low.stock|out.of.stock|restock|replenish|stock risk/.test(query)) {
    return risks.length
      ? `Current stock risks: ${riskLines.join(' ')}`
      : (Number(inventory.inventory_count) === 0
        ? 'No inventory records are available to assess stock risks.'
        : 'No low-stock, out-of-stock, or elevated stock-risk products are currently listed in these analytics.');
  }
  if (/movement|transaction/.test(query)) {
    const movements = insights.stock_movements?.items || [];
    return movements.length
      ? `Recorded stock movements in the last 30 days: ${movements.map(item => `${item.transaction_type}: ${item.movement_count} movements (${item.moved_units} units)`).join('; ')}.`
      : 'No stock movements are recorded for this pharmacy in the last 30 days.';
  }
  if (/demand|search|trend/.test(query)) {
    const items = insights.demand_analysis?.items || [];
    return items.length
      ? `Recorded demand signals: ${items.slice(0, 5).map(item => `${item.medicine_name}: ${item.recent_demand_units} recent reservation units and ${item.recent_stock_out_units} stock-out units`).join('; ')}.`
      : 'No medicine demand trends are available in the current pharmacy analytics.';
  }
  if (/price|pricing/.test(query)) {
    const items = insights.price_analysis?.items || [];
    return items.length
      ? `Current price signals: ${items.slice(0, 5).map(item => `${item.medicine_name}: ${item.reason || item.evidence}`).join(' ')} `
        + 'These are comparison signals, not proof of a pricing error.'
      : 'No price comparison signals are present in the current pharmacy analytics.';
  }

  if (Number(inventory.inventory_count) === 0) {
    return 'There are no inventory records for this pharmacy in the current analytics.';
  }
  return `Current inventory summary: ${inventory.inventory_count} listed products; ${totals.physical_stock || 0} physical units, ${totals.reserved_quantity || 0} reserved units, and ${totals.available_quantity || 0} available units. ${performance.summary || `${performance.low_stock_medicines || 0} low-stock and ${performance.out_of_stock_medicines || 0} out-of-stock products; ${expiring.length} current expiry alerts.`}`;
}

function deterministicAdminAnswer(message, insights) {
  const query = message.toLowerCase();
  const participation = insights.pharmacy_participation || {};
  const pharmacies = participation.pharmacies || [];
  const statusCounts = pharmacies.reduce((counts, pharmacy) => {
    const status = String(pharmacy.verification_status || 'UNKNOWN').toUpperCase();
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
  const summary = insights.summary || {};
  const audit = insights.audit_summary || {};
  const hasCurrentAdminData = pharmacies.length > 0
    || (insights.top_searched || []).length > 0
    || (insights.demand_supply_gaps || []).length > 0
    || (insights.low_stock_items || []).length > 0
    || (insights.anomalies || []).length > 0
    || (insights.price_anomalies || []).length > 0
    || Number(summary.search_events_30_days || 0) > 0
    || Number(audit.event_count || 0) > 0;

  if (!hasCurrentAdminData) {
    return 'There are no pharmacy participation, inventory, audit, or medicine demand records in the current administrative analytics.';
  }

  if (/pending|review|verif/.test(query)) {
    const pending = statusCounts.PENDING || 0;
    const rejected = statusCounts.REJECTED || 0;
    return pharmacies.length
      ? `Current pharmacy verification statuses: ${statusCounts.VERIFIED || 0} verified, ${pending} pending review, ${statusCounts.SUSPENDED || 0} suspended, and ${rejected} rejected, across ${pharmacies.length} pharmacies in the analytics.`
      : 'No pharmacy records are present in the current administrative analytics.';
  }
  if (/suspend/.test(query)) {
    return pharmacies.length
      ? `${statusCounts.SUSPENDED || 0} pharmacies currently have SUSPENDED verification status in the administrative analytics.`
      : 'No pharmacy records are present in the current administrative analytics.';
  }
  if (/availability|shortage|supply|demand|medicine gap/.test(query)) {
    const gaps = insights.demand_supply_gaps || [];
    return gaps.length
      ? `Current demand and supply gaps: ${gaps.slice(0, 5).map(item => `${item.medicine_name}: ${item.evidence || item.reason}`).join(' ')} `
        + `${summary.demand_supply_gaps || gaps.length} gaps are recorded in the current analytics.`
      : `No demand/supply gaps are recorded. Current inventory analytics report ${summary.low_stock_alerts || 0} low-stock alerts.`;
  }
  if (/low.stock|inventory|stale|stock/.test(query)) {
    const stale = pharmacies.filter(pharmacy => pharmacy.stale_inventory).length;
    const lowStock = insights.low_stock_items || [];
    return `Current system inventory signals: ${lowStock.length} low-stock listings in the available detail set, ${summary.low_stock_alerts || 0} low-stock alerts, and ${stale} pharmacies with stale inventory activity in the available participation data.`;
  }
  if (/anomal|activity|audit/.test(query)) {
    const anomalies = insights.anomalies || [];
    return `Current review data: ${anomalies.length} activity anomalies and ${audit.event_count || 0} audit events in ${audit.reporting_period || 'the reporting period'}. `
      + `Pharmacy participation statuses in the same analytics: ${pharmacies.length} total, ${statusCounts.VERIFIED || 0} verified, ${statusCounts.PENDING || 0} pending, ${statusCounts.SUSPENDED || 0} suspended.`;
  }
  if (/price/.test(query)) {
    const prices = insights.price_anomalies || [];
    return prices.length
      ? `There are ${prices.length} price comparison signals in the current analytics. ${prices.slice(0, 3).map(item => item.evidence || item.reason).join(' ')}`
      : 'No price comparison signals are present in the current administrative analytics.';
  }
  return `Current system summary for ${insights.reporting_period || 'the reporting period'}: ${pharmacies.length} pharmacies in participation data, ${statusCounts.VERIFIED || 0} verified, ${statusCounts.PENDING || 0} pending, ${statusCounts.SUSPENDED || 0} suspended; ${summary.low_stock_alerts || 0} low-stock alerts, ${summary.demand_supply_gaps || 0} availability gaps, ${summary.anomalies_requiring_review || 0} anomalies for review.`;
}

function logFallback(role, error) {
  const details = error?.diagnostic || {};
  console.info(`P.A.I. deterministic fallback: ${JSON.stringify({
    role,
    operation: 'analytics_explanation',
    model: details.model || process.env.GEMINI_MODEL || 'gemini-3.8-flash',
    durationMs: Number.isFinite(details.durationMs) ? details.durationMs : null,
    status: Number.isInteger(details.status) ? details.status : null,
    providerCode: details.providerCode || null,
    attempts: Number.isInteger(details.attempts) ? details.attempts : 0,
    failureClass: details.failureClass || null,
    outcome: 'deterministic_fallback',
    fallbackUsed: true,
  })}`);
}

async function explainInsights({ role, message, insights, requestOptions = {} }) {
  const normalizedMessage = typeof message === 'string' ? message.trim() : '';
  if (!normalizedMessage || normalizedMessage.length > MAX_MESSAGE_LENGTH) {
    const error = new Error(`Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.`);
    error.status = 422;
    throw error;
  }
  const facts = role === 'pharmacy_staff'
    ? compactPharmacyInsights(insights)
    : compactAdminInsights(insights);
  const scope = role === 'pharmacy_staff' ? 'this authenticated pharmacy only' : 'PillPoint system-wide';
  try {
    const result = await requestJsonCompletion({
    messages: [
      {
        role: 'system',
        content: `You are P.A.I., PillPoint's ${role === 'pharmacy_staff' ? 'pharmacy' : 'administrator'} analytics explainer. Answer the user's question using only the supplied deterministic PillPoint analytics for ${scope}. These analytics are the source of truth. Do not invent or infer metrics, access other data, write or execute SQL, or claim to perform actions. For pharmacy staff, explain low/out-of-stock risks, restocking priorities, expiry warnings, medicine demand, stock movements, eligible, reserved and available quantities, inventory quality, price signals, and recorded performance only where supplied. For administrators, explain pharmacy verification and participation summaries, stale inventory, demand/supply signals, availability gaps, activity and price anomalies, audit aggregates, and system performance only where supplied. Do not approve, reject, suspend, or reactivate pharmacies. Do not modify stock, prices, or reservations. If facts do not answer the question, say what is unavailable. Return no more than four short sentences and 900 characters, prioritizing the facts relevant to the question. Distinguish recommendations from measured facts.`,
      },
      {
        role: 'user',
        content: `Analytics facts (JSON):\n${JSON.stringify(facts)}\n\nQuestion: ${normalizedMessage}`,
      },
    ],
    schemaName: 'pai_role_analytics_answer',
    schema: ANSWER_SCHEMA,
    // The selected model supports far more than this; 600 is a small increase
    // over the prior 500-token ceiling to avoid clipping concise summaries.
    maxTokens: 600,
    diagnosticRole: role,
    diagnosticOperation: 'analytics_explanation',
    timeoutMs: requestOptions.timeoutMs,
    maxAttempts: requestOptions.maxAttempts,
    });
    if (typeof result?.message === 'string' && result.message.trim()) {
      return {
        type: 'answer',
        source: 'ai',
        message: result.message.trim().slice(0, MAX_ANSWER_LENGTH),
      };
    }
    throw new PaiUnavailableError('Gemini returned an invalid analytics explanation.');
  } catch (error) {
    if (!(error instanceof PaiUnavailableError)) throw error;
    logFallback(role, error);
    return {
      type: 'answer',
      source: 'deterministic',
      message: (role === 'pharmacy_staff'
        ? deterministicPharmacyAnswer(normalizedMessage, insights)
        : deterministicAdminAnswer(normalizedMessage, insights)).slice(0, MAX_ANSWER_LENGTH),
      notice: FALLBACK_NOTICE,
    };
  }
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  explainInsights,
  compactPharmacyInsights,
  compactAdminInsights,
  deterministicPharmacyAnswer,
  deterministicAdminAnswer,
};
