import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { usageFixture } from '../src/fixture.js';
import { toShare } from '../src/share.js';
import { UsageView } from '../src/react.js';
import type { RangeId } from '../src/schema.js';
import '../src/usage.css';

// ?variant=share renders the public subset; ?theme=dark the dark palette.
function Preview(): React.ReactElement {
  const params = new URLSearchParams(window.location.search);
  const [variant, setVariant] = useState(params.get('variant') === 'share' ? 'share' : 'stats');
  const [dark, setDark] = useState(params.get('theme') === 'dark');
  const [range, setRange] = useState<RangeId>('month');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  const stats = usageFixture();
  stats.range.id = range;
  const data = variant === 'share' ? toShare(stats, 'madarco') : stats;
  return (
    <>
      {params.get('chrome') !== '0' && (
        <div className="preview-bar">
          <button onClick={() => setVariant(variant === 'share' ? 'stats' : 'share')}>
            variant: {variant}
          </button>
          <button onClick={() => setDark(!dark)}>theme: {dark ? 'dark' : 'light'}</button>
        </div>
      )}
      <UsageView data={data} onRangeChange={variant === 'stats' ? setRange : undefined} />
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
