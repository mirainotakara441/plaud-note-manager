import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { v4 as uuidv4 } from 'uuid';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, 'data', 'tasks.json');

const readTasks = () => JSON.parse(readFileSync(DATA_FILE, 'utf-8'));
const writeTasks = (tasks) => writeFileSync(DATA_FILE, JSON.stringify(tasks, null, 2));

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/tasks', (_req, res) => {
  res.json(readTasks());
});

app.post('/api/tasks', (req, res) => {
  const { title, description = '', priority = 'medium', dueDate = null } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const tasks = readTasks();
  const task = {
    id: uuidv4(),
    title,
    description,
    priority,
    dueDate,
    completed: false,
    createdAt: new Date().toISOString(),
  };
  tasks.push(task);
  writeTasks(tasks);
  res.status(201).json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const tasks = readTasks();
  const index = tasks.findIndex((t) => t.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'not found' });

  tasks[index] = { ...tasks[index], ...req.body, id: tasks[index].id };
  writeTasks(tasks);
  res.json(tasks[index]);
});

app.delete('/api/tasks/:id', (req, res) => {
  const tasks = readTasks();
  const next = tasks.filter((t) => t.id !== req.params.id);
  if (next.length === tasks.length) return res.status(404).json({ error: 'not found' });
  writeTasks(next);
  res.status(204).end();
});

app.listen(3001, () => console.log('Backend running on http://localhost:3001'));
