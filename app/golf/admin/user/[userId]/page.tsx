import { redirect } from "next/navigation";

export const runtime = "nodejs";

export default async function GolfAdminUserIdAlias(props: { params: Promise<{ userId: string }> }) {
  const { userId } = await props.params;
  redirect(`/admin/user/${encodeURIComponent(userId)}`);
}

