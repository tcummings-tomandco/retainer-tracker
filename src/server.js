'use strict';
require('dotenv').config();
const express  = require('express');
const path     = require('path');
const { CLIENTS } = require('./config');
const {
  getYearView, getMonthData, getPipelineData,
  forceRefreshYearView, forceRefreshPipelineData, refreshAllCaches,
} = require('./builders');
const { getProjections, saveProjection } = require('./projections');
const { getCache, setCache, deleteCache }            = require('./cache');
const { requireAuth, requireAdmin, assertClientAccess } = require('./auth');
const { listUsers, createUser, updateUser, deleteUser, getInviteLink } = require('./users');
const { db } = require('./firestore');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Public endpoints (no auth) ────────────────────────────────

// Firebase client SDK config — safe to expose (security is server-side + Auth rules)
app.get('/api/config', (req, res) => {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'retainer-tracker-3eb71';
  res.json({
    apiKey:     process.env.FIREBASE_WEB_API_KEY || '',
    authDomain: `${projectId}.firebaseapp.com`,
    projectId,
  });
});

// Cron endpoint — protected by a shared secret header (not Firebase Auth,
// since the scheduler doesn't have a user token).
app.post('/api/cron/refresh', (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers['x-cron-secret'] !== secret) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  res.json({ ok: true, message: 'Cache refresh started' });
  refreshAllCaches().catch(e => console.error('Refresh error:', e));
});

// ── Auth middleware — all /api/* routes below require a valid token ──
app.use('/api', requireAuth);

// ── Current user ──────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  const { uid, email, role, clientIndex } = req.user;
  res.json({ ok: true, user: { uid, email, role, clientIndex } });
});

// ── Clients ───────────────────────────────────────────────────
// Returns all clients with their index — same list for everyone.
// Access control is enforced on the data endpoints, not here.
app.get('/api/clients', (req, res) => {
  res.json(CLIENTS.map((c, i) => ({ ...c, index: i })));
});

// ── Year view ─────────────────────────────────────────────────
app.get('/api/year', async (req, res) => {
  try {
    const { client = 0, budget, yearStart = 'Jan 26' } = req.query;
    if (!assertClientAccess(req, res, client)) return;
    res.json(await getYearView(client, budget || null, yearStart));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Month drilldown ───────────────────────────────────────────
app.get('/api/month', async (req, res) => {
  try {
    const { client = 0, budget, month } = req.query;
    if (!assertClientAccess(req, res, client)) return;
    res.json(await getMonthData(client, budget || null, month));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Pipeline ──────────────────────────────────────────────────
app.get('/api/pipeline', async (req, res) => {
  try {
    const { client = 0 } = req.query;
    if (!assertClientAccess(req, res, client)) return;
    res.json(await getPipelineData(client));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Projections ───────────────────────────────────────────────
app.get('/api/projections', async (req, res) => {
  try {
    const { client = 0 } = req.query;
    if (!assertClientAccess(req, res, client)) return;
    const projections = await getProjections(client);
    res.json({ ok: true, projections });
  } catch (e) { res.json({ ok: false, error: e.message, projections: {} }); }
});

// Save projections — admin only (client users are read-only)
app.post('/api/projections', requireAdmin, async (req, res) => {
  try {
    const { clientIndex, taskId, taskName, projectedHours, targetMonth } = req.body;
    const idx     = parseInt(clientIndex, 10);
    await saveProjection(idx, taskId, taskName, projectedHours, targetMonth);
    const client  = CLIENTS[idx];
    const budgets = client.hasRetainerBudget ? ['Retail', 'Trade'] : [null];
    await Promise.all([
      ...budgets.map(b =>
        targetMonth ? deleteCache(`month_${idx}_${b || 'all'}_${targetMonth}`) : Promise.resolve()
      ),
      deleteCache('overview_Jan 26'),
    ]);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Overview (admin only) ─────────────────────────────────────
app.get('/api/overview', requireAdmin, async (req, res) => {
  try {
    const { yearStart = 'Jan 26' } = req.query;
    const cacheKey = `overview_${yearStart}`;

    const cached = await getCache(cacheKey);
    if (cached) { cached.fromCache = true; return res.json(cached); }

    const results = await Promise.all(CLIENTS.map(async (client, idx) => {
      try {
        const budgets    = client.hasRetainerBudget ? ['Retail', 'Trade'] : [null];
        const yearResults = await Promise.all(budgets.map(b => getYearView(idx, b, yearStart)));
        const pipeline   = await getPipelineData(idx);
        return { idx, name: client.name, budgets: budgets.map((b, i) => ({ budget: b, year: yearResults[i] })), pipeline };
      } catch (e) { return { idx, name: client.name, error: e.message }; }
    }));

    const response = { ok: true, clients: results, cachedAt: new Date().toISOString() };
    await setCache(cacheKey, response);
    res.json(response);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Force refresh (admin only) ────────────────────────────────
app.post('/api/refresh/year', requireAdmin, async (req, res) => {
  try {
    const { client = 0, budget, yearStart = 'Jan 26' } = req.body;
    res.json(await forceRefreshYearView(client, budget || null, yearStart));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/refresh/pipeline', requireAdmin, async (req, res) => {
  try {
    const { client = 0 } = req.body;
    res.json(await forceRefreshPipelineData(client));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Admin: User management ────────────────────────────────────
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    res.json({ ok: true, users: await listUsers() });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const { email, role, clientIndex } = req.body;
    if (!email || !role) return res.json({ ok: false, error: 'email and role are required.' });
    if (role === 'client' && clientIndex == null) {
      return res.json({ ok: false, error: 'A client must be assigned for client-role users.' });
    }
    const user = await createUser(email, role, clientIndex);
    res.json({ ok: true, user });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.put('/api/admin/users/:uid', requireAdmin, async (req, res) => {
  try {
    const { role, clientIndex } = req.body;
    if (!role) return res.json({ ok: false, error: 'role is required.' });
    await updateUser(req.params.uid, { role, clientIndex });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.delete('/api/admin/users/:uid', requireAdmin, async (req, res) => {
  try {
    if (req.params.uid === req.user.uid) {
      return res.json({ ok: false, error: "You can't delete your own account." });
    }
    await deleteUser(req.params.uid);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// Generate a password-reset / first-login invite link for a user.
app.post('/api/admin/users/:uid/invite', requireAdmin, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.params.uid).get();
    if (!snap.exists) return res.json({ ok: false, error: 'User not found.' });
    const link = await getInviteLink(snap.data().email);
    res.json({ ok: true, link });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Retainer API running on http://localhost:${PORT}`);
  console.log(`CLICKUP_TEAM_ID:   ${process.env.CLICKUP_TEAM_ID    || '(not set)'}`);
  console.log(`CLICKUP_API_TOKEN: ${process.env.CLICKUP_API_TOKEN  ? '(set)'     : '(not set)'}`);
  console.log(`CRON_SECRET:       ${process.env.CRON_SECRET        ? '(set)'     : '(not set — cron unprotected)'}`);
});
