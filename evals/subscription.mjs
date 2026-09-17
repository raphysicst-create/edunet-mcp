// The legacy inherited-config runner is disabled. Inspect a fresh environment first.
import { main } from './subscription-isolation.mjs';
main().catch(() => { console.error('Subscription preflight failed; no model evaluation started.'); process.exitCode = 1; });
