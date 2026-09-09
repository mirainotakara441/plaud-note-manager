const PRIORITY_LABEL = { high: '高', medium: '中', low: '低' };
const PRIORITY_COLOR = { high: '#ff4d4f', medium: '#faad14', low: '#52c41a' };

export default function TaskItem({ task, onToggle, onEdit, onDelete }) {
  const isOverdue = task.dueDate && !task.completed && new Date(task.dueDate) < new Date();

  return (
    <div style={{ ...styles.card, opacity: task.completed ? 0.6 : 1, borderLeft: `4px solid ${PRIORITY_COLOR[task.priority]}` }}>
      <div style={styles.top}>
        <input type="checkbox" checked={task.completed} onChange={() => onToggle(task)} style={styles.checkbox} />
        <div style={styles.body}>
          <span style={{ ...styles.title, textDecoration: task.completed ? 'line-through' : 'none' }}>{task.title}</span>
          {task.description && <p style={styles.desc}>{task.description}</p>}
          <div style={styles.meta}>
            <span style={{ ...styles.badge, background: PRIORITY_COLOR[task.priority] }}>
              {PRIORITY_LABEL[task.priority]}
            </span>
            {task.dueDate && (
              <span style={{ ...styles.due, color: isOverdue ? '#ff4d4f' : '#888' }}>
                {isOverdue ? '⚠ ' : ''}期限: {task.dueDate.slice(0, 10)}
              </span>
            )}
          </div>
        </div>
        <div style={styles.actions}>
          <button style={styles.btnEdit} onClick={() => onEdit(task)}>編集</button>
          <button style={styles.btnDelete} onClick={() => onDelete(task.id)}>削除</button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  card: { background: '#fff', borderRadius: 8, padding: '12px 14px', marginBottom: 10, boxShadow: '0 1px 4px #0001' },
  top: { display: 'flex', alignItems: 'flex-start', gap: 10 },
  checkbox: { marginTop: 3, cursor: 'pointer', width: 16, height: 16 },
  body: { flex: 1 },
  title: { fontWeight: 600, fontSize: 15 },
  desc: { margin: '4px 0 0', fontSize: 13, color: '#666' },
  meta: { display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' },
  badge: { fontSize: 11, color: '#fff', padding: '2px 7px', borderRadius: 10, fontWeight: 600 },
  due: { fontSize: 12 },
  actions: { display: 'flex', gap: 6, flexShrink: 0 },
  btnEdit: { fontSize: 12, padding: '3px 10px', border: '1px solid #4f7ef8', borderRadius: 5, color: '#4f7ef8', background: '#fff', cursor: 'pointer' },
  btnDelete: { fontSize: 12, padding: '3px 10px', border: '1px solid #ff4d4f', borderRadius: 5, color: '#ff4d4f', background: '#fff', cursor: 'pointer' },
};
