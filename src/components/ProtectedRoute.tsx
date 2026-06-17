import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAdminAuthStore } from "../store/adminAuthStore";
import { useAuthStore } from "../store/authStore";

type ProtectedRouteProps = {
  children: ReactNode;
  type: "user" | "admin";
};

export function ProtectedRoute({ children, type }: ProtectedRouteProps) {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const isAdminLoggedIn = useAdminAuthStore((state) => state.isAdminLoggedIn);

  if (type === "admin" && !isAdminLoggedIn) {
    return <Navigate to="/admin/login" replace />;
  }

  if (type === "user" && !isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
