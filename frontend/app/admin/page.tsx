"use client";

// Admin dashboard — unlisted like /minigame (reachable by link only). The static
// route wins over the [[...slug]] catch-all; the backend rejects non-admins.

import { AdminDashboard } from "@/components/AdminDashboard";

export default function AdminPage() {
  return <AdminDashboard />;
}
