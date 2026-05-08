// src/App.jsx
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import Home from "./pages/Home/Home";
import SignUp from './pages/SignUp/SignUp';
import SignIn from './pages/SignIn/SignIn';
import ConfirmRegistration from './pages/ConfirmRegistration/ConfirmRegistration';
import ForgotPassword from './pages/ForgotPassword/ForgotPassword';
import ResetPassword from './pages/resetpassword/ResetPassword';
import ContactUs from './pages/ContactUs/ContactUs';
import AboutUs from './pages/AboutUs/AboutUs';
import Dashboard from './pages/Dashboard/Dashboard';
import Profile from './pages/Profile/Profile';
import NewProject from './pages/NewProject/NewProject';
import "./App.css";
import EditProject from "./pages/EditProject/EditProject";

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
      <Routes>
        <Route path="/"                     element={<Home />} />
        <Route path="/signup"               element={<SignUp />} />
        <Route path="/confirm-registration" element={<ConfirmRegistration />} />
        <Route path="/signin"               element={<SignIn />} />
        <Route path="/forgot-password"      element={<ForgotPassword />} />
        <Route path="/reset-password"       element={<ResetPassword />} />
        <Route path="/contact"              element={<ContactUs />} />
        <Route path="/about"               element={<AboutUs />} />
        <Route path="/dashboard"            element={<Dashboard />} />
        <Route path="/profile"              element={<Profile />} />
        <Route path="/project/new"          element={<NewProject />} />
        <Route path="/project/:projectId/edit" element={<EditProject />} />
      </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}