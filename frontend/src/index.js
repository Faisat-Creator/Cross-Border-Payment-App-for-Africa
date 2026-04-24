import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import './i18n';
import App from './App';
import { register as registerSW } from './serviceWorker';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);

// Register the service worker for offline support.
// Only activates in production builds (see serviceWorker.js).
registerSW();
