const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware');
const { handleAssistantMessage } = require('../services/pai/assistant');
const { SAFE_FAILURE_MESSAGE, PaiUnavailableError, searchForCustomer, createAvailabilityWatch } = require('../services/pai/customer');
const { getInventoryInsights } = require('../services/pai/inventory');
const { getAdminInsights, generateAdminReport } = require('../services/pai/insights');
const { MAX_MESSAGE_LENGTH, explainInsights } = require('../services/pai/role-assistant');
const { getCooldownState } = require('../services/pai/gemini');

const router = express.Router();

router.get('/status', requireAuth, (req, res) => {
  const status = getCooldownState(req.session.user.role);
  res.json({ active: status.active, retryAfterMs: status.retryAfterMs, reason: status.reason });
});

function handlePaiFailure(error, res) {
  if (error instanceof PaiUnavailableError) {
    console.error('P.A.I. Customer request used its controlled unavailable path.');
    return res.status(503).json({ error: SAFE_FAILURE_MESSAGE });
  }
  console.error('P.A.I. Customer request failed unexpectedly.');
  return res.status(500).json({ error: 'P.A.I. could not complete this request. Please use PillPoint standard search.' });
}

function handleRoleAssistantFailure(error, res) {
  if (error.status === 422) return res.status(422).json({ error: error.message });
  if (error instanceof PaiUnavailableError) {
    console.error('P.A.I. role assistant provider request failed:', error.message);
    return res.status(503).json({ error: 'P.A.I. is temporarily unavailable. Please try again shortly.' });
  }
  console.error('P.A.I. role assistant request failed unexpectedly.');
  return res.status(500).json({ error: 'P.A.I. could not explain the current PillPoint analytics.' });
}

function handleDataFailure(error, res, message) {
  console.error('P.A.I. data request failed unexpectedly:', error && error.message);
  if (res.headersSent) return;
  return res.status(500).json({ error: message });
}

function validateRoleAssistantMessage(req, res) {
  const message = req.body?.message;
  if (typeof message !== 'string' || !message.trim() || message.trim().length > MAX_MESSAGE_LENGTH) {
    res.status(422).json({ error: `Message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.` });
    return null;
  }
  return message.trim();
}

router.post('/assistant', requireAuth, requireRole('customer'), async (req, res) => {
  try {
    const { message, context_inventory_ids: contextInventoryIds } = req.body || {};
    const result = await handleAssistantMessage(message, {
      userId: req.session.user.id,
      contextInventoryIds,
    });
    res.json({ result });
  } catch (error) {
    handlePaiFailure(error, res);
  }
});

router.get('/search', requireAuth, requireRole('customer'), async (req, res) => {
  try {
    const data = await searchForCustomer((req.query.q || '').toString(), req.session.user.id);
    if (data.type === 'invalid') return res.status(422).json({ error: data.message });
    if (data.type === 'not_search') return res.status(422).json({ error: data.message });
    res.json(data);
  } catch (error) {
    handlePaiFailure(error, res);
  }
});

router.post('/availability-watch', requireAuth, requireRole('customer'), (req, res) => {
  try {
    const medicineId = Number(req.body?.medicine_id);
    const pharmacyId = req.body?.pharmacy_id == null || req.body.pharmacy_id === ''
      ? null
      : Number(req.body.pharmacy_id);
    if (!Number.isInteger(medicineId) || medicineId <= 0
      || (pharmacyId !== null && (!Number.isInteger(pharmacyId) || pharmacyId <= 0))) {
      return res.status(422).json({ error: 'Choose a valid medicine and optional pharmacy from PillPoint results.' });
    }

    const result = createAvailabilityWatch(req.session.user.id, medicineId, pharmacyId);
    if (result.error) return res.status(result.status).json({ error: result.error });
    if (result.already_available) {
      return res.json({
        already_available: true,
        message: `${result.medicine.name} already has a verified available listing. Review current search results.`,
        listings: result.listings,
      });
    }
    res.status(result.already_watching ? 200 : 201).json({
      watch_id: result.watch_id,
      already_watching: !!result.already_watching,
      message: result.already_watching
        ? `You are already watching ${result.medicine.name}.`
        : `Availability alert set for ${result.medicine.name}. PillPoint will notify you when it becomes available.`,
    });
  } catch (error) {
    return handleDataFailure(error, res, 'P.A.I. could not save that availability alert. Please try again.');
  }
});

