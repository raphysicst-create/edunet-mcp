// Legacy inherited-config probe is disabled; inspect a fresh environment instead.
import { main } from './subscription-isolation.mjs';
main().catch(() => { console.error('Subscription preflight failed; no model evaluation started.'); process.exitCode = 1; });
