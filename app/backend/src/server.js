/**
 * app/backend/express.js
 */
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const client = require('prom-client');
require('dotenv').config();

const app = express();

// ── Metrics setup ──────────────────────────────────────────────────────────────
// Collect default Node.js metrics (event loop lag, memory, CPU, etc.)
client.collectDefaultMetrics();

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

const httpRequestTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
});
// ──────────────────────────────────────────────────────────────────────────────

// Middleware
app.use(cors());
app.use(express.json());

// ── Metrics middleware (must be before routes) ─────────────────────────────────
app.use((req, res, next) => {
  // Skip recording metrics for the metrics endpoint itself
  if (req.path === '/api/metrics') return next();

  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.route.path : req.path;
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode,
    };
    end(labels);
    httpRequestTotal.inc(labels);
  });
  next();
});
// ──────────────────────────────────────────────────────────────────────────────

// Request logger middleware
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.originalUrl}`);
  next();
});

// Database configuration
const pool = new Pool({
  user: process.env.POSTGRES_USER || 'postgres',
  host: process.env.POSTGRES_HOST || 'db',
  database: process.env.POSTGRES_DB || 'taskdb',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  port: process.env.POSTGRES_PORT || 5432,
});

// Helper: timed DB query
async function timedQuery(operation, queryFn) {
  const end = dbQueryDuration.startTimer({ operation });
  try {
    const result = await queryFn();
    end();
    return result;
  } catch (err) {
    end();
    throw err;
  }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  console.log('[HEALTH] Health check requested');
  res.json({ status: 'healthy' });
});

// Metrics endpoint
app.get('/api/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// Get all tasks
app.get('/api/tasks', async (req, res) => {
  console.log('[TASKS][GET] Fetching all tasks');
  try {
    const result = await timedQuery('select', () =>
      pool.query('SELECT * FROM tasks ORDER BY created_at DESC')
    );
    console.log(`[TASKS][GET] Returned ${result.rows.length} tasks`);
    res.json(result.rows);
  } catch (err) {
    console.error('[TASKS][GET][ERROR] Failed to fetch tasks:', err);
    res.status(500).json({ error: 'Failed to fetch tasks' });
  }
});

// Create a task
app.post('/api/tasks', async (req, res) => {
  const { title, description } = req.body;
  console.log('[TASKS][POST] Creating new task', { title });
  if (!title) {
    console.warn('[TASKS][POST] Task creation failed: Title missing');
    return res.status(400).json({ error: 'Title is required' });
  }
  try {
    const result = await timedQuery('insert', () =>
      pool.query(
        'INSERT INTO tasks (title, description) VALUES ($1, $2) RETURNING *',
        [title, description]
      )
    );
    console.log(`[TASKS][POST] Task created with id ${result.rows[0].id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[TASKS][POST][ERROR] Failed to create task:', err);
    res.status(500).json({ error: 'Failed to create task' });
  }
});

// Update a task
app.put('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  const { title, description, status } = req.body;
  console.log(`[TASKS][PUT] Updating task id=${id}`);
  try {
    const result = await timedQuery('update', () =>
      pool.query(
        'UPDATE tasks SET title = COALESCE($1, title), description = COALESCE($2, description), status = COALESCE($3, status), updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
        [title, description, status, id]
      )
    );
    if (result.rows.length === 0) {
      console.warn(`[TASKS][PUT] Task id=${id} not found`);
      return res.status(404).json({ error: 'Task not found' });
    }
    console.log(`[TASKS][PUT] Task id=${id} updated successfully`);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(`[TASKS][PUT][ERROR] Failed to update task id=${id}:`, err);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Delete a task
app.delete('/api/tasks/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`[TASKS][DELETE] Deleting task id=${id}`);
  try {
    const result = await timedQuery('delete', () =>
      pool.query('DELETE FROM tasks WHERE id = $1 RETURNING *', [id])
    );
    if (result.rows.length === 0) {
      console.warn(`[TASKS][DELETE] Task id=${id} not found`);
      return res.status(404).json({ error: 'Task not found' });
    }
    console.log(`[TASKS][DELETE] Task id=${id} deleted`);
    res.json({ message: 'Task deleted successfully' });
  } catch (err) {
    console.error(`[TASKS][DELETE][ERROR] Failed to delete task id=${id}:`, err);
    res.status(500).json({ error: 'Failed to delete task' });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('[APP][ERROR] Unhandled error:', err.stack);
  res.status(500).json({ error: 'Something broke!' });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Task API running on port ${PORT}`);
});

module.exports = app;