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
  const expireSession = useAuthStore((state) => state.expireSession);
  const isAdminLoggedIn = useAdminAuthStore((state) => state.isAdminLoggedIn);
  const currentUser = useUserStore((state) => state.currentUser);

  useEffect(() => {
    if (type === "user" && isLoggedIn && !isSessionReady) {
      void syncSession();
    }
  }, [isLoggedIn, isSessionReady, syncSession, type]);

  useEffect(() => {
    if (type === "user" && isLoggedIn && isSessionReady && !currentUser) {
      expireSession();
    }
  }, [currentUser, expireSession, isLoggedIn, isSessionReady, type]);

  if (type === "admin" && !isAdminLoggedIn) {
    return <Navigate to="/admin/login" replace />;
  }

  if (type === "user" && isLoggedIn && !isSessionReady) {
    return <ProtectedRouteFallback />;
  }

  if (type === "user" && (!isLoggedIn || !currentUser)) {
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
