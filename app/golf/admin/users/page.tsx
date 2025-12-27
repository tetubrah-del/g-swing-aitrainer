import { redirect } from "next/navigation";

export const runtime = "nodejs";

export default function GolfAdminUsersAlias() {
  redirect("/admin/user");
}

