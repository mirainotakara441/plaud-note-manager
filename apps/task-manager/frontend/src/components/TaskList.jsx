import TaskItem from './TaskItem.jsx';

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

export default function TaskList({ tasks, filter, onToggle, onEdit, onDelete }) {
  const filtered = tasks
    .filter((t) => filter === 'all' || (filter === 'active' ? !t.completed : t.completed))
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

  if (filtered.length === 0) {
    return <p style={{ color: '#aaa', textAlign: 'center', padding: 32 }}>タスクがありません</p>;
  }

  return (
    <div>
      {filtered.map((task) => (
        <TaskItem key={task.id} task={task} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} />
      ))}
    </div>
  );
}
