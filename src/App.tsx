import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AdminLayout } from "./components/layouts/AdminLayout";
import { UserLayout } from "./components/layouts/UserLayout";
import { ProtectedRoute } from "./components/ProtectedRoute";

const AuthPage = lazy(() => import("./pages/auth/AuthPage").then((module) => ({ default: module.AuthPage })));
const DashboardPage = lazy(() => import("./pages/app/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const MarketsPage = lazy(() => import("./pages/app/MarketsPage").then((module) => ({ default: module.MarketsPage })));
const TradingPage = lazy(() => import("./pages/trading/TradingPage").then((module) => ({ default: module.TradingPage })));
const RealTradePage = lazy(() => import("./pages/trading/RealTradePage").then((module) => ({ default: module.RealTradePage })));
const AccountPage = lazy(() => import("./pages/app/AccountPage").then((module) => ({ default: module.AccountPage })));
const AdminLoginPage = lazy(() => import("./pages/admin/AdminLoginPage").then((module) => ({ default: module.AdminLoginPage })));
const AdminDashboardPage = lazy(() => import("./pages/admin/AdminDashboardPage").then((module) => ({ default: module.AdminDashboardPage })));
const AdminUsersPage = lazy(() => import("./pages/admin/AdminUsersPage").then((module) => ({ default: module.AdminUsersPage })));
const AdminSymbolsPage = lazy(() => import("./pages/admin/AdminSymbolsPage").then((module) => ({ default: module.AdminSymbolsPage })));
const AdminTradingPage = lazy(() => import("./pages/admin/AdminTradingPage").then((module) => ({ default: module.AdminTradingPage })));

export default function App() {
  return (
    <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<Navigate to="/login" replace />} />
        <Route path="/login" element={<AuthPage />} />
        <Route path="/register" element={<AuthPage />} />
        <Route path="/forgot-password" element={<AuthPage />} />
        <Route path="/reset-password" element={<AuthPage />} />
        <Route path="/app/dashboard" element={<UserScreen><DashboardPage /></UserScreen>} />
        <Route path="/app/markets" element={<UserScreen><MarketsPage /></UserScreen>} />
        <Route path="/app/trade" element={<UserScreen><RealTradePage /></UserScreen>} />
        <Route path="/app/demo" element={<UserScreen><TradingPage /></UserScreen>} />
        <Route path="/app/trading" element={<DemoRedirect />} />
        <Route path="/app/account" element={<UserScreen><AccountPage /></UserScreen>} />
        <Route path="/admin/login" element={<AdminLoginPage />} />
        <Route path="/admin/dashboard" element={<AdminScreen><AdminDashboardPage /></AdminScreen>} />
        <Route path="/admin/users" element={<AdminScreen><AdminUsersPage /></AdminScreen>} />
        <Route path="/admin/symbols" element={<AdminScreen><AdminSymbolsPage /></AdminScreen>} />
        <Route path="/admin/trading" element={<AdminScreen><AdminTradingPage /></AdminScreen>} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </Suspense>
  );
}

function DemoRedirect() {
  const location = useLocation();
  return <Navigate to={`/app/demo${location.search}`} replace />;
}

function UserScreen({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute type="user">
      <UserLayout>{children}</UserLayout>
    </ProtectedRoute>
  );
}

function AdminScreen({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute type="admin">
      <AdminLayout>{children}</AdminLayout>
    </ProtectedRoute>
  );
}

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-black text-sm tracking-[0.18em] text-white/60">
      LOADING
    </div>
  );
}
