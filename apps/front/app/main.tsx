import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { getEnv } from './env.js';
import './styles.css';

const env = getEnv();

document.documentElement.dataset.authMode = env.authMode;
document.documentElement.dataset.snapshotUrl = env.snapshotUrl;
document.documentElement.dataset.phase3EffectsEnabled = String(env.phase3EffectsEnabled ?? false);
document.documentElement.dataset.phase3EffectRainEnabled = String(env.phase3EnvironmentEffects?.rain ?? false);
document.documentElement.dataset.phase3EffectSnowEnabled = String(env.phase3EnvironmentEffects?.snow ?? false);
document.documentElement.dataset.phase3EffectFogEnabled = String(env.phase3EnvironmentEffects?.fog ?? false);
document.documentElement.dataset.phase3EffectDayNightEnabled = String(env.phase3EnvironmentEffects?.dayNight ?? false);

const container = document.getElementById('root');

if (!container) {
  throw new Error('Missing #root mount point for spectator UI');
}

createRoot(container).render(
  <StrictMode>
    <App env={env} />
  </StrictMode>,
);
