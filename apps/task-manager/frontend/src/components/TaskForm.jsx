import { useState, useEffect } from 'react';

const EMPTY = { title: '', description: '', priority: 'medium', dueDate: '' };

export default function TaskForm({ onSubmit, editing, onCancel }) {
  const [form, setForm] = useState(EMPTY);

  useEffect(() => {
    if (editing) {
      setForm({
        title: editing.title,
        description: editing.description || '',
        priority: editing.priority,
        dueDate: editing.dueDate ? editing.dueDate.slice(0, 10) : '',
      });
    } else {
      setForm(EMPTY);
    }
  }, [editing]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    onSubmit({ ...form, dueDate: form.dueDate || null });
    setForm(EMPTY);
  };

  return (
    <form onSubmit={handleSubmit} style={styles.form}>
      <h2 style={styles.heading}>{editing ? 'タスクを編集' : '新しいタスク'}</h2>
      <input
        style={styles.input}
        placeholder="タイトル *"
        value={form.title}
        onChange={set('title')}
        required
      />
      <textarea
        style={{ ...styles.input, height: 72, resize: 'vertical' }}
        placeholder="説明（任意）"
        value={form.description}
        onChange={set('description')}
      />
      <div style={styles.row}>
        <select style={styles.select} value={form.priority} onChange={set('priority')}>
          <option value="high">高</option>
          <option value="medium">中</option>
          <option value="low">低</option>
        </select>
        <input type="date" style={styles.select} value={form.dueDate} onChange={set('dueDate')} />
      </div>
      <div style={styles.row}>
        <button type="submit" style={styles.btnPrimary}>{editing ? '更新' : '追加'}</button>
        {editing && <button type="button" style={styles.btnSecondary} onClick={onCancel}>キャンセル</button>}
      </div>
    </form>
  );
}

const styles = {
  form: { background: '#fff', borderRadius: 10, padding: 20, boxShadow: '0 2px 8px #0001', marginBottom: 24 },
  heading: { margin: '0 0 14px', fontSize: 16, color: '#333' },
  input: { width: '100%', padding: '8px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14, boxSizing: 'border-box', marginBottom: 8, outline: 'none' },
  row: { display: 'flex', gap: 8, marginBottom: 8 },
  select: { flex: 1, padding: '8px 10px', border: '1px solid #ddd', borderRadius: 6, fontSize: 14 },
  btnPrimary: { flex: 1, padding: '8px 0', background: '#4f7ef8', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 },
  btnSecondary: { flex: 1, padding: '8px 0', background: '#eee', color: '#555', border: 'none', borderRadius: 6, cursor: 'pointer' },
};
