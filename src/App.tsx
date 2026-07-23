import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { AdminLayout } from "./components/layouts/AdminLayout";
import { UserLayout } from "./components/layouts/UserLayout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { HyperliquidSessionProvider } from "./features/realTrading/components/HyperliquidSessionProvider";
import { useAuthStore } from "./store/authStore";
import { useUserStore } from "./store/userStore";

const AuthPage = lazy(() => import("./pages/auth/AuthPage").then((module) => ({ default: module.AuthPage })));
const DashboardPage = lazy(() => import("./pages/app/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const MarketsPage = lazy(() => import("./pages/app/MarketsPage").then((module) => ({ default: module.MarketsPage })));
const StrategyPage = lazy(() => import("./pages/app/StrategyPage").then((module) => ({ default: module.StrategyPage })));
const TradingPage = lazy(() => import("./pages/trading/TradingPage").then((module) => ({ default: module.TradingPage })));
const RealTradePage = lazy(() => import("./pages/trading/RealTradePage").then((module) => ({ default: module.RealTradePage })));
const AccountPage = lazy(() => import("./pages/app/AccountPage").then((module) => ({ default: module.AccountPage })));
const ArbitragePage = lazy(() => import("./pages/app/ArbitragePage").then((module) => ({ default: module.ArbitragePage })));
const AdminLoginPage = lazy(() => import("./pages/admin/AdminLoginPage").then((module) => ({ default: module.AdminLoginPage })));
const AdminDashboardPage = lazy(() => import("./pages/admin/AdminDashboardPage").then((module) => ({ default: module.AdminDashboardPage })));
const AdminUsersPage = lazy(() => import("./pages/admin/AdminUsersPage").then((module) => ({ default: module.AdminUsersPage })));
const AdminSymbolsPage = lazy(() => import("./pages/admin/AdminSymbolsPage").then((module) => ({ default: module.AdminSymbolsPage })));
const AdminTradingPage = lazy(() => import("./pages/admin/AdminTradingPage").then((module) => ({ default: module.AdminTradingPage })));
const AdminRealTradingOperationsPage = lazy(() => import("./pages/admin/AdminRealTradingOperationsPage").then((module) => ({ default: module.AdminRealTradingOperationsPage })));
const ArbitrageAutomationPage = lazy(() => import("./pages/app/ArbitrageAutomationPage").then((module) => ({ default: module.ArbitrageAutomationPage })));
const AdminNeutralAutomationPage = lazy(() => import("./pages/admin/AdminNeutralAutomationPage").then((module) => ({ default: module.AdminNeutralAutomationPage })));

export default function App() {
  return (
    <HyperliquidSessionProvider>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Navigate to="/app/dashboard" replace />} />
          <Route path="/login" element={<AuthPage />} />
          <Route path="/register" element={<AuthPage />} />
          <Route path="/forgot-password" element={<AuthPage />} />
          <Route path="/reset-password" element={<AuthPage />} />
          <Route path="/app/dashboard" element={<UserScreen><DashboardPage /></UserScreen>} />
          <Route path="/app/markets" element={<UserScreen><MarketsPage /></UserScreen>} />
          <Route path="/app/arbitrage" element={<UserScreen><ArbitragePage /></UserScreen>} />
          <Route path="/app/my-arbitrage" element={<PrivateUserScreen><ArbitrageAutomationPage /></PrivateUserScreen>} />
          <Route path="/app/strategy" element={<UserScreen><StrategyPage /></UserScreen>} />
          <Route path="/app/trade" element={<UserScreen><RealTradePage /></UserScreen>} />
          <Route path="/app/demo" element={<UserScreen><TradingPage /></UserScreen>} />
          <Route path="/app/trading" element={<DemoRedirect />} />
          <Route path="/app/account" element={<UserScreen><AccountPage /></UserScreen>} />
          <Route path="/admin/login" element={<AdminLoginPage />} />
          <Route path="/admin/dashboard" element={<AdminScreen><AdminDashboardPage /></AdminScreen>} />
          <Route path="/admin/users" element={<AdminScreen><AdminUsersPage /></AdminScreen>} />
          <Route path="/admin/symbols" element={<AdminScreen><AdminSymbolsPage /></AdminScreen>} />
          <Route path="/admin/trading" element={<AdminScreen><AdminTradingPage /></AdminScreen>} />
          <Route path="/admin/real-trading" element={<AdminScreen><AdminRealTradingOperationsPage /></AdminScreen>} />
          <Route path="/admin/arbitrage-automation" element={<AdminScreen><AdminNeutralAutomationPage /></AdminScreen>} />
          <Route path="*" element={<Navigate to="/app/dashboard" replace />} />
        </Routes>
      </Suspense>
    </HyperliquidSessionProvider>
  );
}

function DemoRedirect() {
  const location = useLocation();
  return <Navigate to={`/app/demo${location.search}`} replace />;
}

function UserScreen({ children }: { children: ReactNode }) {
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn);
  const isSessionReady = useAuthStore((state) => state.isSessionReady);
  const syncSession = useAuthStore((state) => state.syncSession);
  const expireSession = useAuthStore((state) => state.expireSession);
  const currentUser = useUserStore((state) => state.currentUser);

  useEffect(() => {
    if (isLoggedIn && !isSessionReady) void syncSession();
  }, [isLoggedIn, isSessionReady, syncSession]);

  useEffect(() => {
    if (isLoggedIn && isSessionReady && !currentUser) expireSession();
  }, [currentUser, expireSession, isLoggedIn, isSessionReady]);

  if (isLoggedIn && !isSessionReady) return <RouteFallback />;

  return (
    <UserLayout>{children}</UserLayout>
  );
}

function AdminScreen({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute type="admin">
      <AdminLayout>{children}</AdminLayout>
    </ProtectedRoute>
  );
}

function PrivateUserScreen({ children }: { children: ReactNode }) {
  return (
    <ProtectedRoute type="user">
      <UserLayout>{children}</UserLayout>
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
