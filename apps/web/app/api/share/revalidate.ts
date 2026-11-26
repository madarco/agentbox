import { revalidatePath } from 'next/cache';

/**
 * Share pages are cached forever. A new share is new content at a path nothing should
 * have cached yet; a deleted one must stop being served, page and images alike.
 */
export function revalidateShare(id: string): void {
  revalidatePath(`/s/${id}`);
  revalidatePath(`/s/${id}/opengraph-image`);
  revalidatePath(`/s/${id}/twitter-image`);
}
