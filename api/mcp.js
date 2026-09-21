import { createHttpHandler } from "../dist/remote.js";

const handler = createHttpHandler();
export default { fetch: handler.fetch };
