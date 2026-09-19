import { redirect } from 'next/navigation';

/** Preserve existing bookmarks while keeping one canonical workspace. */
export default function PreviousWorkbench() {
  redirect('/?view=analysis');
}
