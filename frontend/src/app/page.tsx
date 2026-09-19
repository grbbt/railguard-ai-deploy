import Workspace, { type WorkspaceView } from '@/components/workspace/Workspace';
import { redirect } from 'next/navigation';

export default async function Home({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  if (view === 'twin') redirect('/?view=investigation');
  const allowed = ['overview', 'analysis', 'investigation', 'validation', 'exports'];
  return <Workspace initialView={allowed.includes(view ?? '') ? view as WorkspaceView : 'overview'}/>;
}
