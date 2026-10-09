import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import Landing from './components/Landing';
import ReporterPage from './components/ReporterPage';
import './index.css';

type View = 'landing' | 'responder' | 'reporter';

/**
 * Three views behind the hash, so the whole thing stays a static file with no
 * router and no server rewrites. A link to #/report opens the public form
 * directly, which is the one anybody would actually share.
 */
function viewFromHash(): View {
  const h = window.location.hash.replace(/^#\/?/, '');
  if (h === 'responder' || h === 'app') return 'responder';
  if (h === 'report' || h === 'reporter') return 'reporter';
  return 'landing';
}

function Root() {
  const [view, setView] = useState<View>(viewFromHash);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (next: View) => {
    window.location.hash = next === 'landing' ? '' : next === 'responder' ? '/responder' : '/report';
    setView(next);
  };

  // Follow the system theme on the public pages, which are read in daylight as
  // often as not. The console keeps whatever the operator chose.
  useEffect(() => {
    if (view === 'responder') return;
    const stored = (() => {
      try {
        return localStorage.getItem('tornadosight.theme');
      } catch {
        return null;
      }
    })();
    document.documentElement.dataset.theme =
      stored === 'light' || stored === 'dark'
        ? stored
        : matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark';
  }, [view]);

  if (view === 'responder') return <App onExit={() => go('landing')} />;
  if (view === 'reporter') return <ReporterPage onBack={() => go('landing')} />;
  return <Landing onChoose={(role) => go(role === 'responder' ? 'responder' : 'reporter')} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('The root element is missing from the page.');

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
