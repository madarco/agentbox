export async function prepareClaudeLoginHelper(
  prepare: () => Promise<unknown>,
  isCloud: boolean,
  onCloudFallback: (error: string) => void,
): Promise<boolean> {
  try {
    await prepare();
    return true;
  } catch (err) {
    if (!isCloud) throw err;
    onCloudFallback(err instanceof Error ? err.message : String(err));
    return false;
  }
}
