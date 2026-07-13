import { createRoot } from 'react-dom/client';

import App from '@/App';
import { AuthProvider } from '@/hooks/AuthContext';
import { bootstrapAuth } from '@/services/bootstrap';

import './main.css';

// After MSAL's sign-in popup authenticates, it lands back on this app's origin with the auth response
// in the URL (…/#code=… or …/?code=…). If we boot the SPA here, BrowserRouter immediately <Navigate>s
// and rewrites that URL — destroying the response and stranding the opener (→ block_nested_popups, the
// "app reloads inside the popup" bug). The presence of an auth response IS the signal that we are the
// sign-in popup (a normal app load never has code=/error= in its URL), so gate on that alone — do NOT
// also require window.opener, which the Fabric portal's sandboxed iframe severs in the popup. We just
// render a tiny note and leave the URL untouched; the opener reads the token and closes this popup.
const isAuthCallback = /[?#&](code|error|error_description)=/.test(
  window.location.hash + window.location.search
);

if (isAuthCallback) {
  document.getElementById('root')!.innerHTML =
    '<div style="font-family:Segoe UI,system-ui,sans-serif;display:flex;height:100vh;align-items:center;' +
    'justify-content:center;color:#5c6b78;font-size:14px">Completing sign-in…</div>';
} else {
  const authService = bootstrapAuth();

  createRoot(document.getElementById('root')!).render(
    <AuthProvider authService={authService}>
      <App />
    </AuthProvider>
  );
}

