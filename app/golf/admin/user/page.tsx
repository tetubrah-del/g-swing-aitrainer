import { redirect } from "next/navigation";

export const runtime = "nodejs";

export default function GolfAdminUserAlias() {
  redirect("/admin/user");
}

