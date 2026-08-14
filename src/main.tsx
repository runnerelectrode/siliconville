import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import 'react-toastify/dist/ReactToastify.css';
import ConvexClientProvider from './components/ConvexClientProvider.tsx';
import { GoogleAuthProvider } from './auth/google.tsx';
import SiliconvilleViewer from './siliconville/SiliconvilleViewer.tsx';
import Siliconville3D from './siliconville/Siliconville3D.tsx';
import SiliconvilleShell from './siliconville/SiliconvilleShell.tsx';

// Path matching IS the routing layer — one page and two debug views do not
// justify a router. vercel.json, and public/_redirects on Cloudflare, rewrite
// every path to index.html so deep links reach this file.
const path = window.location.pathname.replace(/\/+$/, '');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConvexClientProvider>
      <GoogleAuthProvider>
        {path === '/full' ? (
          // The 3D city with no page chrome, for looking at the renderer.
          <Siliconville3D />
        ) : path === '/2d' ? (
          // The tile view the collision map is authored against.
          <SiliconvilleViewer />
        ) : (
          <SiliconvilleShell />
        )}
      </GoogleAuthProvider>
    </ConvexClientProvider>
  </React.StrictMode>,
);
