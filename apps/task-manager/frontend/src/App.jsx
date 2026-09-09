import { useState, useEffect } from 'react';
import TaskForm from './components/TaskForm.jsx';
import TaskList from './components/TaskList.jsx';
import { fetchTasks, createTask, updateTask, deleteTask } from './api.js';

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchTasks()
      .then(setTasks)
      .catch(() => setError('バックエンドに接続できません。サーバーを起動してください。'));
  }, []);

  const handleCreate = async (data) => {
    const task = await createTask(data);
    setTasks((prev) => [...prev, task]);
  };

  const handleUpdate = async (data) => {
    const updated = await updateTask(editing.id, data);
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    setEditing(null);
  };

  const handleToggle = async (task) => {
    const updated = await updateTask(task.id, { completed: !task.completed });
    setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  };

  const handleDelete = async (id) => {
    await deleteTask(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  };

  const counts = {
    all: tasks.length,
    active: tasks.filter((t) => !t.completed).length,
    done: tasks.filter((t) => t.completed).length,
  };

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <h1 style={styles.title}>タスク管理</h1>
        {error && <div style={styles.error}>{error}</div>}
        <TaskForm onSubmit={editing ? handleUpdate : handleCreate} editing={editing} onCancel={() => setEditing(null)} />
        <div style={styles.tabs}>
          {[['all', `すべて (${counts.all})`], ['active', `未完了 (${counts.active})`], ['done', `完了 (${counts.done})`]].map(([key, label]) => (
            <button key={key} style={{ ...styles.tab, ...(filter === key ? styles.tabActive : {}) }} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        <TaskList tasks={tasks} filter={filter} onToggle={handleToggle} onEdit={setEditing} onDelete={handleDelete} />
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f0f2f5', padding: '32px 16px', fontFamily: 'system-ui, sans-serif' },
  container: { maxWidth: 600, margin: '0 auto' },
  title: { fontSize: 24, fontWeight: 700, color: '#222', marginBottom: 24 },
  error: { background: '#fff1f0', border: '1px solid #ffa39e', color: '#cf1322', borderRadius: 6, padding: '10px 14px', marginBottom: 16, fontSize: 14 },
  tabs: { display: 'flex', gap: 6, marginBottom: 16 },
  tab: { padding: '6px 14px', border: '1px solid #ddd', borderRadius: 20, background: '#fff', cursor: 'pointer', fontSize: 13, color: '#666' },
  tabActive: { background: '#4f7ef8', color: '#fff', borderColor: '#4f7ef8' },
};
