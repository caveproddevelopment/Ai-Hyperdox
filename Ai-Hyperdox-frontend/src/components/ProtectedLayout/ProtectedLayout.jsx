// src/components/ProtectedLayout/ProtectedLayout.jsx
import { Outlet, Navigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { useIdleLogout } from "../../hooks/useIdleLogout";
import IdleWarningModal from "../IdleWarningModal/IdleWarningModal";

export default function ProtectedLayout() {
  const { currentUser } = useAuth();
  const { showWarning, stayActive, logoutNow } = useIdleLogout();

  // Not signed in → bounce to sign-in immediately
  if (!currentUser) {
    return <Navigate to="/signin" replace />;
  }

  return (
    <>
      <Outlet />
      <IdleWarningModal
        open={showWarning}
        onStayActive={stayActive}
        onLogoutNow={logoutNow}
      />
    </>
  );
}