router.get('/availability-watch', requireAuth, requireRole('customer'), (req, res) => {
  try {
    const watches = db.prepare(`
      SELECT w.id, w.medicine_id, m.name AS medicine_name, w.pharmacy_id,
        p.name AS pharmacy_name, w.active, w.created_at, w.notified_at
      FROM medicine_availability_watch w
      JOIN medicines m ON m.id = w.medicine_id
      LEFT JOIN pharmacies p ON p.id = w.pharmacy_id
      WHERE w.customer_id = ?
      ORDER BY w.created_at DESC
    `).all(req.session.user.id);
    res.json({ watches });
  } catch (error) {
    return handleDataFailure(error, res, 'P.A.I. could not load your availability alerts. Please refresh and try again.');
  }
});

router.delete('/availability-watch/:id', requireAuth, requireRole('customer'), (req, res) => {
  try {
    const watchId = Number(req.params.id);
    if (!Number.isInteger(watchId) || watchId <= 0) {
      return res.status(404).json({ error: 'Active availability alert not found.' });
    }
    const result = db.prepare(`
      UPDATE medicine_availability_watch
      SET active = 0
      WHERE id = ? AND customer_id = ? AND active = 1
    `).run(watchId, req.session.user.id);
    if (!result.changes) return res.status(404).json({ error: 'Active availability alert not found.' });
    res.json({ ok: true });
  } catch (error) {
    return handleDataFailure(error, res, 'P.A.I. could not cancel that availability alert. Please refresh and try again.');
  }
});

router.get('/inventory-insights', requireAuth, requireRole('pharmacy_staff'), (req, res) => {
  try {
    const pharmacyId = req.session.user.pharmacy_id;
    if (!pharmacyId) return res.status(403).json({ error: 'No pharmacy bound to this user.' });
    res.json(getInventoryInsights(pharmacyId));
  } catch (error) {
    return handleDataFailure(error, res, 'P.A.I. could not generate inventory insights from current PillPoint data.');
  }
});

router.post('/pharmacy-assistant', requireAuth, requireRole('pharmacy_staff'), async (req, res) => {
  const pharmacyId = Number(req.session.user.pharmacy_id);
  if (!Number.isInteger(pharmacyId) || pharmacyId <= 0) {
    return res.status(403).json({ error: 'No pharmacy bound to this user.' });
  }
  const message = validateRoleAssistantMessage(req, res);
  if (!message) return;
  try {
    const insights = getInventoryInsights(pharmacyId);
    const result = await explainInsights({ role: 'pharmacy_staff', message, insights });
    return res.json({ result });
  } catch (error) {
    return handleRoleAssistantFailure(error, res);
  }
});

router.post('/admin-assistant', requireAuth, requireRole('admin'), async (req, res) => {
  const message = validateRoleAssistantMessage(req, res);
  if (!message) return;
  try {
    const insights = getAdminInsights();
    const result = await explainInsights({ role: 'admin', message, insights });
    return res.json({ result });
  } catch (error) {
    return handleRoleAssistantFailure(error, res);
  }
});

router.get('/admin-insights', requireAuth, requireRole('admin'), (req, res) => {
  try {
    res.json(getAdminInsights());
  } catch (error) {
    console.error('P.A.I. admin insights failed unexpectedly.');
    res.status(500).json({ error: 'P.A.I. could not generate admin insights from current PillPoint data.' });
  }
});

router.post('/admin-report', requireAuth, requireRole('admin'), (req, res) => {
  try {
    res.json(generateAdminReport());
  } catch (error) {
    console.error('P.A.I. admin report generation failed unexpectedly.');
    res.status(500).json({ error: 'P.A.I. could not generate the report from current PillPoint data.' });
  }
});

module.exports = router;
