'use strict';
require('dotenv').config();
const express = require('express');
const path    = require('path');
const { CLIENTS } = require('./config');
const { getYearView, getMonthData, getPipelineData, forceRefreshYearView, forceRefreshPipelineData, refreshAllCaches } = require('./builders');
const { getProjections, saveProjection } = require('./projections');
const { deleteCache } = require('./cache');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Clients ───────────────────────────────────────────────────
app.get('/api/clients', (req, res) => {
  res.json(CLIENTS);
});

// ── Year view ─────────────────────────────────────────────────
app.get('/api/year', async (req, res) => {
  try {
    const { client = 0, budget, yearStart = 'Jan 26' } = req.query;
    res.json(await getYearView(client, budget || null, yearStart));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Month drilldown ───────────────────────────────────────────
app.get('/api/month', async (req, res) => {
  try {
    const { client = 0, budget, month } = req.query;
    res.json(await getMonthData(client, budget || null, month));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Pipeline ──────────────────────────────────────────────────
app.get('/api/pipeline', async (req, res) => {
  try {
    const { client = 0 } = req.query;
    res.json(await getPipelineData(client));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Projections ───────────────────────────────────────────────
app.get('/api/projections', async (req, res) => {
  try {
    const { client = 0 } = req.query;
    const projections = await getProjections(client);
    res.json({ ok: true, projections });
  } catch (e) { res.json({ ok: false, error: e.message, projections: {} }); }
});

app.post('/api/projections', async (req, res) => {
  try {
    const { clientIndex, taskId, taskName, projectedHours, targetMonth } = req.body;
    const idx = parseInt(clientIndex, 10);
    await saveProjection(idx, taskId, taskName, projectedHours, targetMonth);
    // Bust affected month cache — same logic as GAS saveProjection
    const client  = CLIENTS[idx];
    const budgets = client.hasRetainerBudget ? ['Retail', 'Trade'] : [null];
    await Promise.all(budgets.map(b =>
      targetMonth ? deleteCache(`month_${idx}_${b || 'all'}_${targetMonth}`) : Promise.resolve()
    ));
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Overview (all clients) ────────────────────────────────────
app.get('/api/overview', async (req, res) => {
  try {
    const { yearStart = 'Jan 26' } = req.query;
    const results = await Promise.all(CLIENTS.map(async (client, idx) => {
      try {
        const budgets = client.hasRetainerBudget ? ['Retail', 'Trade'] : [null];
        const yearResults = await Promise.all(
          budgets.map(b => getYearView(idx, b, yearStart))
        );
        const pipeline = await getPipelineData(idx);
        return { idx, name: client.name, budgets: budgets.map((b, i) => ({ budget: b, year: yearResults[i] })), pipeline };
      } catch (e) { return { idx, name: client.name, error: e.message }; }
    }));
    res.json({ ok: true, clients: results });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Force refresh ─────────────────────────────────────────────
app.post('/api/refresh/year', async (req, res) => {
  try {
    const { client = 0, budget, yearStart = 'Jan 26' } = req.body;
    res.json(await forceRefreshYearView(client, budget || null, yearStart));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/refresh/pipeline', async (req, res) => {
  try {
    const { client = 0 } = req.body;
    res.json(await forceRefreshPipelineData(client));
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Cron refresh (respond immediately, run in background) ─────
app.post('/api/cron/refresh', (req, res) => {
  res.json({ ok: true, message: 'Cache refresh started' });
  refreshAllCaches().catch(e => console.error('Refresh error:', e));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Retainer API running on http://localhost:${PORT}`);
  console.log(`CLICKUP_TEAM_ID: ${process.env.CLICKUP_TEAM_ID || '(not set)'}`);
  console.log(`CLICKUP_API_TOKEN: ${process.env.CLICKUP_API_TOKEN ? '(set)' : '(not set)'}`);
});
