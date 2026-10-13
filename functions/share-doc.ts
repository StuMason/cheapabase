// POST /functions/v1/share-doc  { doc_id, email }
// Shares a doc with another user. Needs the admin connection to look up users by email,
// so it checks ownership itself first.
import type { Handler } from "../server/functions";

const handler: Handler = async (req, { user, asUser, admin }) => {
  if (!user) return Response.json({ error: "sign in first" }, { status: 401 });
  const { doc_id, email } = await req.json().catch(() => ({}));
  if (!doc_id || !email) return Response.json({ error: "doc_id and email are required" }, { status: 400 });

  // RLS check as the caller: can they see this doc, and do they own it?
  const [doc] = await asUser((sql) => sql`select owner_id from docs where id = ${doc_id}`);
  if (!doc || doc.owner_id !== user.sub) return Response.json({ error: "only the owner can share" }, { status: 403 });

  const [target] = await admin`select id, email from auth.users where lower(email) = lower(${email})`;
  if (!target) return Response.json({ error: `no user with email ${email}, ask them to sign up first` }, { status: 404 });
  if (target.id === user.sub) return Response.json({ error: "you already own this doc" }, { status: 400 });

  const [member] = await admin`
    insert into doc_members (doc_id, user_id, email) values (${doc_id}, ${target.id}, ${target.email})
    on conflict (doc_id, user_id) do update set email = excluded.email
    returning *`;
  return Response.json(member);
};

export default handler;
