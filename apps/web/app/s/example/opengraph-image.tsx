import { OG_ALT, OG_SIZE, renderShareOg } from '@/lib/share/og';
import { exampleShare } from './share';

export const dynamic = 'force-static';
export const alt = OG_ALT;
export const size = OG_SIZE;
export const contentType = 'image/png';

export default function Image() {
  return renderShareOg(exampleShare());
}
