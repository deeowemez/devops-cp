/**
 * app/backend/express.js
 */

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

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

// Health check endpoint
app.get('/api/health', (req, res) => {
  console.log('[HEALTH] Health check requested');
  res.json({ status: 'healthy' });
});

// Get all tasks
app.get('/api/tasks', async (req, res) => {
  console.log('[TASKS][GET] Fetching all tasks');

  try {
    const result = await pool.query(
      'SELECT * FROM tasks ORDER BY created_at DESC'
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
    const result = await pool.query(
      'INSERT INTO tasks (title, description) VALUES ($1, $2) RETURNING *',
      [title, description]
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
    const result = await pool.query(
      'UPDATE tasks SET title = COALESCE($1, title), description = COALESCE($2, description), status = COALESCE($3, status), updated_at = CURRENT_TIMESTAMP WHERE id = $4 RETURNING *',
      [title, description, status, id]
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
    const result = await pool.query(
      'DELETE FROM tasks WHERE id = $1 RETURNING *',
      [id]
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