// Vercel Node entry point; the same server factory powers local stdio and HTTP.
export { handleRemoteRequest as default } from '../dist/remote-http.js';
