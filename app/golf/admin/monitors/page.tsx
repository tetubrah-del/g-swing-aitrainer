import { redirect } from "next/navigation";

export const runtime = "nodejs";

export default function GolfAdminMonitorsAlias() {
  redirect("/admin/monitors");
}

