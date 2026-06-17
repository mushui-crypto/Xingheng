import { Navigate, Route, Routes } from "react-router-dom";
import { AdminLayout } from "./components/layouts/AdminLayout";
import { UserLayout } from "./components/layouts/UserLayout";
import { ProtectedRoute } from "./components/ProtectedRoute";
import { AccountPage } from "./pages/app/AccountPage";
import { DashboardPage } from "./pages/app/DashboardPage";
import { MarketsPage } from "./pages/app/MarketsPage";
import { TradingPage } from "./pages/trading/TradingPage";
import { AdminDashboardPage } from "./pages/admin/AdminDashboardPage";
import { AdminLoginPage } from "./pages/admin/AdminLoginPage";
import { AdminSettingsPage } from "./pages/admin/AdminSettingsPage";
import { AdminSymbolsPage } from "./pages/admin/AdminSymbolsPage";
import { AdminTradingPage } from "./pages/admin/AdminTradingPage";
import { AdminUsersPage } from "./pages/admin/AdminUsersPage";
import { AuthPage } from "./pages/auth/AuthPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<AuthPage />} />
      <Route path="/register" element={<AuthPage />} />
      <Route path="/app/dashboard" element={<UserScreen><DashboardPage /></UserScreen>} />
      <Route path="/app/markets" element={<UserScreen><MarketsPage /></UserScreen>} />
      <Route path="/app/trading" element={<UserScreen><TradingPage /></UserScreen>} />
      <Route path="/app/account" element={<UserScreen><AccountPage /></UserScreen>} />
      <Route path="/admin/login" element={<AdminLoginPage />} />
      <Route path="/admin/dashboard" element={<AdminScreen><AdminDashboardPage /></AdminScreen>} />
      <Route path="/admin/users" element={<AdminScreen><AdminUsersPage /></AdminScreen>} />
      <Route path="/admin/symbols" element={<AdminScreen><AdminSymbolsPage /></AdminScreen>} />
      <Route path="/admin/trading" element={<AdminScreen><AdminTradingPage /></AdminScreen>} />
      <Route path="/admin/settings" element={<AdminScreen><AdminSettingsPage /></AdminScreen>} />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

function UserScreen({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute type="user">
      <UserLayout>{children}</UserLayout>
    </ProtectedRoute>
  );
}

function AdminScreen({ children }: { children: React.ReactNode }) {
  return (
    <ProtectedRoute type="admin">
      <AdminLayout>{children}</AdminLayout>
    </ProtectedRoute>
  );
}
