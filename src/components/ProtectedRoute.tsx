import { useEffect, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAdminAuthStore } from "../store/adminAuthStore";
import { useAuthStore } from "../store/authStore";
import { useUserStore } from "../store/userStore";

type ProtectedRouteProps = {
  children: ReactNode;
  type: "user" | "admin";
};

export function ProtectedRoute({ children, type }: ProtectedRouteProps) {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const isSessionReady = useAuthStore((state) => state.isSessionReady);
  const syncSession = useAuthStore((state) => state.syncSession);
  const isAdminLoggedIn = useAdminAuthStore((state) => state.isAdminLoggedIn);
  const currentUser = useUserStore((state) => state.currentUser);

  useEffect(() => {
    if (type === "user" && isLoggedIn && (!isSessionReady || !currentUser)) {
      void syncSession();
    }
  }, [currentUser, isLoggedIn, isSessionReady, syncSession, type]);

  if (type === "admin" && !isAdminLoggedIn) {
    return <Navigate to="/admin/login" replace />;
  }

  if (type === "user" && isLoggedIn && (!isSessionReady || !currentUser)) {
    return <ProtectedRouteFallback />;
  }

  if (type === "user" && !isLoggedIn) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function ProtectedRouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black text-sm tracking-[0.18em] text-white/60">
      LOADING
    </div>
  );
}
