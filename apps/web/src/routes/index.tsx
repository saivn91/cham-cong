import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: IndexComponent,
});

function IndexComponent() {
  return (
    <div className="p-4">
      <h1>Hệ thống Chấm Công</h1>
    </div>
  );
}
