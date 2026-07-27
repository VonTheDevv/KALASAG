import React from 'react'
import ReactDOM from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom'
import { AuthProvider } from './hooks/useAuth'
import { ThemeProvider } from './hooks/ThemeProvider'
import App from './App.tsx'
import Home from './pages/Home.tsx'
import Features from './pages/Features.tsx'
import About from './pages/About.tsx'
import Downloads from './pages/Downloads.tsx'
import Blog from './pages/Blog.tsx'
import Login from './components/Login.tsx'
import SignUp from './components/SignUp.tsx'
import ForgotPassword from './components/ForgotPassword.tsx'
import VerifyOTP from './components/VerifyOTP.tsx'
import AuthConfirm from './components/AuthConfirm.tsx'
import ProtectedRoute from './components/ProtectedRoute.tsx'
import NativeEntry from './components/NativeEntry.tsx'
import NativeLocationOnboarding from './components/NativeLocationOnboarding.tsx'
import './index.css'

const isNativeApp = Capacitor.isNativePlatform()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <BrowserRouter>
        <AuthProvider>
          {isNativeApp && <NativeLocationOnboarding />}
          <Routes>
            {isNativeApp ? (
              <Route path="/" element={<NativeEntry />} />
            ) : (
              <>
                <Route path="/" element={<Home />} />
                <Route path="/features" element={<Features />} />
                <Route path="/about" element={<About />} />
                <Route path="/downloads" element={<Downloads />} />
                <Route path="/blog" element={<Blog />} />
              </>
            )}
            <Route path="/login" element={<Login />} />
            <Route path="/signup" element={<SignUp />} />
            <Route path="/forgot-password" element={<ForgotPassword />} />
            <Route path="/reset-password" element={<VerifyOTP />} />
            <Route path="/verify-otp" element={<VerifyOTP />} />
            <Route path="/auth/confirm" element={<AuthConfirm />} />
            <Route
              path="/app/*"
              element={
                <ProtectedRoute>
                  <App />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
)
