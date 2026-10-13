// GET /functions/v1/hello  - the smallest possible function.
import type { Handler } from "../server/functions";

const handler: Handler = async (req, { user }) => {
  return Response.json({ message: `hello ${user?.email ?? "anonymous"}`, at: new Date().toISOString() });
};

export default handler;
